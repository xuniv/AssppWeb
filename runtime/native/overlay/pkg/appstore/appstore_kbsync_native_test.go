package appstore

import (
	"bytes"
	"context"
	"errors"
	"testing"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/kbsync"
)

func TestNativeKBSyncGeneratorUsesBoundedNativePacket(t *testing.T) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	// No public assets are configured: packet generation must be self contained.
	first, err := defaultKBSyncGenerator(context.Background(), hardware, 1)
	if err != nil {
		t.Fatal(err)
	}
	if len(first) != kbsync.PacketSize {
		t.Fatalf("unexpected packet size %d", len(first))
	}
	if err = kbsync.Validate(1, hardware, first); err != nil {
		t.Fatal(err)
	}
	second, err := defaultKBSyncGenerator(context.Background(), hardware, 1)
	if err != nil {
		t.Fatal(err)
	}
	if bytes.Equal(first, second) {
		t.Fatal("reused random packet")
	}
}

func TestNativeKBSyncGeneratorPreservesTypedFailures(t *testing.T) {
	hardware := []byte{2, 0, 0, 0, 0, 1}
	if data, err := defaultKBSyncGenerator(nil, hardware, 1); err == nil || data != nil {
		t.Fatal("accepted nil context")
	}
	canceled, cancel := context.WithCancel(context.Background())
	cancel()
	if data, err := defaultKBSyncGenerator(canceled, hardware, 1); !errors.Is(err, context.Canceled) || data != nil {
		t.Fatalf("cancellation lost: %v", err)
	}
	expired, stop := context.WithDeadline(context.Background(), time.Unix(1, 0))
	defer stop()
	if data, err := defaultKBSyncGenerator(expired, hardware, 1); !errors.Is(err, context.DeadlineExceeded) || data != nil {
		t.Fatalf("deadline lost: %v", err)
	}
	if data, err := defaultKBSyncGenerator(context.Background(), hardware, 0); !errors.Is(err, kbsync.ErrInput) || data != nil {
		t.Fatalf("invalid DSID lost: %v", err)
	}
	for _, n := range []int{0, 1, 5, 7, 20} {
		if data, err := defaultKBSyncGenerator(context.Background(), make([]byte, n), 1); !errors.Is(err, kbsync.ErrInput) || data != nil {
			t.Fatalf("hardware length %d accepted: %v", n, err)
		}
	}
}
