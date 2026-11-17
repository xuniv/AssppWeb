// Streaming adapter for pinned UnfairPlay. Cryptographic parsers and validation
// remain upstream; host files are supplied through private random-access storage.
package fairplay

import (
	"archive/zip"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"crypto/sha1"
	"crypto/sha256"
	"crypto/sha512"
	"encoding/binary"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"hash"
	"io"
	"strings"
	"sync"
)

const streamMetadataLimit = 16 << 20

// StreamFile is private temporary storage, never an HTTP or public asset cache.
type StreamFile interface {
	io.ReaderAt
	io.WriterAt
	io.Writer
	Truncate(int64) error
	Close() error
}
type StreamOptions struct {
	Models           [][]byte
	StripAccountData bool
	MaxMemberBytes   int64
	Scratch          func(int64) (StreamFile, error)
}
type streamArchive struct{ *zip.Reader }

func (*streamArchive) Close() error { return nil }

type streamInventory struct {
	ipaInventory
	staged map[string]StreamFile
}

func (s *streamInventory) close() {
	for _, f := range s.staged {
		_ = f.Close()
	}
	clear(s.staged)
}
func streamRead(r io.ReaderAt, at, n int64) ([]byte, error) {
	if n < 0 || n > streamMetadataLimit {
		return nil, fmt.Errorf("metadata extent exceeds streaming limit")
	}
	b := make([]byte, int(n))
	_, err := r.ReadAt(b, at)
	return b, err
}

var streamBuffers = sync.Pool{New: func() any { return make([]byte, 65536) }}

func streamHash(r io.ReaderAt, at, n int64, h hash.Hash) ([]byte, error) {
	if at < 0 || n < 0 {
		return nil, fmt.Errorf("invalid stream hash extent")
	}
	buffer := streamBuffers.Get().([]byte)
	defer streamBuffers.Put(buffer)
	count, err := io.CopyBuffer(h, io.NewSectionReader(r, at, n), buffer)
	if err == nil && count != n {
		err = io.ErrUnexpectedEOF
	}
	return h.Sum(nil), err
}
func hashStreamCodePage(kind byte, r io.ReaderAt, at, n int64) ([]byte, error) {
	var h hash.Hash
	switch kind {
	case 1:
		h = sha1.New()
	case 2, 3:
		h = sha256.New()
	case 4:
		h = sha512.New384()
	default:
		return nil, fmt.Errorf("unsupported CodeDirectory hash type %d", kind)
	}
	return streamHash(r, at, n, h)
}
func streamStage(file *zip.File, o StreamOptions) (StreamFile, error) {
	if o.Scratch == nil {
		return nil, fmt.Errorf("private scratch storage is required")
	}
	if file.UncompressedSize64 > uint64(o.MaxMemberBytes) {
		return nil, fmt.Errorf("Mach-O member exceeds streaming limit")
	}
	f, err := o.Scratch(int64(file.UncompressedSize64))
	if err != nil {
		return nil, err
	}
	reader, err := file.Open()
	if err == nil {
		defer reader.Close()
		var n int64
		n, err = io.CopyBuffer(f, io.LimitReader(reader, int64(file.UncompressedSize64)+1), make([]byte, 65536))
		if err == nil && n != int64(file.UncompressedSize64) {
			err = fmt.Errorf("Mach-O size changed")
		}
	}
	if err != nil {
		f.Close()
		return nil, err
	}
	return f, nil
}
func streamThin(r io.ReaderAt, size uint64) (machoLayout, error) {
	header, err := streamRead(r, 0, int64(min(size, 32)))
	if err != nil {
		return machoLayout{}, err
	}
	if len(header) < 28 {
		return machoLayout{}, fmt.Errorf("Mach-O header is truncated")
	}
	headerBytes := 28
	if binary.LittleEndian.Uint32(header[:4]) == mhMagic64 {
		headerBytes = 32
	}
	n := uint64(headerBytes) + uint64(binary.LittleEndian.Uint32(header[20:24]))
	if n > 1<<20 || n > size {
		return machoLayout{}, fmt.Errorf("Mach-O load-command extent is invalid")
	}
	probe, err := streamRead(r, 0, int64(n))
	if err != nil {
		return machoLayout{}, err
	}
	return parseThinMachO(probe, size)
}

