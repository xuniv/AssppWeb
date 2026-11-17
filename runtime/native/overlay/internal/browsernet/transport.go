// Package browsernet preserves the runtime transport interface for native Go.
// TCP and verified TLS execute directly in the app process.
package browsernet

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	_ "embed"
	"errors"
	"net"
	"net/http"
	"strings"
	"time"
)

//go:embed roots.crt
var certificates []byte

func Allowed(host string) bool {
	return host == "itunes.apple.com" || strings.HasSuffix(host, ".itunes.apple.com") ||
		host == "mzstatic.com" || strings.HasSuffix(host, ".mzstatic.com") ||
		host == "apps.apple.com" || host == "gsa.apple.com" || host == "www.apple.com" || host == "updates.cdn-apple.com" ||
		host == "mesu.apple.com" || host == "wkms-public.apple.com" || host == "fcs-keys-pub-prod.cdn-apple.com"
}
func dial(ctx context.Context, network, target string) (net.Conn, error) {
	host, port, err := net.SplitHostPort(target)
	if err != nil || network != "tcp" || port != "443" || !Allowed(host) {
		return nil, errors.New("unapproved Apple TCP destination")
	}
	return (&net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}).DialContext(ctx, network, target)
}
func NewTransport() *http.Transport {
	roots := x509.NewCertPool()
	if !roots.AppendCertsFromPEM(certificates) {
		panic("public CA bundle is invalid")
	}
	return &http.Transport{DialContext: dial, TLSClientConfig: &tls.Config{MinVersion: tls.VersionTLS12, RootCAs: roots}, TLSHandshakeTimeout: 30 * time.Second, ResponseHeaderTimeout: 30 * time.Second, IdleConnTimeout: 90 * time.Second, MaxIdleConns: 8, ForceAttemptHTTP2: false}
}
