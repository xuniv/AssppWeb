package fairplay

import (
	"archive/zip"
	"bytes"
	"crypto/aes"
	"crypto/cipher"
	"encoding/binary"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"testing"
)

func testScratch(t *testing.T) func(int64) (StreamFile, error) {
	return func(size int64) (StreamFile, error) { f, e := os.CreateTemp(t.TempDir(), "scratch"); return f, e }
}
func TestPortableStreamMatchesUpstream(t *testing.T) {
	f := newStripFixture(t, []byte(syntheticStoreMetadata))
	packs, e := readEnrollmentModelRegistry(f.models)
	if e != nil {
		t.Fatal(e)
	}
	r, e := os.Open(f.input)
	if e != nil {
		t.Fatal(e)
	}
	defer r.Close()
	st, _ := r.Stat()
	for _, strip := range []bool{false, true} {
		var output bytes.Buffer
		result, report, e := DecryptStreamWithOptions(r, st.Size(), &output, StreamOptions{Models: packs, StripAccountData: strip, MaxMemberBytes: 256 << 20, Scratch: testScratch(t)})
		if e != nil {
			t.Fatal(e)
		}
		if !result.PlaintextVerified || result.EncryptedImages != 2 || len(report) == 0 {
			t.Fatalf("bad result: %+v", result)
		}
		z, e := zip.NewReader(bytes.NewReader(output.Bytes()), int64(output.Len()))
		if e != nil {
			t.Fatal(e)
		}
		for _, entry := range z.File {
			if entry.Name == stripMainPath || entry.Name == stripWidgetPath {
				data, e := zipBytes(entry)
				if e != nil {
					t.Fatal(e)
				}
				if binary.LittleEndian.Uint32(data[48:52]) != 0 {
					t.Fatal("encrypted header retained")
				}
				if !bytes.Equal(data[4096:8192], f.plain[entry.Name]) {
					t.Fatal("wrong plaintext")
				}
			}
		}
		path := filepath.Join(t.TempDir(), "upstream.ipa")
		native, err := DecryptIPA(DecryptOptions{InputPath: f.input, ModelPath: f.models, OutputPath: path, ReportPath: path + ".json", StripAccountData: strip})
		if err != nil {
			t.Fatal(err)
		}
		b, _ := os.ReadFile(path)
		if !bytes.Equal(output.Bytes(), b) || native.OutputSHA256 != result.OutputSHA256 {
			t.Fatal("stream output differs from upstream")
		}
	}
}
func TestPortableStreamRejectsWrongModels(t *testing.T) {
	f := newStripFixture(t, nil)
	r, _ := os.Open(f.input)
	defer r.Close()
	st, _ := r.Stat()
	pack := selectorBoundModelPack(t, SINFSelector{User: 42, Key: 99})
	_, _, err := DecryptStreamWithOptions(r, st.Size(), io.Discard, StreamOptions{Models: [][]byte{pack}, MaxMemberBytes: 256 << 20, Scratch: testScratch(t)})
	if err == nil {
		t.Fatal("wrong selector accepted")
	}
}
func TestPortableStreamAuditMatchesUpstream(t *testing.T) {
	for _, kind := range []byte{1, 2, 3, 4} {
		for _, shift := range []byte{0, 12, 13, 14} {
			blob, layout := signedPreEncryptionAuditFixture(t, 4096, 8192, shift, kind)
			for _, pre := range []bool{false, true} {
				a, e := auditCodeDirectoriesMode(blob, layout, pre)
				b, f := auditStreamCodeDirectories(bytes.NewReader(blob), int64(len(blob)), layout, pre)
				if (e == nil) != (f == nil) || len(a) != len(b) {
					t.Fatal("audit mismatch")
				}
				for i := range a {
					if a[i] != b[i] {
						t.Fatalf("audit mismatch: %+v %+v", a, b)
					}
				}
			}
		}
	}
}

