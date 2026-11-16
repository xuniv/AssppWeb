// Browser adapter for ipatool's ARM64 guest. All execution stays in WebAssembly.
package unicorn

import (
	"context"
	"errors"
	"fmt"
	"strconv"
	"syscall/js"
	"time"
)

const (
	RegX29 = 1
	RegLR  = 2
	RegSP  = 4
	RegX0  = 199
	RegX1  = 200
	RegX2  = 201
	RegX3  = 202
	RegX4  = 203
	RegX5  = 204
	RegX6  = 205
	RegX7  = 206
	RegX14 = 213
	RegX15 = 214
	RegX16 = 215
	RegV0  = 228
	RegPC  = 260
)

type CodeHook func(uint64, uint32)
type MemoryFaultHook func(uint64, uint32) bool
type Engine struct {
	host         js.Value
	staging      js.Value
	hooks        []*Hook
	check        func(uint64, uint64) error
	ctx          context.Context
	stopped      bool
	closed       bool
	dispatch     func() ([]uint64, [][2]uint64)
	policyPoints map[uint64]struct{}
	policyRanges [][2]uint64
}
type Hook struct {
	engine   *Engine
	id       int
	callback CodeHook
	memory   MemoryFaultHook
	closed   bool
}

func New(ctx context.Context) (*Engine, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	return &Engine{host: js.Global().Get("assppUnicorn").Call("create"), staging: js.Global().Get("Uint8Array").New(65536), ctx: ctx}, nil
}
func address(v uint64) string { return strconv.FormatUint(v, 10) }
func (e *Engine) call(name string, args ...any) (result js.Value, err error) {
	if e.closed {
		return js.Undefined(), errors.New("emulator is closed")
	}
	defer func() {
		if recover() != nil {
			err = fmt.Errorf("WebAssembly emulator %s failed", name)
		}
	}()
	result = e.host.Call(name, args...)
	return
}
func (e *Engine) MemMap(a, n uint64) error {
	_, err := e.call("map", address(a), address(n))
	return err
}
func (e *Engine) MemUnmap(a, n uint64) error {
	_, err := e.call("unmap", address(a), address(n))
	return err
}
func (e *Engine) MemRead(a, n uint64) ([]byte, error) {
	if n > 128<<20 {
		return nil, errors.New("guest read exceeds limit")
	}
	if e.check != nil {
		if err := e.check(a, n); err != nil {
			return nil, err
		}
	}
	data := make([]byte, n)
	if err := e.MemReadInto(data, a); err != nil {
		return nil, err
	}
	return data, nil
}
func (e *Engine) MemReadInto(data []byte, a uint64) error {
	if len(data) > 128<<20 {
		return errors.New("guest read exceeds limit")
	}
	if e.check != nil {
		if err := e.check(a, uint64(len(data))); err != nil {
			return err
		}
	}
	for len(data) > 0 {
		count := min(len(data), 65536)
		value, err := e.call("read", address(a), count)
		if err != nil {
			return err
		}
		js.CopyBytesToGo(data[:count], value)
		a += uint64(count)
		data = data[count:]
	}
	return nil
}
func (e *Engine) MemWrite(a uint64, data []byte) error {
	if e.check != nil {
		if err := e.check(a, uint64(len(data))); err != nil {
			return err
		}
	}
	for len(data) > 0 {
		count := min(len(data), 64<<10)
		value := e.staging
		if count < 65536 {
			value = value.Call("subarray", 0, count)
		}
		js.CopyBytesToJS(value, data[:count])
		if _, err := e.call("write", address(a), value); err != nil {
			return err
		}
		a += uint64(count)
		data = data[count:]
	}
	return nil
}
func (e *Engine) RegRead(r int) (uint64, error) {
	value, err := e.call("regRead", r)
	if err != nil {
		return 0, err
	}
	return strconv.ParseUint(value.String(), 10, 64)
}
func (e *Engine) RegWrite(r int, v uint64) error {
	_, err := e.call("regWrite", r, address(v))
	return err
}
func (e *Engine) RegRead128(r int) (out [16]byte, err error) {
	value, err := e.call("regRead128", r)
	if err == nil {
		js.CopyBytesToGo(out[:], value)
	}
	return
}
func (e *Engine) RegWrite128(r int, v [16]byte) error {
	value := js.Global().Get("Uint8Array").New(16)
	js.CopyBytesToJS(value, v[:])
	_, err := e.call("regWrite128", r, value)
	return err
}
func (e *Engine) AddCodeHook(a, b uint64, fn CodeHook) (*Hook, error) {
	h := &Hook{engine: e, id: len(e.hooks), callback: fn}
	e.hooks = append(e.hooks, h)
	_, err := e.call("hook", h.id, address(a), address(b))
	return h, err
}
func (e *Engine) AddMemoryFaultHook(fn MemoryFaultHook) (*Hook, error) {
	h := &Hook{engine: e, id: len(e.hooks), memory: fn}
	e.hooks = append(e.hooks, h)
	_, err := e.call("memoryHook", h.id)
	return h, err
}
func (h *Hook) Close() error {
	if h.closed {
		return nil
	}
	h.closed = true
	_, err := h.engine.call("removeHook", h.id)
	return err
}
func (e *Engine) GuardMemory(fn func(uint64, uint64) error) error {
	e.check = fn
	return errors.New("strict guest validation is unavailable in browser mode")
}

