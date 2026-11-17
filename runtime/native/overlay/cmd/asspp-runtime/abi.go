package main

/*
#include <stdlib.h>
#include <string.h>
*/
import "C"

import (
	"encoding/json"
	"net/http"
	"path/filepath"
	"runtime"
	"runtime/debug"
	"sync"
	"unsafe"

	"github.com/majd/ipatool/v2/internal/browsernet"
	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/rs/zerolog"
)

var nativeGate sync.Mutex
var configured bool

func init() {
	debug.SetMemoryLimit(128 << 20)
	debug.SetGCPercent(25)
	zerolog.SetGlobalLevel(zerolog.Disabled)
	http.DefaultTransport = browsernet.NewTransport()
}

//export asspp_runtime_configure
func asspp_runtime_configure(path *C.char) (code C.int) {
	defer func() {
		if recover() != nil {
			code = 1
		}
	}()
	nativeGate.Lock()
	defer nativeGate.Unlock()
	if path == nil || C.strnlen(path, 4097) > 4096 {
		return 1
	}
	directory := C.GoString(path)
	if !filepath.IsAbs(directory) {
		return 1
	}
	if configured {
		if assets.PublicDirectory() == directory {
			return 0
		}
		return 2
	}
	if err := assets.ConfigurePublicDirectory(directory); err != nil {
		return 1
	}
	configured = true
	return 0
}

//export asspp_runtime_call
func asspp_runtime_call(input *C.char) (output *C.char) {
	defer func() {
		if recover() != nil {
			output = C.CString(`{"ok":false,"error":"runtime_failed","state":{}}`)
		}
	}()
	nativeGate.Lock()
	defer nativeGate.Unlock()
	if !configured {
		return C.CString(`{"ok":false,"error":"runtime_not_configured","state":{}}`)
	}
	if input == nil || C.strnlen(input, (8<<20)+1) > 8<<20 {
		return C.CString(`{"ok":false,"error":"invalid_request","state":{}}`)
	}
	result := execute(C.GoString(input))
	data, err := json.Marshal(result)
	if err != nil || len(data) > 12<<20 {
		return C.CString(`{"ok":false,"error":"runtime_failed","state":{}}`)
	}
	runtime.GC()
	return C.CString(string(data))
}

//export asspp_runtime_free
func asspp_runtime_free(value *C.char) { C.free(unsafe.Pointer(value)) }

func main() { runCLI() }
