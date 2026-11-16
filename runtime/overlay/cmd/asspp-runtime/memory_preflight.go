package main

import (
	"context"
	"encoding/binary"
	"errors"
	"github.com/majd/ipatool/v2/internal/sap/unicorn"
	"time"
)

// Two simultaneous guests with identical pages must remain isolated when the
// host or CPU modifies one copy, including translated self-modifying code.
func memoryPreflight(ctx context.Context) (any, error) {
	a, err := unicorn.New(ctx)
	if err != nil {
		return nil, err
	}
	defer a.Close()
	b, err := unicorn.New(ctx)
	if err != nil {
		return nil, err
	}
	defer b.Close()
	for _, engine := range []*unicorn.Engine{a, b} {
		for _, address := range []uint64{0x1000, 0x2000, 0x3000} {
			if err = engine.MemMap(address, 4096); err != nil {
				return nil, err
			}
		}
		code := make([]byte, 8)
		binary.LittleEndian.PutUint32(code, 0xf9000280)
		binary.LittleEndian.PutUint32(code[4:], 0xd61f02a0)
		if err = engine.MemWrite(0x1000, code); err != nil {
			return nil, err
		}
		if err = engine.MemWrite(0x2000, []byte{11, 0, 0, 0, 0, 0, 0, 0}); err != nil {
			return nil, err
		}
		if err = engine.SealSharedPages(); err != nil {
			return nil, err
		}
	}
	if err = a.MemWrite(0x2000, []byte{73}); err != nil {
		return nil, err
	}
	original, err := b.MemRead(0x2000, 1)
	if err != nil {
		return nil, err
	}
	if original[0] != 11 {
		return nil, errors.New("host write crossed guest boundary")
	}
	for register, value := range map[int]uint64{unicorn.RegX0: 74, unicorn.RegX0 + 20: 0x2000, unicorn.RegX0 + 21: 0x3000} {
		if err = b.RegWrite(register, value); err != nil {
			return nil, err
		}
	}
	callbacks := 0
	if _, err = b.AddCodeHook(0x1000, 0x1000, func(uint64, uint32) { callbacks++ }); err != nil {
		return nil, err
	}
	if err = b.StartBounded(0x1000, 0x3000, time.Minute, 100); err != nil {
		return nil, err
	}
	if callbacks != 1 {
		return nil, errors.New("copy-on-write retry delivered a callback twice")
	}
	left, err := a.MemRead(0x2000, 1)
	if err != nil {
		return nil, err
	}
	right, err := b.MemRead(0x2000, 1)
	if err != nil {
		return nil, err
	}
	if left[0] != 73 || right[0] != 74 {
		return nil, errors.New("CPU write crossed guest boundary")
	}
	return map[string]bool{"isolated": true}, nil
}
