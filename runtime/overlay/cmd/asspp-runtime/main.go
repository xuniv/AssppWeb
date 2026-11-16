// The client owns this process, its credentials and its persistent state.
package main

import (
	"context"
	"crypto/tls"
	"crypto/x509"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"io/fs"
	"net"
	"net/http"
	"net/http/cookiejar"
	"net/url"
	"regexp"
	"runtime"
	"runtime/debug"
	"strconv"
	"strings"
	"sync"
	"syscall/js"
	"time"

	"github.com/majd/ipatool/v2/internal/browsernet"
	"github.com/majd/ipatool/v2/internal/sap"
	"github.com/majd/ipatool/v2/internal/sap/assets"
	"github.com/majd/ipatool/v2/internal/sap/machine"
	"github.com/majd/ipatool/v2/internal/store/emulator"
	"github.com/majd/ipatool/v2/internal/store/profile"
	"github.com/majd/ipatool/v2/internal/storeauth"
	"github.com/majd/ipatool/v2/pkg/appstore"
	apphttp "github.com/majd/ipatool/v2/pkg/http"
	"github.com/majd/ipatool/v2/pkg/util/operatingsystem"
	"github.com/rs/zerolog"
)

type cookie struct {
	URL    string
	Cookie *http.Cookie
}
type state struct {
	Records map[string][]byte `json:"records"`
	Cookies []cookie          `json:"cookies"`
}
type keychain struct{ records map[string][]byte }

func (k keychain) Get(key string) ([]byte, error) {
	v, ok := k.records[key]
	if !ok {
		return nil, fs.ErrNotExist
	}
	return v, nil
}
func (k keychain) Set(key string, v []byte) error { k.records[key] = v; return nil }
func (k keychain) Remove(key string) error        { delete(k.records, key); return nil }

type jar struct {
	http.CookieJar
	entries []cookie
}

func (j *jar) SetCookies(u *url.URL, values []*http.Cookie) {
	j.CookieJar.SetCookies(u, values)
	for _, v := range values {
		next := j.entries[:0]
		for _, old := range j.entries {
			if old.URL == u.Scheme+"://"+u.Host+u.EscapedPath() && old.Cookie.Name == v.Name && old.Cookie.Path == v.Path && old.Cookie.Domain == v.Domain {
				continue
			}
			next = append(next, old)
		}
		j.entries = append(next, cookie{u.Scheme + "://" + u.Host + u.EscapedPath(), v})
	}
}
func (*jar) Save() error { return nil }

type identity string

func (i identity) MacAddress() (string, error) { return string(i), nil }
func (identity) HomeDirectory() string         { return "/client" }
func (identity) ReadPassword(int) ([]byte, error) {
	return nil, errors.New("interactive password reading is disabled")
}

type request struct {
	Operation             string           `json:"operation"`
	DeviceID              string           `json:"deviceID"`
	State                 state            `json:"state"`
	Account               appstore.Account `json:"account"`
	App                   appstore.App     `json:"app"`
	Email, Password, Code string
	VersionID             string `json:"versionID"`
	Platform              string `json:"platform"`
}
type response struct {
	OK     bool   `json:"ok"`
	Value  any    `json:"value,omitempty"`
	State  state  `json:"state"`
	Error  string `json:"error,omitempty"`
	Status int    `json:"status,omitempty"`
}

var gate sync.Mutex

// Return fixed diagnostic codes, never raw Apple or transport error text.
func failureCode(err error) string {
	var unknown x509.UnknownAuthorityError
	var hostname x509.HostnameError
	var verification *tls.CertificateVerificationError
	var operation *net.OpError
	switch {
	case errors.As(err, &unknown):
		return "tls_untrusted_certificate"
	case errors.As(err, &hostname):
		return "tls_hostname_mismatch"
	case errors.As(err, &verification):
		return "tls_certificate_failed"
	case errors.Is(err, context.DeadlineExceeded):
		return "request_timeout"
	case errors.Is(err, io.EOF), errors.Is(err, io.ErrUnexpectedEOF):
		return "connection_closed"
	case errors.As(err, &operation):
		return "connection_failed"
	default:
		return "operation_failed"
	}
}

