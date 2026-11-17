package appstore

import (
	"errors"
	"net/url"
	"testing"

	"github.com/majd/ipatool/v2/internal/browsernet"
	"github.com/majd/ipatool/v2/pkg/http"
	"go.uber.org/mock/gomock"
)

// Exercise the actual pinned SDK route used before download version selection.
// A storefront missing from Apple's list must reach the public genre catalog.
// The transport policy is evaluated on the SDK request, with no network access.
func TestRuntimeCatalogResolvesOmittedDownloadStorefront(t *testing.T) {
	client := http.NewMockClient[[]byte](gomock.NewController(t))
	store := &appstore{storefrontClient: client}
	var hosts []string
	client.EXPECT().Send(gomock.Any()).DoAndReturn(func(req http.Request) (http.Result[[]byte], error) {
		address, err := url.Parse(req.URL)
		if err != nil {
			return http.Result[[]byte]{}, err
		}
		if !browsernet.Allowed(address.Hostname()) {
			return http.Result[[]byte]{}, errors.New("public Store catalog blocked by runtime transport")
		}
		hosts = append(hosts, address.Hostname())
		if address.Hostname() == "itunes.apple.com" {
			return http.Result[[]byte]{StatusCode: 200, Data: []byte(`<plist version="1.0"><dict><key>storefronts</key><array><dict><key>country-code</key><string>US</string><key>id</key><integer>143441</integer></dict></array></dict></plist>`)}, nil
		}
		if req.URL != "https://apps.apple.com/genre/id36" || req.Headers["X-Apple-Store-Front"] != "143466-2,29" || !req.NoRedirects {
			t.Fatal("SDK catalog route changed")
		}
		return http.Result[[]byte]{StatusCode: 200, Data: []byte(`{"storePlatformData":{"genre":{"meta":{"storefront":{"cc":"KR","id":"143466"}}}}}`)}, nil
	}).Times(2)
	country, err := store.countryCodeFromStoreFront("143466-1,29")
	if err != nil {
		t.Fatal(err)
	}
	if country != "KR" || len(hosts) != 2 || hosts[0] != "itunes.apple.com" || hosts[1] != "apps.apple.com" {
		t.Fatalf("unexpected catalog route: %q %v", country, hosts)
	}
}
