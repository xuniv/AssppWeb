// Package assppunfair exposes bounded offline file operations with private
// enrollment models held only for the duration of a call.
package assppunfair

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"strings"

	"github.com/DrWhax/unfairplay/pkg/fairplay"
)

const MaximumRequestBytes = 4 << 20
const MaximumResponseBytes = 1 << 20
const MaximumOutputBytes int64 = 8 << 30

var (
	errInvalidInput = errors.New("invalid_input")
	errOutputExists = errors.New("output_exists")
	ErrOutputLimit  = errors.New("output_limit")
)

type Request struct {
	Operation        string   `json:"operation"`
	RequestID        string   `json:"requestID,omitempty"`
	InputPath        string   `json:"inputPath,omitempty"`
	OutputPath       string   `json:"outputPath,omitempty"`
	Models           [][]byte `json:"models,omitempty"`
	StripAccountData bool     `json:"stripAccountData,omitempty"`
}

type Value struct {
	OutputPath            string   `json:"outputPath,omitempty"`
	OutputSHA256          string   `json:"outputSHA256,omitempty"`
	PlaintextVerified     bool     `json:"plaintextVerified"`
	EncryptedImages       int      `json:"encryptedImages,omitempty"`
	DecryptedPages        int      `json:"decryptedPages,omitempty"`
	AccountDataStripped   bool     `json:"accountDataStripped,omitempty"`
	RemovedLicenseFiles   int      `json:"removedLicenseFiles,omitempty"`
	RemovedMetadataFields int      `json:"removedMetadataFields,omitempty"`
	ModelCount            int      `json:"modelCount,omitempty"`
	ModelVersions         []uint32 `json:"modelVersions,omitempty"`
	Ready                 bool     `json:"ready"`
	RegistryCompatible    bool     `json:"registryCompatible"`
	ConvertedRecords      int      `json:"convertedRecords,omitempty"`
	ConvertedReplicas     int      `json:"convertedReplicas,omitempty"`
}

type Response struct {
	OK    bool   `json:"ok"`
	Error string `json:"error,omitempty"`
	Value *Value `json:"value,omitempty"`
}

func failure(err error) Response {
	code := "processing_failed"
	switch {
	case errors.Is(err, context.Canceled), errors.Is(err, context.DeadlineExceeded):
		code = "canceled"
	case errors.Is(err, errInvalidInput):
		code = "invalid_input"
	case errors.Is(err, errOutputExists):
		code = "output_exists"
	case errors.Is(err, ErrOutputLimit):
		code = "output_limit"
	}
	return Response{Error: code}
}

func pathAllowed(name string) bool {
	return len(name) > 0 && len(name) <= 4096 && filepath.IsAbs(name) && strings.IndexByte(name, 0) < 0
}
func openInput(name string) (*os.File, int64, error) {
	if !pathAllowed(name) {
		return nil, 0, errInvalidInput
	}
	before, err := os.Lstat(name)
	if err != nil || !before.Mode().IsRegular() || before.Size() <= 0 || before.Size() > fairplay.MaximumPortableArchiveBytes {
		return nil, 0, errInvalidInput
	}
	file, err := os.Open(name)
	if err != nil {
		return nil, 0, errInvalidInput
	}
	after, err := file.Stat()
	if err != nil || !os.SameFile(before, after) {
		file.Close()
		return nil, 0, errInvalidInput
	}
	return file, after.Size(), nil
}

func newOutput(name, input string) (*os.File, error) {
	if !pathAllowed(name) || filepath.Clean(name) == filepath.Clean(input) {
		return nil, errInvalidInput
	}
	parent, err := os.Stat(filepath.Dir(name))
	if err != nil || !parent.IsDir() {
		return nil, errInvalidInput
	}
	file, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0600)
	if errors.Is(err, os.ErrExist) {
		return nil, errOutputExists
	}
	if err != nil {
		return nil, errInvalidInput
	}
	return file, nil
}

type contextReaderAt struct {
	ctx    context.Context
	reader io.ReaderAt
}

func (r contextReaderAt) ReadAt(data []byte, offset int64) (int, error) {
	if err := r.ctx.Err(); err != nil {
		return 0, err
	}
	return r.reader.ReadAt(data, offset)
}

type limitWriter struct {
	ctx       context.Context
	writer    io.Writer
	remaining int64
}

func (w *limitWriter) Write(data []byte) (int, error) {
	if err := w.ctx.Err(); err != nil {
		return 0, err
	}
	if int64(len(data)) > w.remaining {
		return 0, ErrOutputLimit
	}
	n, err := w.writer.Write(data)
	w.remaining -= int64(n)
	return n, err
}

