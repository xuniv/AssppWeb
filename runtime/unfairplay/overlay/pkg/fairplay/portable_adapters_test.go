package fairplay

import (
	"archive/zip"
	"bytes"
	"io"
	"testing"

	"howett.net/plist"
)

func portableTestArchive(t *testing.T, members map[string][]byte) []byte {
	t.Helper()
	var output bytes.Buffer
	writer := zip.NewWriter(&output)
	for name, data := range members {
		target, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		if _, err = target.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	return output.Bytes()
}
func portableTestMembers(t *testing.T, archive []byte) map[string][]byte {
	t.Helper()
	source, err := zip.NewReader(bytes.NewReader(archive), int64(len(archive)))
	if err != nil {
		t.Fatal(err)
	}
	result := map[string][]byte{}
	for _, file := range source.File {
		reader, err := file.Open()
		if err != nil {
			t.Fatal(err)
		}
		data, err := io.ReadAll(reader)
		reader.Close()
		if err != nil {
			t.Fatal(err)
		}
		result[file.Name] = data
	}
	return result
}
func TestPortableModelInspection(t *testing.T) {
	one := legacyModelPack(syntheticLegacyModel())
	two := selectorBoundModelPack(t, SINFSelector{User: 42, Key: 7})
	for _, p := range [][]byte{one, two} {
		info, err := InspectPortableModel(p)
		if err != nil || info.Bytes != len(p) {
			t.Fatalf("model rejected: %v", err)
		}
	}
	if infos, err := InspectPortableModels([][]byte{one, two}); err != nil || len(infos) != 2 {
		t.Fatal("mixed imported models rejected")
	}
	if ValidatePortableModels([][]byte{one, two}) == nil {
		t.Fatal("accepted v1 registry")
	}
	if ValidatePortableModels([][]byte{two, two}) == nil {
		t.Fatal("accepted duplicate model")
	}
	bad := append([]byte(nil), two...)
	bad[len(bad)-1] = bad[len(bad)-2]
	if _, err := InspectPortableModel(bad); err == nil {
		t.Fatal("accepted non-permutation model")
	}
	if _, err := InspectPortableModel(make([]byte, 8709)); err == nil {
		t.Fatal("accepted unknown model")
	}
}
func TestPortableAccountStripPreservesExecutables(t *testing.T) {
	original := portableTestArchive(t, map[string][]byte{"Payload/Test.app/Test": []byte("unchanged encrypted image"), "Payload/Test.app/SC_Info/Test.sinf": []byte("synthetic license"), "iTunesMetadata.plist": []byte(syntheticStoreMetadata)})
	saved := append([]byte(nil), original...)
	var output bytes.Buffer
	result, err := StripAccountDataStream(bytes.NewReader(original), int64(len(original)), &output, MaximumPortableArchiveBytes)
	if err != nil {
		t.Fatal(err)
	}
	if result.RemovedLicenseFiles != 1 || result.RemovedMetadataFields != 3 {
		t.Fatalf("wrong strip counts: %+v", result)
	}
	if !bytes.Equal(original, saved) {
		t.Fatal("input archive changed")
	}
	members := portableTestMembers(t, output.Bytes())
	if _, ok := members["Payload/Test.app/SC_Info/Test.sinf"]; ok {
		t.Fatal("license retained")
	}
	if !bytes.Equal(members["Payload/Test.app/Test"], []byte("unchanged encrypted image")) {
		t.Fatal("executable changed")
	}
	var metadata map[string]any
	if _, err = plist.Unmarshal(members["iTunesMetadata.plist"], &metadata); err != nil {
		t.Fatal(err)
	}
	if metadata["apple-id"] != nil || metadata["userName"] != nil {
		t.Fatal("account metadata retained")
	}
	if metadata["itemName"] != "Test" {
		t.Fatal("non-account metadata changed")
	}
}
func TestPortableSINFConversionUsesAuthenticatedModel(t *testing.T) {
	credential := macOSTestCredential()
	model := macOSTestVersion2Model(t, credential)
	sinf := macOSTestCurrentSINF(t, credential, 7)
	name := "Payload/Test.app/SC_Info/Test.sinf"
	original := portableTestArchive(t, map[string][]byte{name: sinf, "Payload/Test.app/Test": []byte("unchanged executable")})
	saved := append([]byte(nil), original...)
	var output bytes.Buffer
	result, err := ConvertMacOSIPAStream(bytes.NewReader(original), int64(len(original)), &output, [][]byte{model}, MaximumPortableArchiveBytes)
	if err != nil {
		t.Fatal(err)
	}
	if result.ConvertedRecords != 1 {
		t.Fatal("wrong conversion count")
	}
	members := portableTestMembers(t, output.Bytes())
	if err = verifyMacOSSINF(members[name], credential); err != nil {
		t.Fatal(err)
	}
	if !bytes.Equal(members["Payload/Test.app/Test"], []byte("unchanged executable")) || !bytes.Equal(original, saved) {
		t.Fatal("conversion mutated executable or source")
	}
	bad := append([]byte(nil), model...)
	bad[56] ^= 1
	if _, err = ConvertMacOSIPAStream(bytes.NewReader(original), int64(len(original)), io.Discard, [][]byte{bad}, MaximumPortableArchiveBytes); err == nil {
		t.Fatal("accepted wrong model")
	}
}
