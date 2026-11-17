package assppunfair

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

func requestBytes(t *testing.T, value Request) []byte {
	t.Helper()
	encoded, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return encoded
}
func TestBridgeStripsIntoNewPrivateFile(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "input.ipa")
	output := filepath.Join(directory, "output.ipa")
	var archive bytes.Buffer
	writer := zip.NewWriter(&archive)
	for name, data := range map[string]string{"Payload/Test.app/Test": "unchanged", "Payload/Test.app/SC_Info/Test.sinf": "synthetic private license"} {
		target, err := writer.Create(name)
		if err != nil {
			t.Fatal(err)
		}
		target.Write([]byte(data))
	}
	if err := writer.Close(); err != nil {
		t.Fatal(err)
	}
	original := append([]byte(nil), archive.Bytes()...)
	if err := os.WriteFile(input, original, 0600); err != nil {
		t.Fatal(err)
	}
	request := requestBytes(t, Request{Operation: "strip_account_data", InputPath: input, OutputPath: output})
	result := Execute(context.Background(), request)
	if !result.OK || result.Value == nil || !result.Value.AccountDataStripped || result.Value.RemovedLicenseFiles != 1 {
		t.Fatalf("strip failed: %+v", result)
	}
	info, err := os.Stat(output)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatal("output is not private")
	}
	result = Execute(context.Background(), request)
	if result.OK || result.Error != "output_exists" {
		t.Fatal("replaced existing output")
	}
	current, err := os.ReadFile(input)
	if err != nil || !bytes.Equal(current, original) {
		t.Fatal("source changed")
	}
}
func TestBridgeRemovesIncompleteOutputAndKeepsErrorsPrivate(t *testing.T) {
	directory := t.TempDir()
	input := filepath.Join(directory, "private-account-path.ipa")
	output := filepath.Join(directory, "partial.ipa")
	if err := os.WriteFile(input, []byte("invalid synthetic ZIP"), 0600); err != nil {
		t.Fatal(err)
	}
	result := Execute(context.Background(), requestBytes(t, Request{Operation: "strip_account_data", InputPath: input, OutputPath: output}))
	if result.OK || result.Error != "processing_failed" {
		t.Fatalf("unexpected failure: %+v", result)
	}
	if _, err := os.Stat(output); !os.IsNotExist(err) {
		t.Fatal("partial output remained")
	}
	encoded, _ := json.Marshal(result)
	if bytes.Contains(encoded, []byte(directory)) {
		t.Fatal("private path escaped")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if result = Execute(ctx, []byte(`{"operation":"doctor"}`)); result.Error != "canceled" {
		t.Fatal("cancellation lost")
	}
	if result = Execute(context.Background(), []byte(`{"operation":"model_inspect","modelPath":"private.bin"}`)); result.Error != "invalid_request" {
		t.Fatal("unknown request field accepted")
	}
}
func TestRequestIDBounds(t *testing.T) {
	for _, id := range []string{"", "arbitrary", "00000000-0000-0000-0000-000000000000"} {
		if ValidRequestID(id) {
			t.Fatal("invalid cancellation ID accepted")
		}
	}
	if !ValidRequestID("C20EEAFF-8E94-4F03-9B82-9F94C7628D78") {
		t.Fatal("Swift UUID rejected")
	}
}