// Execute never writes reports, model files, logs or network requests. Output
// files are new, private and removed on every incomplete operation.
func Execute(ctx context.Context, input []byte) (response Response) {
	defer func() {
		if recover() != nil {
			response = Response{Error: "processing_failed"}
		}
	}()
	if ctx == nil || len(input) == 0 || len(input) > MaximumRequestBytes {
		return Response{Error: "invalid_request"}
	}
	if err := ctx.Err(); err != nil {
		return failure(err)
	}
	var request Request
	defer func() {
		for _, pack := range request.Models {
			clear(pack)
		}
	}()

	decoder := json.NewDecoder(bytes.NewReader(input))
	decoder.DisallowUnknownFields()
	if decoder.Decode(&request) != nil {
		return Response{Error: "invalid_request"}
	}
	if request.RequestID != "" && !ValidRequestID(request.RequestID) {
		return Response{Error: "invalid_request"}
	}
	var extra any
	if decoder.Decode(&extra) != io.EOF {
		return Response{Error: "invalid_request"}
	}
	switch request.Operation {
	case "model_inspect", "doctor", "verify", "decrypt", "strip_account_data", "convert_ipa_macos":
	default:
		return Response{Error: "unsupported_operation"}
	}
	if request.Operation != "model_inspect" {
		if err := fairplay.ValidatePortableModels(request.Models); err != nil {
			return Response{Error: "invalid_model"}
		}
	}
	infos, err := fairplay.InspectPortableModels(request.Models)
	if err != nil {
		return Response{Error: "invalid_model"}
	}
	value := Value{ModelCount: len(request.Models), RegistryCompatible: len(request.Models) > 0 && fairplay.ValidatePortableModels(request.Models) == nil}
	for _, info := range infos {
		value.ModelVersions = append(value.ModelVersions, info.Version)
	}
	if request.Operation == "model_inspect" {
		if len(request.Models) == 0 {
			return Response{Error: "invalid_model"}
		}
		value.Ready = true
		return Response{OK: true, Value: &value}
	}
	file, size, err := openInput(request.InputPath)
	if err != nil {
		return failure(err)
	}
	defer file.Close()
	reader := contextReaderAt{ctx: ctx, reader: file}
	var destination *os.File
	if request.Operation != "verify" && request.Operation != "doctor" {
		destination, err = newOutput(request.OutputPath, request.InputPath)
		if err != nil {
			return failure(err)
		}
		complete := false
		defer func() {
			_ = destination.Close()
			if !complete || !response.OK {
				_ = os.Remove(request.OutputPath)
			}
		}()
		// The final response owns successful publication; incomplete/error output is
		// always removed, including errors after the stream has finished.
		defer func() { complete = response.OK }()
	} else if request.OutputPath != "" {
		return Response{Error: "invalid_request"}
	}
	var target io.Writer = io.Discard
	hasher := sha256.New()
	if destination != nil {
		target = io.MultiWriter(destination, hasher)
	}
	bounded := &limitWriter{ctx: ctx, writer: target, remaining: MaximumOutputBytes}
	scratch := newScratchFactory(ctx)
	defer scratch.clear()
	options := fairplay.StreamOptions{Models: request.Models, StripAccountData: request.StripAccountData, MaxMemberBytes: fairplay.MaximumPortableArchiveBytes, Scratch: scratch.create}
	switch request.Operation {
	case "strip_account_data":
		result, e := fairplay.StripAccountDataStream(reader, size, bounded, fairplay.MaximumPortableArchiveBytes)
		err = e
		value.AccountDataStripped = true
		value.RemovedLicenseFiles = result.RemovedLicenseFiles
		value.RemovedMetadataFields = result.RemovedMetadataFields
	case "convert_ipa_macos":
		result, e := fairplay.ConvertMacOSIPAStream(reader, size, bounded, request.Models, fairplay.MaximumPortableArchiveBytes)
		err = e
		value.ConvertedRecords = result.ConvertedRecords
		value.ConvertedReplicas = result.ConvertedReplicas
	default:
		if request.Operation == "doctor" && len(request.Models) == 0 {
			result, report, e := fairplay.InspectStream(reader, size, options)
			clear(report)
			err = e
			value.EncryptedImages = result.EncryptedImages
			value.DecryptedPages = result.DecryptedPages
			break
		}
		if len(request.Models) == 0 {
			return Response{Error: "invalid_model"}
		}
		result, report, e := fairplay.DecryptStreamWithOptions(reader, size, bounded, options)
		clear(report)
		err = e
		value.PlaintextVerified = result.PlaintextVerified
		value.EncryptedImages = result.EncryptedImages
		value.DecryptedPages = result.DecryptedPages
		value.AccountDataStripped = result.AccountDataStripped
		value.RemovedLicenseFiles = result.RemovedLicenseFiles
		value.RemovedMetadataFields = result.RemovedMetadataFields
	}
	if err != nil {
		return failure(err)
	}
	if err = ctx.Err(); err != nil {
		return failure(err)
	}
	if destination != nil {
		if err = destination.Sync(); err != nil {
			return failure(err)
		}
		if err = destination.Close(); err != nil {
			return failure(err)
		}
		value.OutputPath = request.OutputPath
		value.OutputSHA256 = hex.EncodeToString(hasher.Sum(nil))
	}
	value.Ready = request.Operation != "doctor" || len(request.Models) > 0
	return Response{OK: true, Value: &value}
}

// ValidRequestID accepts only bounded nonzero UUID identifiers, never paths,
// account data or arbitrary cancellation-map keys.
func ValidRequestID(value string) bool {
	if len(value) != 36 {
		return false
	}
	nonzero := false
	for i, b := range []byte(value) {
		if i == 8 || i == 13 || i == 18 || i == 23 {
			if b != '-' {
				return false
			}
			continue
		}
		if !(b >= '0' && b <= '9' || b >= 'a' && b <= 'f' || b >= 'A' && b <= 'F') {
			return false
		}
		nonzero = nonzero || b != '0'
	}
	return nonzero
}
