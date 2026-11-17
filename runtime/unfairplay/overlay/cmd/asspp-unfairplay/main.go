package main

import (
	"context"
	"encoding/json"
	"io"
	"os"
	"runtime/debug"
	"time"

	"github.com/DrWhax/unfairplay/internal/assppunfair"
)

func main() {
	debug.SetMemoryLimit(256 << 20)
	deadline := time.AfterFunc(10*time.Minute, func() { os.Exit(124) })
	defer deadline.Stop()
	response := assppunfair.Response{Error: "invalid_request"}
	if len(os.Args) == 2 && os.Args[1] == "--stdio" && applyOutputLimit() == nil {
		input, err := io.ReadAll(io.LimitReader(os.Stdin, assppunfair.MaximumRequestBytes+1))
		if err == nil && len(input) <= assppunfair.MaximumRequestBytes {
			ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
			response = assppunfair.Execute(ctx, input)
			cancel()
			clear(input)
		}
	}
	encoded, err := json.Marshal(response)
	if err != nil || len(encoded) > assppunfair.MaximumResponseBytes {
		encoded = []byte(`{"ok":false,"error":"processing_failed"}`)
	}
	_, _ = os.Stdout.Write(append(encoded, '\n'))
}