func parseStreamMachOSlices(reader io.ReaderAt, totalSize uint64) ([]machoSlice, error) {
	blob, readErr := streamRead(reader, 0, int64(min(totalSize, 8+32*32)))
	if readErr != nil {
		return nil, readErr
	}
	if len(blob) < 4 {
		return nil, fmt.Errorf("Mach-O header is truncated")
	}
	switch binary.LittleEndian.Uint32(blob[:4]) {
	case mhMagic32, mhMagic64:
		layout, err := streamThin(reader, totalSize)
		if err != nil {
			return nil, err
		}
		return []machoSlice{{size: totalSize, layout: layout}}, nil
	case mhCigam32, mhCigam64:
		return nil, fmt.Errorf("big-endian thin Mach-O is unsupported")
	}
	if !isFatMachO(blob) {
		return nil, fmt.Errorf("expected Mach-O image")
	}
	magic := binary.BigEndian.Uint32(blob[:4])
	var order binary.ByteOrder = binary.BigEndian
	if magic == fatCigam || magic == fatCigam64 {
		order = binary.LittleEndian
	}
	is64 := magic == fatMagic64 || magic == fatCigam64
	entrySize := 20
	if is64 {
		entrySize = 32
	}
	if len(blob) < 8 {
		return nil, fmt.Errorf("universal Mach-O header is truncated")
	}
	count := int(order.Uint32(blob[4:8]))
	if count == 0 || count > 32 || count > (len(blob)-8)/entrySize {
		return nil, fmt.Errorf("universal Mach-O architecture count is invalid")
	}
	tableEnd := uint64(8 + count*entrySize)
	slices := make([]machoSlice, 0, count)
	for index := 0; index < count; index++ {
		entry := blob[8+index*entrySize : 8+(index+1)*entrySize]
		cpuType, cpuSubtype := order.Uint32(entry[:4]), order.Uint32(entry[4:8])
		var offset, size uint64
		if is64 {
			offset, size = order.Uint64(entry[8:16]), order.Uint64(entry[16:24])
		} else {
			offset, size = uint64(order.Uint32(entry[8:12])), uint64(order.Uint32(entry[12:16]))
		}
		alignOffset := 16
		if is64 {
			alignOffset = 24
		}
		align := order.Uint32(entry[alignOffset : alignOffset+4])
		if size == 0 || offset < tableEnd || offset > totalSize || size > totalSize-offset {
			return nil, fmt.Errorf("universal Mach-O architecture %d has invalid bounds", index)
		}
		if align > 63 || offset&((uint64(1)<<align)-1) != 0 {
			return nil, fmt.Errorf("universal Mach-O architecture %d is misaligned", index)
		}
		for _, previous := range slices {
			if offset < previous.offset+previous.size && previous.offset < offset+size {
				return nil, fmt.Errorf("universal Mach-O architectures overlap")
			}
		}
		layout, err := streamThin(io.NewSectionReader(reader, int64(offset), int64(size)), size)
		if err != nil {
			return nil, fmt.Errorf("universal Mach-O architecture %d: %w", index, err)
		}
		if layout.cpuType != cpuType || layout.cpuSubtype != cpuSubtype {
			return nil, fmt.Errorf("universal Mach-O architecture %d does not match its slice", index)
		}
		slices = append(slices, machoSlice{offset: offset, size: size, layout: layout})
	}
	return slices, nil
}

