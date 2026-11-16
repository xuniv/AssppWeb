package main

import (
	"bytes"
	"context"
	"encoding/binary"
	"errors"
	"time"

	"github.com/majd/ipatool/v2/internal/sap/unicorn"
)

// Two consecutive calls to one host stub must invoke its callback twice even
// when the callback redirects PC. This fixture contains no Apple/account data.
func bridgePreflight(ctx context.Context) (any, error) {
	engine, err := unicorn.New(ctx)
	if err != nil {
		return nil, err
	}
	defer engine.Close()
	if err = engine.MemMap(0x1000, 0x3000); err != nil {
		return nil, err
	}
	// Native anonymous mappings are zero-filled, including after address reuse.
	// Probe the middle of a recycled page rather than allocator metadata at zero.
	if err = engine.MemWrite(0x2000, bytes.Repeat([]byte{0xa5}, 0x1000)); err != nil {
		return nil, err
	}
	if err = engine.MemUnmap(0x2000, 0x1000); err != nil {
		return nil, err
	}
	if err = engine.MemMap(0x2000, 0x1000); err != nil {
		return nil, err
	}
	clean, err := engine.MemRead(0x2800, 64)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(clean, make([]byte, len(clean))) {
		return nil, errors.New("recycled guest memory was not zero-filled")
	}
	instructions := []uint32{0x94000400, 0xaa0003f3, 0x940003fe, 0x8b000260, 0xd61f0280}
	code := make([]byte, len(instructions)*4)
	for i, instruction := range instructions {
		binary.LittleEndian.PutUint32(code[i*4:], instruction)
	}
	if err = engine.MemWrite(0x1000, code); err != nil {
		return nil, err
	}
	if err = engine.MemWrite(0x2000, []byte{0xc0, 0x03, 0x5f, 0xd6}); err != nil {
		return nil, err
	}
	if err = engine.RegWrite(unicorn.RegX0+20, 0x3000); err != nil {
		return nil, err
	}
	calls := uint64(0)
	_, err = engine.AddCodeHook(0x2000, 0x2000, func(uint64, uint32) {
		calls++
		if err = engine.RegWrite(unicorn.RegX0, calls*10); err != nil {
			_ = engine.Stop()
			return
		}
		var link uint64
		link, err = engine.RegRead(unicorn.RegLR)
		if err == nil {
			err = engine.RegWrite(unicorn.RegPC, link)
		}
		if err != nil {
			_ = engine.Stop()
		}
	})
	if err != nil {
		return nil, err
	}
	execution := engine.StartBounded(0x1000, 0x3000, time.Minute, 100)
	if err != nil {
		return nil, err
	}
	if execution != nil {
		return nil, execution
	}
	value, err := engine.RegRead(unicorn.RegX0)
	if err != nil {
		return nil, err
	}
	if calls != 2 || value != 30 {
		return nil, errors.New("host bridge callback was skipped")
	}
	return map[string]uint64{"calls": calls, "value": value}, nil
}
