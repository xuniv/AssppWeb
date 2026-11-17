package fairplay

import (
	"archive/zip"
	"fmt"
	"io"
	"os"
	"path"
	"sort"
	"strings"
)

const MaximumPortableArchiveBytes int64 = 8 << 30
const MaximumPortableArchiveEntries = 100000
const DefaultPortableMemberBytes int64 = MaximumPortableArchiveBytes

// PortableArchiveBounds checks declared allocation geometry before any member
// is inflated. Archive contents are never extracted to the host filesystem.
func PortableArchiveBounds(source *zip.Reader, maxMember int64) error {
	if maxMember <= 0 {
		maxMember = DefaultPortableMemberBytes
	}
	if len(source.File) > MaximumPortableArchiveEntries {
		return fmt.Errorf("too many IPA members")
	}
	var total uint64
	names := make(map[string]*zip.File, len(source.File))
	for _, file := range source.File {
		name := file.Name
		if name == "" || strings.Contains(name, "\\") || strings.IndexByte(name, 0) >= 0 || strings.HasPrefix(name, "/") || path.Clean(strings.TrimSuffix(name, "/")) != strings.TrimSuffix(name, "/") || strings.HasPrefix(name, "../") || name == ".." {
			return fmt.Errorf("invalid IPA member path")
		}
		if previous, exists := names[name]; exists {
			if strings.HasSuffix(name, "/") && previous.FileInfo().IsDir() && file.FileInfo().IsDir() && previous.UncompressedSize64 == 0 && file.UncompressedSize64 == 0 {
				continue
			}
			return fmt.Errorf("duplicate IPA member")
		}
		names[name] = file
		if file.Mode()&os.ModeType != 0 && !file.FileInfo().IsDir() {
			return fmt.Errorf("unsupported IPA member type")
		}
		if file.Flags&1 != 0 {
			return fmt.Errorf("ZIP encryption is unsupported")
		}
		if file.UncompressedSize64 > uint64(maxMember) {
			return fmt.Errorf("IPA member exceeds memory limit")
		}
		if file.UncompressedSize64 > uint64(MaximumPortableArchiveBytes)-total {
			return fmt.Errorf("expanded IPA exceeds size limit")
		}
		total += file.UncompressedSize64
	}
	return nil
}

type PortableStripResult struct{ RemovedLicenseFiles, RemovedMetadataFields int }

// StripAccountDataStream uses the upstream account stripper without changing
// executable bytes. It does not claim decryption or plaintext verification.
func StripAccountDataStream(input io.ReaderAt, size int64, output io.Writer, maxMember int64) (PortableStripResult, error) {
	var result PortableStripResult
	if size <= 0 || size > MaximumPortableArchiveBytes {
		return result, fmt.Errorf("invalid IPA size")
	}
	source, err := OpenPortableArchive(input, size)
	if err != nil {
		return result, err
	}
	if err = PortableArchiveBounds(source, maxMember); err != nil {
		return result, err
	}
	writer := zip.NewWriter(output)
	stripper := accountDataStripper{}
	for _, file := range source.File {
		handled, e := stripper.write(writer, file)
		if e != nil {
			return result, e
		}
		if !handled {
			if e = writer.Copy(file); e != nil {
				return result, e
			}
		}
	}
	if err = writer.Close(); err != nil {
		return result, err
	}
	result.RemovedLicenseFiles, result.RemovedMetadataFields = stripper.removedLicenseFiles, stripper.removedMetadataFields
	return result, nil
}

type PortableConversionResult struct{ ConvertedRecords, ConvertedReplicas int }

// ConvertMacOSIPAStream converts authenticated SINF records only. Mach-O data
// remains encrypted and byte-identical; no signing or native execution occurs.
func ConvertMacOSIPAStream(input io.ReaderAt, size int64, output io.Writer, packs [][]byte, maxMember int64) (PortableConversionResult, error) {
	var result PortableConversionResult
	if err := ValidatePortableModels(packs); err != nil {
		return result, err
	}
	if len(packs) == 0 {
		return result, fmt.Errorf("an enrollment model is required")
	}
	if size <= 0 || size > MaximumPortableArchiveBytes {
		return result, fmt.Errorf("invalid IPA size")
	}
	source, err := OpenPortableArchive(input, size)
	if err != nil {
		return result, err
	}
	if err = PortableArchiveBounds(source, maxMember); err != nil {
		return result, err
	}
	files := make(map[string]*zip.File, len(source.File))
	replacements := make(map[string][]byte)
	reports := make(map[string]MacOSSINFRecordReport)
	defer func() {
		for _, data := range replacements {
			clear(data)
		}
	}()
	for _, file := range source.File {
		files[file.Name] = file
		if !strings.Contains(file.Name, "/SC_Info/") || !strings.HasSuffix(strings.ToLower(file.Name), ".sinf") {
			continue
		}
		if file.UncompressedSize64 > maximumMacOSSINFBytes {
			return result, fmt.Errorf("SINF exceeds size limit")
		}
		blob, e := zipBytes(file)
		if e != nil {
			return result, e
		}
		converted, report, e := normalizeMacOSSINFWithModels(blob, packs)
		clear(blob)
		if e != nil {
			return result, e
		}
		report.Path = file.Name
		replacements[file.Name] = converted
		reports[file.Name] = report
		result.ConvertedRecords++
	}
	if result.ConvertedRecords == 0 {
		return result, fmt.Errorf("IPA contains no supported SINF records")
	}
	// The upstream replica builder only consumes File; a wrapper supplies it
	// without introducing a filename or an operating-system file handle.
	replicas, replicaReports, err := addMacOSSINFReplicas(&zip.ReadCloser{Reader: zip.Reader{File: source.File}}, files, replacements, reports)
	if err != nil {
		return result, err
	}
	result.ConvertedReplicas = len(replicaReports)
	writer := zip.NewWriter(output)
	for _, file := range source.File {
		replacement, replace := replacements[file.Name]
		if !replace {
			if err = writer.Copy(file); err != nil {
				return result, err
			}
			continue
		}
		target, e := writer.CreateHeader(&file.FileHeader)
		if e != nil {
			return result, e
		}
		if _, e = target.Write(replacement); e != nil {
			return result, e
		}
	}
	names := make([]string, 0, len(replicas))
	for name := range replicas {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		replica := replicas[name]
		target, e := writer.CreateHeader(&replica.header)
		if e != nil {
			return result, e
		}
		if _, e = target.Write(replica.data); e != nil {
			return result, e
		}
	}
	if err = writer.Close(); err != nil {
		return result, err
	}
	return result, nil
}