func auditStreamCodeDirectories(executable io.ReaderAt, size int64, layout machoLayout, preEncryption bool) ([]codeDirectoryAudit, error) {
	signatureEnd := uint64(layout.signatureOffset) + uint64(layout.signatureSize)
	cryptEnd := uint64(layout.cryptOffset) + uint64(layout.cryptSize)
	if signatureEnd > uint64(size) || cryptEnd > uint64(size) || layout.cryptSize == 0 {
		return nil, fmt.Errorf("invalid Mach-O audit ranges")
	}
	sig, readErr := streamRead(executable, int64(layout.signatureOffset), int64(layout.signatureSize))
	if readErr != nil {
		return nil, readErr
	}
	if len(sig) < 12 || binary.BigEndian.Uint32(sig[:4]) != csMagicEmbeddedSignature {
		return nil, fmt.Errorf("invalid embedded signature")
	}
	total, count := int(binary.BigEndian.Uint32(sig[4:8])), int(binary.BigEndian.Uint32(sig[8:12]))
	if total > len(sig) || 12+count*8 > total {
		return nil, fmt.Errorf("invalid embedded signature geometry")
	}
	reports := make([]codeDirectoryAudit, 0)
	directories := 0
	for i := 0; i < count; i++ {
		offset := int(binary.BigEndian.Uint32(sig[16+i*8 : 20+i*8]))
		if offset+8 > total {
			return nil, fmt.Errorf("signature item exceeds superblob")
		}
		magic, length := binary.BigEndian.Uint32(sig[offset:offset+4]), int(binary.BigEndian.Uint32(sig[offset+4:offset+8]))
		if length < 8 || offset+length > total {
			return nil, fmt.Errorf("signature item has invalid length")
		}
		if magic != csMagicCodeDirectory {
			continue
		}
		directories++
		dir := sig[offset : offset+length]
		if len(dir) < 44 {
			return nil, fmt.Errorf("CodeDirectory is truncated")
		}
		version := binary.BigEndian.Uint32(dir[8:12])
		headerSize := 44
		if version >= 0x20100 {
			headerSize = 48
			if len(dir) < headerSize || binary.BigEndian.Uint32(dir[44:48]) != 0 {
				return nil, fmt.Errorf("truncated or unsupported scattered CodeDirectory")
			}
		}
		if version >= 0x20200 {
			headerSize = 52
		}
		if version >= 0x20300 {
			headerSize = 64
		}
		if version >= 0x20400 {
			headerSize = 88
		}
		if version >= 0x20500 {
			headerSize = 96
		}
		if version >= 0x20600 {
			headerSize = 108
		}
		if len(dir) < headerSize {
			return nil, fmt.Errorf("extended CodeDirectory is truncated")
		}
		codeLimit := uint64(binary.BigEndian.Uint32(dir[32:36]))
		if version >= 0x20300 {
			if codeLimit == 0 {
				codeLimit = binary.BigEndian.Uint64(dir[56:64])
			}
		}
		hashOffset := uint64(binary.BigEndian.Uint32(dir[16:20]))
		codeSlots := uint64(binary.BigEndian.Uint32(dir[28:32]))
		hashSize := int(dir[36])
		hashType := dir[37]
		shift := dir[39]
		expectedSize := map[byte]int{1: 20, 2: 32, 3: 20, 4: 48}[hashType]
		if expectedSize == 0 || hashSize != expectedSize || shift > 30 {
			return nil, fmt.Errorf("CodeDirectory geometry is invalid")
		}
		if codeLimit < cryptEnd || codeLimit > uint64(size) {
			return nil, fmt.Errorf("CodeDirectory does not cover encrypted range")
		}
		pageSize := uint64(1) << shift
		if shift == 0 {
			pageSize = codeLimit // An unpaged CodeDirectory hashes the entire code region.
		}
		firstSlot := uint64(layout.cryptOffset) / pageSize
		lastSlot := (cryptEnd + pageSize - 1) / pageSize
		slots := lastSlot - firstSlot
		if codeSlots != (codeLimit+pageSize-1)/pageSize || lastSlot > codeSlots || hashOffset < uint64(headerSize) || hashOffset+codeSlots*uint64(hashSize) > uint64(len(dir)) {
			return nil, fmt.Errorf("CodeDirectory table is truncated")
		}
		if preEncryption {
			if version < 0x20500 {
				continue
			}
			preOffset := uint64(binary.BigEndian.Uint32(dir[92:96]))
			if preOffset == 0 {
				continue
			}
			if preOffset < uint64(headerSize) || preOffset > uint64(len(dir)) || codeSlots*uint64(hashSize) > uint64(len(dir))-preOffset {
				return nil, fmt.Errorf("CodeDirectory pre-encryption table is invalid or truncated")
			}
			hashOffset = preOffset
		}
		matched := 0
		for slot := firstSlot; slot < lastSlot; slot++ {
			start := slot * pageSize
			end := min(start+pageSize, codeLimit)
			actual, err := hashStreamCodePage(hashType, executable, int64(start), int64(end-start))
			if err != nil {
				return nil, err
			}
			expected := dir[hashOffset+slot*uint64(hashSize) : hashOffset+(slot+1)*uint64(hashSize)]
			if bytes.Equal(actual[:hashSize], expected) {
				matched++
			}
		}
		reports = append(reports, codeDirectoryAudit{hashType, hashSize, int(pageSize), int(firstSlot), int(slots), matched})
	}
	if directories == 0 {
		return nil, fmt.Errorf("embedded signature contains no CodeDirectory")
	}
	return reports, nil
}

func validateStreamSignature(table supf, r io.ReaderAt, size uint64, layout machoLayout) error {
	for _, a := range table.architectures {
		if a.cpuType == layout.cpuType && a.cpuSubtype == layout.cpuSubtype {
			if !a.HasSignatureSHA1 {
				return nil
			}
			at, n := uint64(layout.signatureOffset), uint64(layout.signatureSize)
			if n == 0 || at > size || n > size-at {
				return fmt.Errorf("SUPF signature binding has invalid signature extent")
			}
			h, err := streamHash(r, int64(at), int64(n), sha1.New())
			if err != nil {
				return err
			}
			if !bytes.Equal(h, a.SignatureSHA1[:]) {
				return fmt.Errorf("SUPF signature binding mismatch")
			}
			return nil
		}
	}
	return fmt.Errorf("SUPF signature binding has no matching architecture")
}
func validateStreamUniversal(table supf, r io.ReaderAt, size uint64, slices []machoSlice) error {
	if !table.HasUniversalSignatureSHA1 {
		return nil
	}
	h := sha1.New()
	for _, s := range slices {
		at, n := s.offset+uint64(s.layout.signatureOffset), uint64(s.layout.signatureSize)
		end := s.offset + s.size
		if n == 0 || at < s.offset || end < s.offset || at > size || n > size-at || at+n > end {
			return fmt.Errorf("SUPP universal signature binding has invalid slice extent")
		}
		if _, err := io.CopyBuffer(h, io.NewSectionReader(r, int64(at), int64(n)), make([]byte, 65536)); err != nil {
			return err
		}
	}
	if len(slices) == 0 || !bytes.Equal(h.Sum(nil), table.UniversalSignatureSHA1[:]) {
		return fmt.Errorf("SUPP universal signature binding mismatch")
	}
	return nil
}

