package main

/*
#include <stdlib.h>
#include <string.h>
*/
import "C"

import (
	"context"
	"encoding/json"
	"errors"
	"sync"
	"time"
	"unsafe"

	"github.com/majd/ipatool/v2/internal/assppunfair"
)

var unfairCancelState = struct {
	sync.Mutex
	active  map[string]context.CancelFunc
	pending map[string]time.Time
	queued  int
}{active: make(map[string]context.CancelFunc), pending: make(map[string]time.Time)}

func pruneUnfairPending(now time.Time) {
	for id, expires := range unfairCancelState.pending {
		if !now.Before(expires) {
			delete(unfairCancelState.pending, id)
		}
	}
}
func registerUnfairCancel(id string, cancel context.CancelFunc) error {
	unfairCancelState.Lock()
	defer unfairCancelState.Unlock()
	pruneUnfairPending(time.Now())
	if _, exists := unfairCancelState.pending[id]; exists {
		delete(unfairCancelState.pending, id)
		cancel()
		return context.Canceled
	}
	if _, exists := unfairCancelState.active[id]; exists || unfairCancelState.queued >= 16 {
		return errors.New("request queue is full")
	}
	if id != "" {
		unfairCancelState.active[id] = cancel
	}
	unfairCancelState.queued++
	return nil
}
func removeUnfairCancel(id string) {
	unfairCancelState.Lock()
	delete(unfairCancelState.active, id)
	unfairCancelState.queued--
	unfairCancelState.Unlock()
}

//export asspp_unfairplay_call
func asspp_unfairplay_call(input *C.char) (output *C.char) {
	defer func() {
		if recover() != nil {
			output = C.CString(`{"ok":false,"error":"processing_failed"}`)
		}
	}()
	if input == nil || C.strnlen(input, assppunfair.MaximumRequestBytes+1) > assppunfair.MaximumRequestBytes {
		return C.CString(`{"ok":false,"error":"invalid_request"}`)
	}
	encodedInput := []byte(C.GoString(input))
	defer clear(encodedInput)
	var identity struct {
		RequestID string `json:"requestID"`
	}
	if json.Unmarshal(encodedInput, &identity) != nil || identity.RequestID != "" && !assppunfair.ValidRequestID(identity.RequestID) {
		return C.CString(`{"ok":false,"error":"invalid_request"}`)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	if err := registerUnfairCancel(identity.RequestID, cancel); err != nil {
		if errors.Is(err, context.Canceled) {
			return C.CString(`{"ok":false,"error":"canceled"}`)
		}
		return C.CString(`{"ok":false,"error":"invalid_request"}`)
	}
	defer removeUnfairCancel(identity.RequestID)
	// Registration precedes the shared operation gate so queued work can be
	// canceled without interrupting Store calls or unrelated file operations.
	nativeGate.Lock()
	defer nativeGate.Unlock()
	result := assppunfair.Execute(ctx, encodedInput)
	encoded, err := json.Marshal(result)
	if err != nil || len(encoded) > assppunfair.MaximumResponseBytes {
		return C.CString(`{"ok":false,"error":"processing_failed"}`)
	}
	return C.CString(string(encoded))
}

//export asspp_unfairplay_free
func asspp_unfairplay_free(value *C.char) { C.free(unsafe.Pointer(value)) }

//export asspp_unfairplay_cancel
func asspp_unfairplay_cancel(value *C.char) {
	if value == nil || C.strnlen(value, 37) != 36 {
		return
	}
	id := C.GoString(value)
	if !assppunfair.ValidRequestID(id) {
		return
	}
	unfairCancelState.Lock()
	pruneUnfairPending(time.Now())
	cancel := unfairCancelState.active[id]
	if cancel == nil && len(unfairCancelState.pending) < 16 {
		unfairCancelState.pending[id] = time.Now().Add(30 * time.Second)
	}
	unfairCancelState.Unlock()
	if cancel != nil {
		cancel()
	}
}
