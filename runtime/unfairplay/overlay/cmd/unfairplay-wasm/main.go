package main

import (
	"encoding/json"
	"fmt"
	"github.com/DrWhax/unfairplay/pkg/fairplay"
	"io"
	"runtime"
	"runtime/debug"
	"syscall/js"
	"time"
)

var host js.Value
var staging js.Value

func await(p js.Value) (js.Value, error) {
	ch := make(chan struct{})
	var value js.Value
	var failure error
	ok := js.FuncOf(func(_ js.Value, a []js.Value) any { value = a[0]; close(ch); return nil })
	bad := js.FuncOf(func(_ js.Value, _ []js.Value) any {
		failure = fmt.Errorf("private storage unavailable")
		close(ch)
		return nil
	})
	p.Call("then", ok, bad)
	<-ch
	ok.Release()
	bad.Release()
	return value, failure
}

var stagedInputBytes int

type inputReader struct{}

func (inputReader) ReadAt(p []byte, at int64) (n int, err error) {
	defer func() {
		if recover() != nil {
			err = io.ErrUnexpectedEOF
		}
	}()
	for len(p) > 0 {
		count := min(len(p), 65536)
		data := host.Call("readInput", float64(at), count)
		copied := js.CopyBytesToGo(p[:count], data)
		stagedInputBytes += copied
		if stagedInputBytes >= 4<<20 {
			stagedInputBytes = 0
			runtime.GC()
			time.Sleep(time.Millisecond)
		}
		n += copied
		at += int64(copied)
		p = p[copied:]
		if copied < count {
			return n, io.EOF
		}
	}
	return n, nil
}

type scratch struct {
	id     int
	offset int64
	closed bool
}

func (f *scratch) ReadAt(p []byte, at int64) (n int, err error) {
	defer func() {
		if recover() != nil {
			err = io.ErrUnexpectedEOF
		}
	}()
	for len(p) > 0 {
		count := min(len(p), 65536)
		data := host.Call("readScratch", f.id, float64(at), count)
		copied := js.CopyBytesToGo(p[:count], data)
		n += copied
		at += int64(copied)
		p = p[copied:]
		if copied < count {
			return n, io.EOF
		}
	}
	return n, nil
}
func (f *scratch) WriteAt(p []byte, at int64) (n int, err error) {
	defer func() {
		if recover() != nil {
			err = io.ErrShortWrite
		}
	}()
	for len(p) > 0 {
		count := min(len(p), 65536)
		view := staging.Call("subarray", 0, count)
		js.CopyBytesToJS(view, p[:count])
		got := host.Call("writeScratch", f.id, float64(at), view).Int()
		n += got
		at += int64(got)
		p = p[got:]
		if got != count {
			return n, io.ErrShortWrite
		}
	}
	return n, nil
}
func (f *scratch) Write(p []byte) (int, error) {
	n, e := f.WriteAt(p, f.offset)
	f.offset += int64(n)
	return n, e
}
func (f *scratch) Truncate(n int64) (err error) {
	defer func() {
		if recover() != nil {
			err = io.ErrShortWrite
		}
	}()
	host.Call("truncateScratch", f.id, float64(n))
	return nil
}
func (f *scratch) Close() error {
	if !f.closed {
		f.closed = true
		host.Call("closeScratch", f.id)
	}
	return nil
}
func openScratch(size int64) (fairplay.StreamFile, error) {
	id, err := await(host.Call("openScratch", float64(size)))
	if err != nil {
		return nil, err
	}
	return &scratch{id: id.Int()}, nil
}

type outputWriter struct{ offset int64 }

func (w *outputWriter) Write(p []byte) (n int, err error) {
	defer func() {
		if recover() != nil {
			err = io.ErrShortWrite
		}
	}()
	for len(p) > 0 {
		count := min(len(p), 65536)
		view := staging.Call("subarray", 0, count)
		js.CopyBytesToJS(view, p[:count])
		got := host.Call("writeOutput", float64(w.offset), view).Int()
		n += got
		w.offset += int64(got)
		p = p[got:]
		if got != count {
			return n, io.ErrShortWrite
		}
	}
	return n, nil
}

type request struct {
	Operation string `json:"operation"`
	Size      int64  `json:"size"`
	Models    int    `json:"models"`
	Strip     bool   `json:"stripAccountData"`
}