func openStreamInventory(input io.ReaderAt, size int64, options StreamOptions) (streamInventory, *streamArchive, error) {
	var result streamInventory
	result.path = "input.ipa"
	result.bytes = size
	result.staged = map[string]StreamFile{}
	ready := false
	defer func() {
		if !ready {
			result.close()
		}
	}()
	h, err := streamHash(input, 0, size, sha256.New())
	if err != nil {
		return result, nil, err
	}
	result.sha256 = hex.EncodeToString(h)
	z, err := OpenPortableArchive(input, size)
	if err != nil {
		return result, nil, err
	}
	archive := &streamArchive{z}
	if err := PortableArchiveBounds(archive.Reader, options.MaxMemberBytes); err != nil {
		return result, nil, err
	}
	if len(archive.File) > 100000 {
		return result, nil, fmt.Errorf("IPA has too many members")
	}
	var metadataBytes uint64
	for _, f := range archive.File {
		if isLicenseMember(f.Name) || strings.HasSuffix(f.Name, ".sinf") || strings.HasSuffix(f.Name, ".supf") || strings.HasSuffix(f.Name, ".supp") {
			metadataBytes += f.UncompressedSize64
			if f.UncompressedSize64 > streamMetadataLimit || metadataBytes > 32<<20 {
				return result, nil, fmt.Errorf("IPA license metadata exceeds streaming limit")
			}
		}
	}
	result.supfTables = map[string]supf{}
	result.cachedFiles = map[string][]byte{}
	names := map[string]bool{}
	files := map[string]*zip.File{}
	for _, file := range archive.File {
		if previous, exists := files[file.Name]; exists {
			// Some App Store repacks repeat an empty directory marker. It has no
			// payload to choose between; duplicate files remain ambiguous.
			if strings.HasSuffix(file.Name, "/") && previous.FileInfo().IsDir() &&
				file.FileInfo().IsDir() && previous.UncompressedSize64 == 0 && file.UncompressedSize64 == 0 {
				continue
			}
			archive.Close()
			return result, nil, fmt.Errorf("duplicate IPA member %q", file.Name)
		}
		names[file.Name] = true
		files[file.Name] = file
		if strings.HasSuffix(file.Name, ".sinf") {
			result.sinfMembers = append(result.sinfMembers, file.Name)
		}
	}
	associations, err := buildSINFAssociations(files)
	if err != nil {
		archive.Close()
		return result, nil, err
	}
	for _, file := range archive.File {
		if file.FileInfo().IsDir() {
			continue
		}
		probeReader, err := file.Open()
		if err != nil {
			return result, nil, err
		}
		prefix, err := io.ReadAll(io.LimitReader(probeReader, 32))
		_ = probeReader.Close()
		if err != nil {
			return result, nil, err
		}
		var probe []byte
		var staged StreamFile
		if isFatMachO(prefix) {
			staged, err = streamStage(file, options)
			if err == nil {
				result.staged[file.Name] = staged
				probe = prefix
			}
		} else {
			probe, err = readMachOProbe(file)
		}
		if err != nil {
			archive.Close()
			return result, nil, fmt.Errorf("%s: %w", file.Name, err)
		}
		if len(probe) < 4 {
			continue
		}
		magic := binary.LittleEndian.Uint32(probe[:4])
		if magic != mhMagic32 && magic != mhMagic64 && !isFatMachO(probe) {
			if !isKnownUnsupportedMachO(probe) {
				continue
			}
			archive.Close()
			return result, nil, fmt.Errorf("%s: unsupported Mach-O format; cannot establish complete encryption inventory", file.Name)
		}
		var slices []machoSlice
		var parseErr error
		if staged != nil {
			slices, parseErr = parseStreamMachOSlices(staged, file.UncompressedSize64)
		} else {
			slices, parseErr = parseMachOSlices(probe, file.UncompressedSize64)
		}
		if parseErr != nil {
			archive.Close()
			return result, nil, fmt.Errorf("%s: %w", file.Name, parseErr)
		}
		var encrypted []machoSlice
		for _, slice := range slices {
			if slice.layout.cryptID != 0 {
				encrypted = append(encrypted, slice)
			}
		}
		if len(encrypted) == 0 {
			continue
		}
		if isFatMachO(probe) {
			// Fat members remain in private random-access scratch, not the Go heap.
		}
		supfMember, table, err := selectImageKeyTable(files, file.Name, slices)
		if err != nil {
			archive.Close()
			return result, nil, err
		}
		var bindingErr error
		if staged != nil {
			bindingErr = validateStreamUniversal(table, staged, file.UncompressedSize64, slices)
		} else {
			bindingErr = table.ValidateUniversalSignatureBinding(probe, slices)
		}
		if err := bindingErr; err != nil {
			archive.Close()
			return result, nil, fmt.Errorf("%s: %w", file.Name, err)
		}
		targetSINF := adjacentSINF(file.Name)
		sinfMember := associations[targetSINF]
		if sinfMember == "" && names[targetSINF] {
			sinfMember = targetSINF
		}
		if sinfMember == "" {
			archive.Close()
			return result, nil, fmt.Errorf("encrypted Mach-O %q has no declared or adjacent SINF", file.Name)
		}
		result.supfTables[supfMember] = table
		for _, slice := range encrypted {
			records, err := table.recordsFor(slice.layout.cpuType, slice.layout.cpuSubtype)
			if err != nil {
				archive.Close()
				return result, nil, fmt.Errorf("%s: %w", file.Name, err)
			}
			if len(records) != int(slice.layout.cryptSize)/pageBytes {
				archive.Close()
				return result, nil, fmt.Errorf("%s: SUPF page count mismatch for architecture %#x/%#x", file.Name, slice.layout.cpuType, slice.layout.cpuSubtype)
			}
			result.images = append(result.images, encryptedImage{
				member: file.Name, supfMember: supfMember, sinfMember: sinfMember,
				sliceOffset: slice.offset, sliceSize: slice.size, layout: slice.layout, supfTable: &table,
			})
		}
	}
	if len(result.images) == 0 {
		archive.Close()
		return result, nil, fmt.Errorf("IPA contains no supported encrypted Mach-O images")
	}
	ready = true
	return result, archive, nil
}

