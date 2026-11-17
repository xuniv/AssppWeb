//go:build asspp_unfair_fixture

package fairplay

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// TestWritePortableBuildFixtures is opt-in host build tooling. All inputs are
// invented by existing upstream synthetic fixture builders. No fixture or
// model is embedded in the application or written into its resource bundle.
func TestWritePortableBuildFixtures(t *testing.T) {
	directory := os.Getenv("ASSPP_UNFAIRPLAY_FIXTURE_OUTPUT")
	if directory == "" {
		t.Skip("explicit synthetic fixture output is required")
	}
	if !filepath.IsAbs(directory) {
		t.Fatal("fixture output must be absolute")
	}
	if err := os.MkdirAll(directory, 0700); err != nil {
		t.Fatal(err)
	}
	fixture := newStripFixture(t, []byte(syntheticStoreMetadata))
	copyFixture := func(source, target string) {
		data, err := os.ReadFile(source)
		if err != nil {
			t.Fatal(err)
		}
		defer clear(data)
		if err = os.WriteFile(filepath.Join(directory, target), data, 0600); err != nil {
			t.Fatal(err)
		}
	}
	copyFixture(fixture.input, "input.ipa")
	copyFixture(filepath.Join(fixture.models, "main.bin"), "model-main.bin")
	copyFixture(filepath.Join(fixture.models, "widget.bin"), "model-widget.bin")
	credential := macOSTestCredential()
	model := macOSTestVersion2Model(t, credential)
	sinf := macOSTestCurrentSINF(t, credential, 7)
	archive := portableTestArchive(t, map[string][]byte{"Payload/Test.app/SC_Info/Test.sinf": sinf, "Payload/Test.app/Test": []byte("synthetic unchanged executable")})
	for name, data := range map[string][]byte{"conversion-input.ipa": archive, "conversion-model.bin": model} {
		if err := os.WriteFile(filepath.Join(directory, name), data, 0600); err != nil {
			t.Fatal(err)
		}
	}

	expected := map[string]any{
		"schema":              "asspp-unfairplay-synthetic-v1",
		"modelInspect":        map[string]any{"modelCount": 2, "modelVersions": []int{2, 2}, "ready": true, "registryCompatible": true},
		"doctorWithoutModels": map[string]any{"encryptedImages": 2, "decryptedPages": 0, "plaintextVerified": false, "ready": false},
		"decrypt":             map[string]any{"encryptedImages": 2, "decryptedPages": 2, "plaintextVerified": true, "ready": true},
		"stripped":            map[string]any{"removedLicenseFiles": 4, "removedMetadataFields": 3, "accountDataStripped": true},
		"convert":             map[string]any{"convertedRecords": 1, "convertedReplicas": 0, "plaintextVerified": false},
	}
	encoded, err := json.MarshalIndent(expected, "", "  ")
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(filepath.Join(directory, "fixture-summary.json"), encoded, 0600); err != nil {
		t.Fatal(err)
	}
	clear(credential)
	clear(model)
}