func execute(input string) (result response) {
	gate.Lock()
	defer gate.Unlock()
	// Discard internal errors and protocol buffers at the host boundary. UI errors
	// contain only an allowlisted code and numeric HTTP status.
	defer func() {
		if recover() != nil {
			result = response{Error: "runtime_failed"}
		}
	}()
	var req request
	if len(input) > 8<<20 || json.Unmarshal([]byte(input), &req) != nil {
		result.Error = "invalid_request"
		return result
	}
	hardware, err := hex.DecodeString(req.DeviceID)
	if err != nil || len(hardware) != 6 {
		result.Error = "invalid_device_id"
		return result
	}
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Minute)
	defer cancel()
	if req.Operation == "memory-preflight" {
		result.Value, err = memoryPreflight(ctx)
		result.OK = err == nil
		if err != nil {
			result.Error = "memory_isolation_failed"
		}
		return result
	}
	if req.Operation == "anisette-preflight" {
		client := storeauth.NewHTTPClient(nil)
		headers, _, provisioningErr := storeauth.AnisetteHeaders(ctx, client, nil)
		client.CloseIdleConnections()
		result.OK = provisioningErr == nil
		if provisioningErr == nil {
			result.Value = map[string]bool{"proofReady": headers.Get("X-Apple-I-MD") != "" && headers.Get("X-Apple-I-MD-M") != ""}
		} else {
			result.Error = failureCode(provisioningErr)
			match := regexp.MustCompile(`\bHTTP[ =:]*(\d{3})\b`).FindStringSubmatch(provisioningErr.Error())
			if len(match) == 2 {
				result.Status, _ = strconv.Atoi(match[1])
			}
		}
		return result
	}
	if req.Operation == "bridge-preflight" {
		result.Value, err = bridgePreflight(ctx)
		result.OK = err == nil
		if err != nil {
			result.Error = "host_bridge_failed"
		}
		return result
	}
	if req.Operation == "network-preflight" {
		client := &http.Client{Transport: browsernet.NewTransport(), Timeout: 30 * time.Second}
		request, _ := http.NewRequestWithContext(ctx, http.MethodGet, "https://init.itunes.apple.com/bag.xml?ix=6&guid=020000000001", nil)
		request.Header.Set("User-Agent", apphttp.DefaultUserAgent)
		var received *http.Response
		received, err = client.Do(request)
		if err == nil {
			result.Status = received.StatusCode
			_, err = io.Copy(io.Discard, io.LimitReader(received.Body, 4<<20))
			_ = received.Body.Close()
		}
		client.CloseIdleConnections()
		result.OK = err == nil
		if err != nil {
			result.Error = failureCode(err)
		}
		return result
	}
	if req.Operation == "prepare" {
		err = appstore.Prepare(ctx)
		result.OK = err == nil
		if err != nil {
			result.Error = "asset_preparation_failed"
		}
		return result
	}
	if req.Operation == "preflight" || req.Operation == "adi-preflight" || req.Operation == "framework-preflight" || req.Operation == "sap-test" {
		if req.Operation == "adi-preflight" {
			bundle, e := assets.Load(ctx)
			err = e
			if err == nil {
				guest, e := machine.OpenModernADI(ctx, bundle, []byte{0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15}, nil)
				err = e
				if guest != nil {
					_ = guest.Close()
				}
			}
		} else if req.Operation == "framework-preflight" {
			bundle, e := assets.Load(ctx)
			err = e
			if err == nil {
				prepared, e := profile.Load(ctx)
				err = e
				if err == nil {
					guest, e := emulator.Open(ctx, bundle.AppleMediaServices, prepared)
					err = e
					if guest != nil {
						_ = guest.Close()
					}
				}
			}
		} else if req.Operation == "preflight" {
			bundle, loadErr := assets.Load(ctx)
			err = loadErr
			if err == nil {
				guest, openErr := machine.Open(ctx, bundle)
				err = openErr
				if err == nil {
					_, err = guest.Initialize(hardware)
					_ = guest.Close()
				}
			}
		} else {
			var signer sap.ActionSigner
			signer, err = sap.NewSigner(ctx, sap.Config{Version: 200, HardwareID: hardware, CertificateURL: "https://s.mzstatic.com/sap/setupCert.plist", SetupURL: "https://fpinit.itunes.apple.com/v1/signSapSetup/legacy", HTTPClient: &http.Client{Timeout: 30 * time.Second}})
			if err == nil {
				first, e := signer.Sign([]byte("asspp-browser-test-one"))
				err = e
				if err == nil {
					second, e := signer.Sign([]byte("asspp-browser-test-two"))
					err = e
					result.Value = map[string]any{"firstLength": len(first), "secondLength": len(second), "distinct": string(first) != string(second)}
				}
				_ = signer.Close()
			}
		}
		result.OK = err == nil
		if err != nil {
			result.Error = err.Error()
		}
		return result
	}
	if req.State.Records == nil {
		req.State.Records = map[string][]byte{}
	}
	if len(req.State.Records) > 32 || len(req.State.Cookies) > 1024 {
		result.Error = "invalid_state"
		return result
	}
	baseJar, _ := cookiejar.New(nil)
	cookies := &jar{CookieJar: baseJar}
	for _, v := range req.State.Cookies {
		u, e := url.Parse(v.URL)
		if e == nil && u.Scheme == "https" && browsernet.Allowed(u.Hostname()) && v.Cookie != nil {
			cookies.SetCookies(u, []*http.Cookie{v.Cookie})
		}
	}
	mac := make([]string, 6)
	for i, b := range hardware {
		mac[i] = hex.EncodeToString([]byte{b})
	}
	client := appstore.NewAppStore(appstore.Args{Keychain: keychain{req.State.Records}, CookieJar: cookies, OperatingSystem: operatingsystem.New(), Machine: identity(strings.Join(mac, ":"))})
	defer appstore.CloseRuntime(client)
	if encoded := req.State.Records["account"]; len(encoded) > 0 {
		var stored appstore.Account
		if json.Unmarshal(encoded, &stored) == nil && stored.DirectoryServicesID != "" &&
			stored.DirectoryServicesID == req.Account.DirectoryServicesID && stored.PasswordToken == req.Account.PasswordToken {
			if stored.StoreFront == "" {
				stored.StoreFront = req.Account.StoreFront
			}
			if stored.Pod == "" {
				stored.Pod = req.Account.Pod
			}
			req.Account = stored
		}
	}
	platform, err := appstore.ParsePlatform(req.Platform)
	if err != nil {
		result.Error = "invalid_platform"
		return result
	}
	if platform == "" {
		platform = appstore.PlatformIPhone
	}
	switch req.Operation {
	case "login":
		var output appstore.LoginOutput
		output, err = client.Login(appstore.LoginInput{Email: req.Email, Password: req.Password, AuthCode: req.Code})
		output.Account.Password = ""
		result.Value = output.Account
	case "purchase":
		err = client.Purchase(appstore.PurchaseInput{Account: req.Account, App: req.App, Platform: platform})
	case "download":
		result.Value, err = appstore.DownloadInfo(client, appstore.DownloadInput{Context: ctx, Account: req.Account, App: req.App, ExternalVersionID: req.VersionID, Platform: platform})
	case "versions":
		result.Value, err = client.ListVersions(appstore.ListVersionsInput{Context: ctx, Account: req.Account, App: req.App, Platform: platform})
	case "versionMetadata":
		result.Value, err = client.GetVersionMetadata(appstore.GetVersionMetadataInput{Context: ctx, Account: req.Account, App: req.App, Platform: platform, VersionID: req.VersionID})
	default:
		err = errors.New("unsupported operation")
	}
	result.State = state{Records: req.State.Records, Cookies: cookies.entries}
	result.OK = err == nil
	if err != nil {
		result.Error = failureCode(err)
		switch {
		case errors.Is(err, appstore.ErrAuthCodeRequired):
			result.Error = "verification_required"
		case errors.Is(err, appstore.ErrPasswordTokenExpired):
			result.Error = "token_expired"
		case errors.Is(err, appstore.ErrLicenseRequired):
			result.Error = "license_required"
		case errors.Is(err, appstore.ErrLicenseAlreadyExists):
			result.Error = "license_exists"
		}
		var unexpected *apphttp.UnexpectedResponseError
		if errors.As(err, &unexpected) {
			result.Status = unexpected.StatusCode
		}
		if result.Status == 0 {
			match := regexp.MustCompile(`\bHTTP[ =:]*(\d{3})\b`).FindStringSubmatch(err.Error())
			if len(match) == 2 {
				result.Status, _ = strconv.Atoi(match[1])
			}
		}
	}
	return result
}
func main() {
	debug.SetMemoryLimit(128 << 20)
	debug.SetGCPercent(25)
	zerolog.SetGlobalLevel(zerolog.Disabled)
	http.DefaultTransport = browsernet.NewTransport()
	run := js.FuncOf(func(_ js.Value, args []js.Value) any {
		input := args[0].String()
		promise := js.FuncOf(func(_ js.Value, callbacks []js.Value) any {
			resolve := callbacks[0]
			go func() {
				output := execute(input)
				encoded, _ := json.Marshal(output)
				// Go's heap target cannot see the external JS buffers referenced by
				// syscall/js values. Release those at each operation boundary too.
				runtime.GC()
				time.Sleep(time.Millisecond)
				resolve.Invoke(string(encoded))
			}()
			return nil
		})
		result := js.Global().Get("Promise").New(promise)
		promise.Release()
		return result
	})
	js.Global().Set("assppRuntime", run)
	select {}
}