func resolveIPALicensesPacks(inventory ipaInventory, files map[string]*zip.File, packs [][]byte) (map[string]*ipaLicense, []licenseReport, error) {
	if len(packs) == 0 || len(packs) > 256 {
		return nil, nil, fmt.Errorf("one to 256 enrollment models are required")
	}
	resolve := func(sinf []byte) (KeyMaterial, error) {
		if len(packs) == 1 {
			return ResolveLogicalKeyWithModel(sinf, packs[0])
		}
		return ResolveLogicalKeyWithModels(sinf, packs)
	}

	licenses := make(map[string]*ipaLicense)
	var reports []licenseReport
	complete := false
	defer func() {
		if complete {
			return
		}
		for _, license := range licenses {
			clear(license.material.LogicalKey[:])
			clear(license.mask[:])
		}
	}()
	for _, image := range inventory.images {
		if _, ok := licenses[image.sinfMember]; ok {
			continue
		}
		file := files[image.sinfMember]
		if file == nil {
			return nil, nil, fmt.Errorf("missing inventoried SINF %q", image.sinfMember)
		}
		sinf, err := zipBytes(file)
		if err != nil {
			return nil, nil, err
		}
		material, err := resolve(sinf)
		sinfHash := digest(sinf)
		clear(sinf)
		if err != nil {
			return nil, nil, fmt.Errorf("SINF %q: %w", image.sinfMember, err)
		}
		if material.Evidence == nil {
			material.Evidence = make(map[string]any)
		}
		material.Evidence["request_ipa_sha256"] = inventory.sha256
		material.Evidence["request_sinf_sha256"] = sinfHash
		mask := appMaskFromLogicalKey(material.LogicalKey)
		licenses[image.sinfMember] = &ipaLicense{
			material: material, mask: mask, deriver: newPageKeyDeriver(mask),
		}
		provider, _ := material.Evidence["provider_kind"].(string)
		if provider == "" {
			provider = "unknown"
		}
		model, _ := material.Evidence["model_name"].(string)
		if model == "" {
			model = "unknown"
		}
		reports = append(reports, licenseReport{
			Member: image.sinfMember, Provider: provider, ModelBuild: model,
			LogicalKeySHA256: digest(material.LogicalKey[:]), Oracle: material.Evidence,
		})
	}
	complete = true
	return licenses, reports, nil
}

// A small read-through cache prevents one host filesystem call per hash slot.
// It is invalidated after mutations before auditing candidate plaintext.
type streamCachedReader struct {
	source io.ReaderAt
	size   int64
	data   [65536]byte
	start  int64
	valid  int
}