func execute(encoded string) (any, error) {
	var req request
	if json.Unmarshal([]byte(encoded), &req) != nil {
		return nil, fmt.Errorf("invalid input")
	}
	if req.Models < 0 || req.Models > 256 || req.Size < 0 || req.Size > fairplay.MaximumPortableArchiveBytes {
		return nil, fmt.Errorf("invalid input")
	}
	packs := make([][]byte, req.Models)
	defer func() {
		for _, p := range packs {
			clear(p)
		}
	}()
	for i := range packs {
		value := host.Call("readModel", i)
		if value.Get("byteLength").Int() > 8708 {
			return nil, fmt.Errorf("invalid model")
		}
		packs[i] = make([]byte, value.Get("byteLength").Int())
		js.CopyBytesToGo(packs[i], value)
	}
	if req.Operation == "model_inspect" {
		infos := make([]fairplay.PortableModelInfo, len(packs))
		for i, p := range packs {
			info, err := fairplay.InspectPortableModel(p)
			if err != nil {
				return nil, err
			}
			infos[i] = info
		}
		if len(infos) == 0 {
			return nil, fmt.Errorf("missing model")
		}
		return map[string]any{"models": infos, "registryCompatible": fairplay.ValidatePortableModels(packs) == nil}, nil
	}
	if err := fairplay.ValidatePortableModels(packs); err != nil {
		return nil, err
	}
	options := fairplay.StreamOptions{Models: packs, StripAccountData: req.Strip, MaxMemberBytes: fairplay.MaximumPortableArchiveBytes, Scratch: openScratch}
	var out io.Writer = &outputWriter{}
	var result fairplay.DecryptResult
	var report []byte
	var err error
	switch req.Operation {
	case "doctor":
		if len(packs) == 0 {
			result, report, err = fairplay.InspectStream(inputReader{}, req.Size, options)
		} else {
			result, report, err = fairplay.DecryptStreamWithOptions(inputReader{}, req.Size, io.Discard, options)
		}
	case "verify":
		result, report, err = fairplay.DecryptStreamWithOptions(inputReader{}, req.Size, io.Discard, options)
	case "decrypt":
		result, report, err = fairplay.DecryptStreamWithOptions(inputReader{}, req.Size, out, options)
	case "strip_account_data":
		value, e := fairplay.StripAccountDataStream(inputReader{}, req.Size, out, fairplay.MaximumPortableArchiveBytes)
		if e != nil {
			return nil, e
		}
		summary := map[string]any{"plaintextVerified": false, "removedLicenseFiles": value.RemovedLicenseFiles, "removedMetadataFields": value.RemovedMetadataFields}
		report, _ := json.Marshal(summary)
		clear(report)
		return summary, nil
	case "convert_ipa_macos":
		value, e := fairplay.ConvertMacOSIPAStream(inputReader{}, req.Size, out, packs, fairplay.MaximumPortableArchiveBytes)
		if e != nil {
			return nil, e
		}
		summary := map[string]any{"plaintextVerified": false, "convertedRecords": value.ConvertedRecords, "convertedReplicas": value.ConvertedReplicas}
		report, _ := json.Marshal(summary)
		clear(report)
		return summary, nil
	default:
		return nil, fmt.Errorf("invalid operation")
	}
	if err != nil {
		clear(report)
		return nil, err
	}
	clear(report)
	return map[string]any{"plaintextVerified": result.PlaintextVerified, "encryptedImages": result.EncryptedImages, "decryptedPages": result.DecryptedPages, "ready": req.Operation != "doctor" || len(packs) > 0}, nil
}
func main() {
	debug.SetMemoryLimit(96 << 20)
	debug.SetGCPercent(50)
	host = js.Global().Get("assppUnfairHost")
	staging = js.Global().Get("Uint8Array").New(65536)
	run := js.FuncOf(func(_ js.Value, args []js.Value) any {
		input := args[0].String()
		executor := js.FuncOf(func(_ js.Value, callbacks []js.Value) any {
			resolve, reject := callbacks[0], callbacks[1]
			go func() {
				defer func() {
					if recover() != nil {
						reject.Invoke("unfairplay_operation_failed")
					}
				}()
				value, err := execute(input)
				if err != nil {
					reject.Invoke("unfairplay_operation_failed")
					return
				}
				encoded, _ := json.Marshal(value)
				resolve.Invoke(string(encoded))
			}()
			return nil
		})
		promise := js.Global().Get("Promise").New(executor)
		executor.Release()
		return promise
	})
	js.Global().Set("assppUnfairRun", run)
	select {}
}
