package appstore

import (
	"context"
	"errors"
	"fmt"

	"github.com/majd/ipatool/v2/internal/sap/kbsync"
)

// nativeKBSyncGenerator replaces only packet construction. Account binding,
// download requests, cache lifetime and typed Store failures stay upstream.
func nativeKBSyncGenerator(ctx context.Context, hardwareID []byte, dsid uint64) ([]byte, error) {
	if ctx == nil {
		return nil, errors.New("kbsync context is nil")
	}
	if err := ctx.Err(); err != nil {
		return nil, fmt.Errorf("generate kbsync: %w", err)
	}
	data, err := kbsync.Generate(dsid, hardwareID)
	if err != nil {
		return nil, fmt.Errorf("generate kbsync: %w", err)
	}
	if err = ctx.Err(); err != nil {
		clear(data)
		return nil, fmt.Errorf("generate kbsync: %w", err)
	}
	return data, nil
}