// SetDispatchSource avoids crossing the JS/Go boundary for ordinary guest
// instructions. The JS hook still validates every executed address.
func (e *Engine) SetDispatchSource(fn func() ([]uint64, [][2]uint64)) { e.dispatch = fn }
func (e *Engine) SealSharedPages() error                              { _, err := e.call("seal"); return err }
func (e *Engine) Start(a, b uint64) error                             { return e.StartBounded(a, b, 5*time.Minute, 0) }
func (e *Engine) StartBounded(a, b uint64, timeout time.Duration, count uint64) error {
	deadline := time.Now().Add(max(timeout, 5*time.Minute))
	e.stopped = false
	var executed uint64
	lastYield := time.Now()
	for {
		// Return to the JS event loop regularly. Go's own Gosched cannot let
		// WebKit run GC, IPC completions or its responsiveness watchdog.
		if time.Since(lastYield) >= 32*time.Millisecond {
			time.Sleep(time.Millisecond)
			lastYield = time.Now()
		}
		if err := e.ctx.Err(); err != nil {
			return err
		}
		if time.Now().After(deadline) {
			return errors.New("WebAssembly emulation timed out")
		}
		if e.dispatch != nil {
			points, ranges := e.dispatch()
			same := len(points) == len(e.policyPoints) && len(ranges) == len(e.policyRanges) && e.policyPoints != nil
			if same {
				for _, point := range points {
					if _, ok := e.policyPoints[point]; !ok {
						same = false
						break
					}
				}
			}
			if same {
				for i, region := range ranges {
					if region != e.policyRanges[i] {
						same = false
						break
					}
				}
			}
			if !same {
				e.policyPoints = make(map[uint64]struct{}, len(points))
				for _, point := range points {
					e.policyPoints[point] = struct{}{}
				}
				e.policyRanges = append(e.policyRanges[:0], ranges...)
				p := make([]any, len(points))
				for i, v := range points {
					p[i] = address(v)
				}
				regions := make([]any, len(ranges))
				for i, v := range ranges {
					regions[i] = []any{address(v[0]), address(v[1])}
				}
				if _, err := e.call("policy", p, regions); err != nil {
					return err
				}
			}
		}
		result, err := e.call("start", address(a), address(b), address(count))
		if err != nil {
			return err
		}
		if result.Get("error").String() != "" {
			return errors.New(result.Get("error").String())
		}
		events := result.Get("events")
		for i := 0; i < events.Length(); i++ {
			event := events.Index(i)
			index := event.Get("id").Int()
			h := e.hooks[index]
			at, _ := strconv.ParseUint(event.Get("address").String(), 10, 64)
			size := uint32(event.Get("size").Int())
			if h.memory != nil {
				if !h.memory(at, size) {
					return errors.New("unmapped guest memory")
				}
			} else {
				h.callback(at, size)
			}
		}
		if e.stopped {
			return nil
		}
		pc, err := e.RegRead(RegPC)
		if err != nil {
			return err
		}
		if pc == b {
			return nil
		}
		a = pc
		executed += uint64(result.Get("steps").Int())
		if count != 0 && executed >= count {
			return nil
		}
	}
}
func (e *Engine) Stop() error { e.stopped = true; return nil }
func (e *Engine) Close() error {
	if e.closed {
		return nil
	}
	_, err := e.call("close")
	e.closed = true
	return err
}
