// Build-time public assets only. This command has no account or signer APIs.
package main

import (
	"compress/zlib"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"time"

	assets "github.com/majd/ipatool/v2/internal/assppassetsource"
)

func main() {
	if err := run(); err != nil {
		os.Stderr.WriteString("Public Apple asset preparation failed\n")
		os.Exit(1)
	}
}
func run() error {
	if len(os.Args) != 2 {
		return errors.New("output directory required")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 30*time.Minute)
	defer cancel()
	bundle, err := assets.Load(ctx)
	if err != nil {
		return err
	}
	root := os.Args[1]
	if err = os.MkdirAll(root, 0o755); err != nil {
		return err
	}
	manifest := map[string]any{}
	for _, item := range []struct {
		name string
		data []byte
	}{
		{"AppleMediaServices", bundle.AppleMediaServices}, {"commerce", bundle.Commerce}, {"adid", bundle.ADID}, {"CoreFP", bundle.CoreFP}, {"CoreFP.icxs", bundle.CoreFPICXS}, {"fairplayd", bundle.FairPlayD}, {"FairPlayIOKit", bundle.FairPlayKext},
	} {
		file, err := os.Create(filepath.Join(root, item.name+".zlib"))
		if err != nil {
			return err
		}
		writer, err := zlib.NewWriterLevel(file, zlib.BestCompression)
		if err != nil {
			file.Close()
			return err
		}
		_, writeErr := writer.Write(item.data)
		closeErr := writer.Close()
		fileErr := file.Close()
		if err = errors.Join(writeErr, closeErr, fileErr); err != nil {
			return err
		}
		digest := sha256.Sum256(item.data)
		manifest[item.name] = map[string]any{"size": len(item.data), "sha256": hex.EncodeToString(digest[:])}
	}
	encoded, err := json.MarshalIndent(manifest, "", "  ")
	if err != nil {
		return err
	}
	return os.WriteFile(filepath.Join(root, "manifest.json"), encoded, 0o644)
}