func (r *streamCachedReader) ReadAt(p []byte, at int64) (n int, err error) {
	if at < 0 {
		return 0, fmt.Errorf("invalid stream offset")
	}
	for len(p) > 0 {
		if at >= r.size {
			return n, io.EOF
		}
		if r.valid == 0 || at < r.start || at >= r.start+int64(r.valid) {
			r.start = at / 65536 * 65536
			count := int(min(int64(len(r.data)), r.size-r.start))
			r.valid, err = r.source.ReadAt(r.data[:count], r.start)
			if err != nil && err != io.EOF {
				return n, err
			}
			if r.valid != count {
				return n, io.ErrUnexpectedEOF
			}
		}
		count := min(len(p), r.valid-int(at-r.start))
		copy(p[:count], r.data[int(at-r.start):int(at-r.start)+count])
		p = p[count:]
		at += int64(count)
		n += count
	}
	return n, nil
}

func decryptStreamImage(storage StreamFile, image encryptedImage, records [][32]byte, mask [16]byte, deriver *pageKeyDeriver) (*imageReport, error) {
	output := &streamCachedReader{source: io.NewSectionReader(storage, int64(image.sliceOffset), int64(image.sliceSize)), size: int64(image.sliceSize)}
	size := int64(image.sliceSize)
	if image.layout.cryptID != 1 {
		return nil, fmt.Errorf("%s: expected cryptid 1", image.member)
	}
	start := int64(image.layout.cryptOffset)
	end := start + int64(image.layout.cryptSize)
	id := int64(image.layout.cryptIDOffset)
	if id < 0 || id+4 > start || start < 0 || end < start || end > size {
		return nil, fmt.Errorf("%s: invalid FairPlay mutation ranges", image.member)
	}
	encryptedDigest, err := streamHash(output, int64(0), int64(size), sha256.New())
	if err != nil {
		return nil, err
	}
	prefixDigest, err := streamHash(output, int64(0), int64(id), sha256.New())
	if err != nil {
		return nil, err
	}
	headerDigest, err := streamHash(output, int64(id+4), int64(start-id-4), sha256.New())
	if err != nil {
		return nil, err
	}
	suffixDigest, err := streamHash(output, int64(end), int64(size-end), sha256.New())
	if err != nil {
		return nil, err
	}
	if image.supfTable != nil {
		if err := validateStreamSignature(*image.supfTable, output, image.sliceSize, image.layout); err != nil {
			return nil, fmt.Errorf("%s: %w", image.member, err)
		}
	}
	audits, err := auditStreamCodeDirectories(output, int64(size), image.layout, false)
	if err != nil {
		return nil, err
	}
	for _, audit := range audits {
		if audit.MatchedSlots != audit.SlotCount {
			return nil, fmt.Errorf("%s: encrypted source fails CodeDirectory", image.member)
		}
	}
	keysHash := sha256.New()
	blockBytes := make([]byte, 65536)
	if len(records)*pageBytes != int(image.layout.cryptSize) {
		return nil, fmt.Errorf("encrypted page geometry changed")
	}
	for first := 0; first < len(records); first += 16 {
		count := min(16, len(records)-first)
		data := blockBytes[:count*pageBytes]
		at := start + int64(first)*pageBytes
		if _, err := output.ReadAt(data, at); err != nil {
			return nil, err
		}
		for i := 0; i < count; i++ {
			record := records[first+i]
			key := deriver.pageKey(record[:16], image.sliceOffset+uint64(at)+uint64(i*pageBytes))
			keysHash.Write(key[:])
			block, err := aes.NewCipher(key[:])
			clear(key[:])
			if err != nil {
				return nil, err
			}
			page := data[i*pageBytes : (i+1)*pageBytes]
			cipher.NewCBCDecrypter(block, record[16:]).CryptBlocks(page, page)
		}
		if _, err := storage.WriteAt(data, int64(image.sliceOffset)+at); err != nil {
			return nil, err
		}
	}
	clear(blockBytes)
	// Restore the unencrypted Mach-O header before checking any signature
	// page that may overlap both the header and encrypted region.
	if _, err := storage.WriteAt([]byte{0, 0, 0, 0}, int64(image.sliceOffset)+int64(id)); err != nil {
		return nil, err
	}
	output.valid = 0
	plaintextAudits, err := auditStreamCodeDirectories(output, int64(size), image.layout, true)
	if err != nil {
		return nil, fmt.Errorf("%s: validate plaintext hashes: %w", image.member, err)
	}
	for _, audit := range plaintextAudits {
		if audit.MatchedSlots != audit.SlotCount {
			return nil, fmt.Errorf("%s: plaintext page hash mismatch (%d/%d)", image.member, audit.MatchedSlots, audit.SlotCount)
		}
	}
	prefixAfter, e := streamHash(output, 0, int64(id), sha256.New())
	if e != nil {
		return nil, e
	}
	headerAfter, e := streamHash(output, int64(id+4), int64(start-id-4), sha256.New())
	if e != nil {
		return nil, e
	}
	suffixAfter, e := streamHash(output, int64(end), int64(size-end), sha256.New())
	if e != nil {
		return nil, e
	}
	if !bytes.Equal(prefixAfter, prefixDigest) || !bytes.Equal(headerAfter, headerDigest) || !bytes.Equal(suffixAfter, suffixDigest) {
		return nil, fmt.Errorf("mutation escaped FairPlay range")
	}
	validation := "code-directory-pre-encryption-hashes"
	if len(plaintextAudits) == 0 {
		validation = "unavailable-no-pre-encryption-hashes"
	}
	decryptedDigest, err := streamHash(output, 0, int64(size), sha256.New())
	if err != nil {
		return nil, err
	}
	firstPage, err := streamRead(output, int64(start), pageBytes)
	if err != nil {
		return nil, err
	}
	report := &imageReport{
		Member: image.member, SUPFMember: image.supfMember,
		Architecture: machoArchitecture(image.layout.cpuType, image.layout.cpuSubtype), CPUType: image.layout.cpuType, CPUSubtype: image.layout.cpuSubtype,
		SliceOffset: image.sliceOffset, SliceSize: image.sliceSize,
		EncryptedSHA256: hex.EncodeToString(encryptedDigest), DecryptedSHA256: hex.EncodeToString(decryptedDigest),
		CryptOffset: image.layout.cryptOffset, CryptSize: image.layout.cryptSize, Pages: len(records),
		FirstPlaintextPageSHA256:     digest(firstPage),
		PlaintextValidation:          validation,
		PreEncryptionCodeDirectories: plaintextAudits,
		OrderedPageKeysSHA256:        hex.EncodeToString(keysHash.Sum(nil)), AppMaskSHA256: digest(mask[:]),
		CodeDirectories: audits, CryptIDBefore: 1, CryptIDAfter: 0, ExactMutationScope: true,
	}
	return report, nil
}