// This optional exporter creates only synthetic licenses, models and code.
// No Store/account/enrollment data or private executable is read.
func TestExportPortableSyntheticFixtures(t *testing.T) {
	directory := os.Getenv("UNFAIRPLAY_SYNTHETIC_OUTPUT")
	if directory == "" {
		t.Skip("synthetic export not requested")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	fixture := syntheticCurrentSINFFixture(t, 42, 7, 88, [16]byte{1, 2, 3})
	if err := os.WriteFile(filepath.Join(directory, "model.bin"), selectorBoundModelPack(t, fixture.selector), 0600); err != nil {
		t.Fatal(err)
	}
	for _, mb := range []int{0, 64, 128} {
		pages := 1
		if mb > 0 {
			pages = mb * 1024 * 1024 / pageBytes
		}
		size := uint32(pages * pageBytes)
		blob, _ := signedPreEncryptionAuditFixture(t, pageBytes, size, 12, 2)
		clear(blob[:pageBytes])
		le := func(at int, value uint32) { binary.LittleEndian.PutUint32(blob[at:], value) }
		le(0, mhMagic64)
		le(4, cpuTypeARM64)
		le(12, 2)
		le(16, 2)
		le(20, 40)
		le(32, lcEncryptionInfo64)
		le(36, 24)
		le(40, pageBytes)
		le(44, size)
		le(48, 1)
		le(56, lcCodeSignature)
		le(60, 16)
		le(64, pageBytes+size)
		le(68, uint32(len(blob))-pageBytes-size)
		for at := pageBytes; at < int(pageBytes+size); at += 4 {
			binary.LittleEndian.PutUint32(blob[at:], 0xd503201f)
		}
		setSyntheticPreEncryptionHashes(t, blob, machoLayout{signatureOffset: pageBytes + size})
		supf := make([]byte, 28+pages*32)
		supf[0] = 5
		be := func(at int, value uint32) { binary.BigEndian.PutUint32(supf[at:], value) }
		be(4, uint32(len(supf)-8))
		be(8, 1)
		be(12, uint32(len(supf)-16))
		be(16, cpuTypeARM64)
		be(24, uint32(pages))
		deriver := newPageKeyDeriver(appMaskFromLogicalKey(fixture.logical))
		for page := 0; page < pages; page++ {
			record := supf[28+page*32 : 28+(page+1)*32]
			for i := range record {
				record[i] = byte(page + i + 1)
			}
			at := pageBytes + page*pageBytes
			key := deriver.pageKey(record[:16], uint64(at))
			block, e := aes.NewCipher(key[:])
			if e != nil {
				t.Fatal(e)
			}
			cipher.NewCBCEncrypter(block, record[16:]).CryptBlocks(blob[at:at+pageBytes], blob[at:at+pageBytes])
		}
		dir := blob[int(pageBytes+size)+20:]
		for slot := 0; slot < pages+1; slot++ {
			h, _ := hashCodePage(2, blob[slot*pageBytes:(slot+1)*pageBytes])
			copy(dir[96+slot*32:], h)
		}
		file, e := os.Create(filepath.Join(directory, fmt.Sprintf("synthetic-%d.ipa", mb)))
		if e != nil {
			t.Fatal(e)
		}
		writer := zip.NewWriter(file)
		for _, entry := range []struct {
			name string
			data []byte
		}{{"Payload/Test.app/Test", blob}, {"Payload/Test.app/SC_Info/Test.sinf", fixture.sinf}, {"Payload/Test.app/SC_Info/Test.v5.supf", supf}, {"iTunesMetadata.plist", []byte(syntheticStoreMetadata)}} {
			target, e := writer.CreateHeader(&zip.FileHeader{Name: entry.name, Method: zip.Store})
			if e != nil {
				t.Fatal(e)
			}
			if _, e := target.Write(entry.data); e != nil {
				t.Fatal(e)
			}
		}
		if e := writer.Close(); e != nil {
			t.Fatal(e)
		}
		file.Close()
	}
}

func TestPortableStreamPlaintextValidationFailures(t *testing.T) {
	for _, name := range []string{"tampered-prehash", "malformed-prehash", "missing-prehash", "malformed-selected-table"} {
		t.Run(name, func(t *testing.T) {
			f := newStripFixture(t, nil)
			blob := f.data[stripMainPath]
			dir := blob[8192+20:]
			switch name {
			case "tampered-prehash":
				offset := int(binary.BigEndian.Uint32(dir[92:96]))
				dir[offset+32] ^= 1
			case "malformed-prehash":
				binary.BigEndian.PutUint32(dir[92:96], uint32(len(dir)-1))
			case "missing-prehash":
				for _, member := range []string{stripMainPath, stripWidgetPath} {
					binary.BigEndian.PutUint32(f.data[member][8192+20+92:], 0)
				}
			case "malformed-selected-table":
				f.data["Payload/Test.app/SC_Info/Test.v5.supf"][0] = 99
			}
			writeOrderedArchive(t, f.input, f.members, f.data)
			packs, e := readEnrollmentModelRegistry(f.models)
			if e != nil {
				t.Fatal(e)
			}
			input, e := os.Open(f.input)
			if e != nil {
				t.Fatal(e)
			}
			defer input.Close()
			st, _ := input.Stat()
			result, _, err := DecryptStreamWithOptions(input, st.Size(), io.Discard, StreamOptions{Models: packs, MaxMemberBytes: 256 << 20, Scratch: testScratch(t)})
			if name == "missing-prehash" {
				if err != nil || result.PlaintextVerified {
					t.Fatalf("missing hashes were not marked unverified: %+v %v", result, err)
				}
			} else if err == nil {
				t.Fatal("invalid selected input accepted")
			}
		})
	}
}
