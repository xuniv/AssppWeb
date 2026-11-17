package browsernet

import (
	"context"
	"crypto/sha256"
	"fmt"
	"testing"
)

func TestNativeTransportKeepsPinnedTrustAndDestinationPolicy(t *testing.T) {
	if fmt.Sprintf("%x", sha256.Sum256(certificates)) != "aec261c5aa569a1fdef65e119eeb839cd9cfafc2641b9c8b15f168cbe18145ca" {
		t.Fatal("public root bundle changed")
	}
	transport := NewTransport()
	defer transport.CloseIdleConnections()
	if transport.Proxy != nil || transport.TLSClientConfig.RootCAs == nil || transport.TLSClientConfig.InsecureSkipVerify {
		t.Fatal("native TLS policy changed")
	}
	for _, target := range []string{"example.com:443", "127.0.0.1:443", "gsa.apple.com:80", "gsa.apple.com:444", "gsa.apple.com.:443"} {
		if _, err := dial(context.Background(), "tcp", target); err == nil {
			t.Fatalf("accepted forbidden destination %q", target)
		}
	}
	if !Allowed("gsa.apple.com") || !Allowed("p25-buy.itunes.apple.com") || Allowed("gsa.apple.com.example.com") {
		t.Fatal("Apple host policy changed")
	}
}