func DecryptStreamWithOptions(input io.ReaderAt, size int64, output io.Writer, options StreamOptions) (DecryptResult, []byte, error) {
	var result DecryptResult
	if size < 0 || options.MaxMemberBytes <= 0 || options.Scratch == nil {
		return result, nil, fmt.Errorf("invalid streaming configuration")
	}
	inventory, source, err := openStreamInventory(input, size, options)
	if err != nil {
		return result, nil, err
	}
	defer source.Close()
	defer inventory.close()
	files := map[string]*zip.File{}
	for _, file := range source.File {
		files[file.Name] = file
	}
	licenses, licenseReports, err := resolveIPALicensesPacks(inventory.ipaInventory, files, options.Models)
	if err != nil {
		return result, nil, err
	}
	defer func() {
		for _, license := range licenses {
			clear(license.material.LogicalKey[:])
			clear(license.mask[:])
		}
	}()
	keyHashes := make(map[string]string, len(licenseReports))
	sharedKeyHash, providerName, modelName := "", "", ""
	for index, license := range licenseReports {
		keyHashes[license.Member] = license.LogicalKeySHA256
		if index == 0 {
			sharedKeyHash, providerName, modelName = license.LogicalKeySHA256, license.Provider, license.ModelBuild
			continue
		}
		if sharedKeyHash != license.LogicalKeySHA256 {
			sharedKeyHash = ""
		}
		if providerName != license.Provider {
			providerName = "multiple"
		}
		if modelName != license.ModelBuild {
			modelName = "multiple"
		}
	}
	oracle := map[string]any{"request_ipa_sha256": inventory.sha256}
	if len(licenseReports) == 1 {
		oracle = licenseReports[0].Oracle
	}
	imageMap := map[string][]encryptedImage{}
	for _, image := range inventory.images {
		imageMap[image.member] = append(imageMap[image.member], image)
	}
	outputHasher := sha256.New()
	writer := zip.NewWriter(io.MultiWriter(output, outputHasher))
	var imageReports []*imageReport
	pages := 0
	var stripper *accountDataStripper
	if options.StripAccountData {
		stripper = &accountDataStripper{}
	}
	seenDirectories := map[string]bool{}
	for _, file := range source.File {
		if file.FileInfo().IsDir() {
			if seenDirectories[file.Name] {
				continue // Duplicate empty directory markers were checked during inventory.
			}
			seenDirectories[file.Name] = true
		}
		if stripper != nil {
			// Licenses were already resolved from the input above.
			handled, err := stripper.write(writer, file)
			if err != nil {
				return result, nil, err
			}
			if handled {
				continue
			}
		}
		images, encrypted := imageMap[file.Name]
		if !encrypted {
			if err := writer.Copy(file); err != nil {
				return result, nil, err
			}
			continue
		}
		staged := inventory.staged[file.Name]
		if staged == nil {
			staged, err = streamStage(file, options)
			if err != nil {
				return result, nil, err
			}
			inventory.staged[file.Name] = staged
		}
		slices, err := parseStreamMachOSlices(staged, file.UncompressedSize64)
		if err != nil {
			return result, nil, err
		}
		var encryptedSlices []machoSlice
		for _, slice := range slices {
			if slice.layout.cryptID != 0 {
				encryptedSlices = append(encryptedSlices, slice)
			}
		}
		if len(encryptedSlices) != len(images) {
			return result, nil, fmt.Errorf("encrypted slice inventory changed")
		}
		for i, slice := range encryptedSlices {
			if slice.offset != images[i].sliceOffset || slice.size != images[i].sliceSize || !sameMachoLayout(slice.layout, images[i].layout) {
				return result, nil, fmt.Errorf("encrypted slice inventory changed")
			}
		}
		table, ok := inventory.supfTables[images[0].supfMember]
		if !ok {
			return result, nil, fmt.Errorf("%s: inventoried SUPF is unavailable", file.Name)
		}
		header := file.FileHeader
		target, err := writer.CreateHeader(&header)
		if err != nil {
			return result, nil, err
		}
		license := licenses[images[0].sinfMember]
		for _, image := range images {
			end := image.sliceOffset + image.sliceSize
			if end < image.sliceOffset || end > file.UncompressedSize64 {
				return result, nil, fmt.Errorf("%s slice changed after inventory", image.member)
			}
			records, err := table.recordsFor(image.layout.cpuType, image.layout.cpuSubtype)
			if err != nil {
				return result, nil, err
			}
			report, err := decryptStreamImage(staged, image, records, license.mask, license.deriver)
			if err != nil {
				return result, nil, err
			}
			report.SINFMember = image.sinfMember
			imageReports = append(imageReports, report)
			pages += len(records)
		}
		if _, err := io.CopyBuffer(target, io.NewSectionReader(staged, 0, int64(file.UncompressedSize64)), make([]byte, 65536)); err != nil {
			return result, nil, err
		}
		_ = staged.Close()
		delete(inventory.staged, file.Name)
	}
	if err := writer.Close(); err != nil {
		return result, nil, err
	}
	outputHash := hex.EncodeToString(outputHasher.Sum(nil))
	plaintextVerified := true
	for _, image := range imageReports {
		plaintextVerified = plaintextVerified && len(image.PreEncryptionCodeDirectories) > 0
	}
	report := decryptionReport{
		Schema: "unfairplay-decryption-v2", ModelBuild: modelName,
		Input:    reportFile{Path: inventory.path, Bytes: inventory.bytes, SHA256: inventory.sha256},
		Output:   reportFile{Path: "output.ipa", SHA256: outputHash, Mode: "0600"},
		Provider: providerName, Oracle: oracle, Licenses: licenseReports,
		EncryptedImages: len(imageReports), DecryptedPages: pages, Images: imageReports,
		Complete:          len(imageReports) == len(inventory.images),
		PlaintextVerified: plaintextVerified,
		AccountData:       stripper.report(),
		Warnings: []string{
			"Available pre-encryption hashes matched every covered encrypted-range page; images without these hashes have no plaintext hash verification. Other code pages are not covered.",
			"Apple CMS code-signature trust and SUPF certificate signatures are not authenticated by IPA decryption.",
			"CodeDirectory checks compare encrypted bytes with embedded hashes, not an authenticated Apple signature; those hashes are stale after decryption.",
			"Analysis IPA requires recursive re-signing before installation.",
		},
	}
	reportBytes, err := json.Marshal(report)
	if err != nil {
		return result, nil, err
	}
	result = DecryptResult{
		OutputPath: "output.ipa", OutputSHA256: outputHash, ReportPath: "report.json", PlaintextVerified: plaintextVerified,
		EncryptedImages: len(imageReports), DecryptedPages: pages,
		LogicalKeySHA256: sharedKeyHash, LogicalKeySHA256BySINF: keyHashes,
	}
	if account := stripper.report(); account != nil {
		result.AccountDataStripped = true
		result.RemovedLicenseFiles, result.RemovedMetadataFields = account.RemovedLicenseFiles, account.RemovedMetadataFields
	}
	return result, reportBytes, nil
}

// InspectStream authenticates archive/key-table structure without retaining a
// plaintext archive or resolving private enrollment models.
func InspectStream(input io.ReaderAt, size int64, options StreamOptions) (DecryptResult, []byte, error) {
	var result DecryptResult
	inventory, _, err := openStreamInventory(input, size, options)
	if err != nil {
		return result, nil, err
	}
	defer inventory.close()
	result.EncryptedImages = len(inventory.images)
	encryptedPages := 0
	for _, image := range inventory.images {
		encryptedPages += int(image.layout.cryptSize) / pageBytes
	}
	report, err := json.Marshal(map[string]any{"schema": "unfairplay-portable-doctor-v1", "encrypted_image_count": result.EncryptedImages, "encrypted_pages": encryptedPages, "complete": true, "plaintext_verified": false, "models_authenticated": false})
	return result, report, err
}
