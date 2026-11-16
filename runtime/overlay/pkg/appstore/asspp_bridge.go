package appstore

import (
	"context"
	"errors"
	"strings"

	"howett.net/plist"
)

// RuntimeDownloadInfo is the client-side IPA assembly input. The Store runtime
// obtains it using its normal framework, Store AMD and kbsync implementation.
type RuntimeDownloadInfo struct {
	DownloadURL              string        `json:"downloadURL"`
	Sinfs                    []RuntimeSinf `json:"sinfs"`
	BundleShortVersionString string        `json:"bundleShortVersionString"`
	BundleVersion            string        `json:"bundleVersion"`
	ITunesMetadata           []byte        `json:"iTunesMetadata"`
}

type RuntimeSinf struct {
	ID   int64  `json:"id"`
	Data []byte `json:"sinf"`
}

// CloseRuntime releases per-operation connection pools in a long-lived client
// process. The CLI normally releases these when its process exits.
func CloseRuntime(client AppStore) {
	if t, ok := client.(*appstore); ok {
		if t.authBackend != nil {
			t.authBackend.CloseIdleConnections()
		}
		if t.authHTTP != nil {
			t.authHTTP.CloseIdleConnections()
		}
	}
}

// DownloadInfo exposes the metadata phase of the existing Download operation.
// It does not fetch, modify, or persist an IPA and preserves explicit failures.
func DownloadInfo(client AppStore, input DownloadInput) (RuntimeDownloadInfo, error) {
	t, ok := client.(*appstore)
	if !ok {
		return RuntimeDownloadInfo{}, errors.New("unsupported Store runtime")
	}
	ctx := input.Context
	if ctx == nil {
		ctx = context.Background()
	}
	mac, err := t.machine.MacAddress()
	if err != nil {
		return RuntimeDownloadInfo{}, err
	}
	guid := strings.ReplaceAll(strings.ToUpper(mac), ":", "")
	externalVersionID := input.ExternalVersionID
	if externalVersionID == "" && (input.Platform == PlatformAppleTV || input.Platform == PlatformWatchOS || input.Platform == PlatformVisionOS) {
		externalVersionID, err = t.lookupLatestExternalVersionID(input.Account, input.App, input.Platform)
		missingTVOffer := input.Platform == PlatformAppleTV &&
			(errors.Is(err, errPlatformAppNotFound) || errors.Is(err, errPlatformOffersNotFound))
		if err != nil && !missingTVOffer {
			return RuntimeDownloadInfo{}, err
		}
	}
	result, _, err := t.sendDownloadProduct(ctx, input.Account, input.App, guid, externalVersionID, input.Platform)
	if err != nil {
		return RuntimeDownloadInfo{}, err
	}
	result.Data = normalizeDownloadFailure(result.Data)
	switch result.Data.FailureType {
	case FailureTypePasswordTokenExpired, FailureTypeSignInRequired, FailureTypeDeviceVerificationFailed, FailureTypeLicenseAlreadyExists:
		return RuntimeDownloadInfo{}, ErrPasswordTokenExpired
	case FailureTypeLicenseNotFound:
		return RuntimeDownloadInfo{}, ErrLicenseRequired
	}
	if err = validateDownloadResponse(result, input.App, externalVersionID, "download"); err != nil {
		return RuntimeDownloadInfo{}, err
	}
	if result.Data.FailureType != "" || len(result.Data.Items) == 0 {
		return RuntimeDownloadInfo{}, errors.New("Apple returned no downloadable package")
	}
	item := result.Data.Items[0]
	packagePlatform, err := downloadPackagePlatform(input.Platform, item)
	if err != nil {
		return RuntimeDownloadInfo{}, err
	}
	if packagePlatform == PlatformMacOS {
		return RuntimeDownloadInfo{}, errors.New("the IPA assembly host does not support macOS packages")
	}
	if item.URL == "" || len(item.Sinfs) == 0 {
		return RuntimeDownloadInfo{}, errors.New("Apple returned incomplete package information")
	}
	output := RuntimeDownloadInfo{DownloadURL: item.URL}
	output.BundleShortVersionString, _ = item.Metadata["bundleShortVersionString"].(string)
	output.BundleVersion, _ = item.Metadata["bundleVersion"].(string)
	if output.BundleShortVersionString == "" || output.BundleVersion == "" {
		return RuntimeDownloadInfo{}, errors.New("Apple returned no package version")
	}
	for _, value := range item.Sinfs {
		output.Sinfs = append(output.Sinfs, RuntimeSinf{ID: value.ID, Data: value.Data})
	}
	metadata := make(map[string]any, len(item.Metadata)+2)
	for key, value := range item.Metadata {
		metadata[key] = value
	}
	metadata["apple-id"] = input.Account.Email
	metadata["userName"] = input.Account.Email
	for _, key := range []string{"password", "passwordToken", "cookies", "authenticationToken"} {
		delete(metadata, key)
	}
	output.ITunesMetadata, err = plist.Marshal(metadata, plist.BinaryFormat)
	return output, err
}
