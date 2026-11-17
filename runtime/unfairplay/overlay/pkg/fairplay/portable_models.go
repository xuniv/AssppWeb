package fairplay

import (
	"crypto/sha256"
	"fmt"
)

const MaximumPortableModels = 256
const MaximumPortableModelBytes = currentSINFModelV3Bytes

type PortableModelInfo struct {
	Version uint32 `json:"version"`
	Bytes   int    `json:"bytes"`
}

// InspectPortableModel validates the exact upstream envelope, version, geometry
// and byte permutations. SINF authentication is a separate operation.
func InspectPortableModel(pack []byte) (PortableModelInfo, error) {
	model, err := parseCurrentSINFModel(pack)
	if err != nil {
		return PortableModelInfo{}, err
	}
	defer clear(model.key[:])
	defer clear(model.whitening[:])
	defer clear(model.inputDecode[:])
	defer clear(model.outputEncode[:])
	defer clear(model.outputMask[:])
	defer clear(model.postDecode[:])
	return PortableModelInfo{Version: model.version, Bytes: len(pack)}, nil
}

// InspectPortableModels validates an imported collection without claiming that
// every version can participate in the same selector-bound decryption registry.
func InspectPortableModels(packs [][]byte) ([]PortableModelInfo, error) {
	if len(packs) > MaximumPortableModels {
		return nil, fmt.Errorf("too many enrollment models")
	}
	seen := make(map[[32]byte]bool, len(packs))
	infos := make([]PortableModelInfo, 0, len(packs))
	for _, pack := range packs {
		sum := sha256.Sum256(pack)
		if seen[sum] {
			return nil, fmt.Errorf("duplicate enrollment model")
		}
		seen[sum] = true
		info, err := InspectPortableModel(pack)
		if err != nil {
			return nil, err
		}
		infos = append(infos, info)
	}
	return infos, nil
}

func ValidatePortableModels(packs [][]byte) error {
	infos, err := InspectPortableModels(packs)
	if err != nil {
		return err
	}
	for _, info := range infos {
		if len(packs) > 1 && info.Version == 1 {
			return fmt.Errorf("version 1 enrollment models cannot be used in a registry")
		}
	}
	return nil
}
