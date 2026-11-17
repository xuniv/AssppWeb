// Package browsernet connects Go's verified TLS/HTTP stack to a client TCP
// stream. Browser Wisp and native Network.framework carry ciphertext only.
package browsernet

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"errors"
	"io"
	"net"
	"net/http"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"
)

// Mozilla's public roots plus the Apple Root CA used by GrandSlam, as in
// ipatool. This file contains public CA certificates, never signing identities.
//
//go:embed roots.crt
var certificates []byte

func Allowed(host string) bool {
	return host == "itunes.apple.com" || strings.HasSuffix(host, ".itunes.apple.com") ||
		host == "mzstatic.com" || strings.HasSuffix(host, ".mzstatic.com") ||
		host == "apps.apple.com" || host == "gsa.apple.com" || host == "www.apple.com" || host == "updates.cdn-apple.com" || host == "mesu.apple.com" || host == "wkms-public.apple.com" || host == "fcs-keys-pub-prod.cdn-apple.com"
}
func await(promise js.Value) (js.Value, error) {
	done := make(chan js.Value, 1)
	failed := make(chan struct{}, 1)
	success := js.FuncOf(func(_ js.Value, args []js.Value) any { done <- args[0]; return nil })
	failure := js.FuncOf(func(_ js.Value, _ []js.Value) any { failed <- struct{}{}; return nil })
	promise.Call("then", success, failure)
	defer success.Release()
	defer failure.Release()
	select {
	case result := <-done:
		return result, nil
	case <-failed:
		return js.Undefined(), errors.New("client TCP transport failed")
	}
}
func NewTransport() *http.Transport {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificates) {
		panic("public CA bundle is invalid")
	}
	return &http.Transport{DialContext: dial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 30 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 8, ForceAttemptHTTP2: false}
}

type connection struct {
	id       int
	mu       sync.Mutex
	closed   bool
	timer    *time.Timer
	deadline time.Time
	host     string
}
type address string

func (address) Network() string  { return "tcp" }
func (a address) String() string { return string(a) }
func dial(ctx context.Context, network, target string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(target)
	if err != nil || port != "443" || !Allowed(host) || network != "tcp" {
		return nil, errors.New("unapproved Apple TCP destination")
	}
	if err = ctx.Err(); err != nil {
		return nil, err
	}
	value, err := await(js.Global().Get("assppSocket").Call("open", host, 443))
	if err != nil {
		return nil, err
	}
	c := &connection{id: value.Int(), host: host}
	if err = ctx.Err(); err != nil {
		_ = c.Close()
		return nil, err
	}
	return c, nil
}
func (c *connection) Read(output []byte) (int, error) {
	if len(output) == 0 {
		return 0, nil
	}
	value, err := await(js.Global().Get("assppSocket").Call("read", c.id, min(len(output), 64<<10)))
	if err != nil {
		return 0, err
	}
	n := value.Get("byteLength").Int()
	if n == 0 {
		return 0, io.EOF
	}
	if n > len(output) {
		return 0, errors.New("TCP read exceeded requested length")
	}
	return js.CopyBytesToGo(output, value), nil
}
func (c *connection) Write(data []byte) (int, error) {
	if len(data) == 0 {
		return 0, nil
	}
	value := js.Global().Get("Uint8Array").New(len(data))
	js.CopyBytesToJS(value, data)
	count, err := await(js.Global().Get("assppSocket").Call("write", c.id, value))
	if err != nil {
		return 0, err
	}
	n := count.Int()
	if n < 0 || n > len(data) {
		return 0, errors.New("invalid TCP write length")
	}
	return n, nil
}
func (c *connection) Close() error {
	c.mu.Lock()
	if c.closed {
		c.mu.Unlock()
		return nil
	}
	c.closed = true
	if c.timer != nil {
		c.timer.Stop()
	}
	c.mu.Unlock()
	_, err := await(js.Global().Get("assppSocket").Call("close", c.id))
	return err
}
func (c *connection) LocalAddr() net.Addr { return address("client:0") }
func (c *connection) RemoteAddr() net.Addr {
	return address(net.JoinHostPort(c.host, strconv.Itoa(443)))
}
func (c *connection) SetDeadline(t time.Time) error {
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.timer != nil {
		c.timer.Stop()
	}
	c.deadline = t
	if !t.IsZero() {
		c.timer = time.AfterFunc(time.Until(t), func() { _ = c.Close() })
	}
	return nil
}
func (c *connection) SetReadDeadline(t time.Time) error  { return c.SetDeadline(t) }
func (c *connection) SetWriteDeadline(t time.Time) error { return c.SetDeadline(t) }
