package main

import (
	"encoding/json"
	"github.com/majd/ipatool/v2/internal/sap/assets"
	"io"
	"os"
	"time"
)

// One operation per process for the explicitly configured private server mode.
// Protocol data goes only to stdout; errors use the same fixed-code JSON envelope.
func runCLI() {
	deadline := time.AfterFunc(5*time.Minute, func() { os.Exit(124) })
	defer deadline.Stop()
	failure := func(code string) { _ = json.NewEncoder(os.Stdout).Encode(response{Error: code}) }
	if len(os.Args) != 3 || os.Args[1] != "--stdio" {
		failure("invalid_request")
		return
	}
	if err := assets.ConfigurePublicDirectory(os.Args[2]); err != nil {
		failure("runtime_not_configured")
		return
	}
	input, err := io.ReadAll(io.LimitReader(os.Stdin, (8<<20)+1))
	if err != nil || len(input) > 8<<20 {
		failure("invalid_request")
		return
	}
	data, err := json.Marshal(execute(string(input)))
	if err != nil || len(data) > 12<<20 {
		failure("runtime_failed")
		return
	}
	_, _ = os.Stdout.Write(append(data, '\n'))
}
