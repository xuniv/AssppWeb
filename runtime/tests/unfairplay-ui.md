# UnfairPlay browser UI verification

The frontend adds a local `/unfairplay` page, an UnfairPlay action on completed
download details, and an UnfairPlay action on uploaded IPA cards. All six
portable operations use the shared engine: model inspection, diagnostics,
verification, decryption, account-data stripping, and macOS SINF conversion.
Mac setup, enrollment collection/recovery and application signing are absent.
The conversion control requires trusted V2 model metadata and explicitly says
that it does not build or sign a macOS app.

Private models use a separate IndexedDB database. Binary ArrayBuffers are stored
and exposed as Blob views; this avoids the observed `UnknownError` when this
workspace's WebKit GTK attempted to persist Blob records. There is no base64 or
localStorage model copy. Actual supported model sizes are only 4,176, 4,184 and
8,708 bytes, with at most 256 models. File-content hashes are private deduplication
keys, never report fields. Imported files are syntax-validated before saving,
and their versions come from the trusted inspector. Mixed valid collections may
be stored, while selected crypto subsets are separately checked for compatibility.
New models start unselected. Models can be selected, exported or deleted locally.

Device processing is the default. An independent explicit server switch shows
the operator trust line and respects availability and HTTPS/loopback guards.
Only selected models are sent with an operation; account-data stripping sends
none. An existing server IPA is referenced by its typed package/upload ID in
server mode. In device mode the original URL and access headers go directly to
the worker for streaming into OPFS. The frontend never fetches a whole original
IPA Blob merely to upload or copy it into WASM memory.

Outputs are new browser downloads. Original server files and local input Files
are read-only. Reports are reconstructed from an explicit boolean/count/version
allowlist; upstream evidence, paths, selectors, identifiers and every hash are
discarded. Incomplete plaintext hash coverage is displayed separately from
operation success. Account stripping does not claim complete anonymization.
Mode changes, cancellation and unmount abort work without a transport fallback.
Output OPFS backing remains alive while its result is displayed and is disposed
when replaced or unmounted. A cleanup failure produces a fixed localized message.

## Evidence

Local verification uses generated synthetic models and IPAs only. No Apple
account, real enrollment model or real application was used.

- Frontend TypeScript checking and production build pass.
- All 133 tests in the full frontend suite pass; focused tests cover model persistence,
  deduplication and bounds; selected-only transport and typed sources; privacy
  filtering; mode cancellation and no fallback; mixed stored collections;
  incompatible selections; V2 conversion guards; and output lifecycle.
- Chromium ran the actual WASM through the UI: model import and reload,
  verification, a safe JSON report, stripping, a new IPA download, and a
  downloaded-package URL streamed directly into the worker. The output ZIP was
  inspected for removed SC_Info and account metadata, and the input digest was
  unchanged.
- This workspace's stock WebKit GTK lacks OPFS. Its actual in-memory model
  inspection and IndexedDB persistence pass. IPA processing rejects before
  private input transfer, with a clear message and no automatic server request.
  Its explicit server UI path and cancellation pass using the transport fixture.
- The browser test's server branch is deliberately a benign HTTP transport
  fixture, not a claim of native server cryptographic execution. Native helper
  and HTTP route execution have separate tests owned by their adapters.

Logs and artifacts:

- `/tmp/asspp-unfair-ui-all-tests-final.log`
- `/tmp/asspp-unfair-ui-chromium-final.log`
- `/tmp/asspp-unfair-ui-webkit-final.log`
- `/tmp/asspp-unfair-ui-artifacts/`

Run after building the frontend and shared worker bundle:

```sh
UI_BROWSER=chromium node runtime/tests/unfairplay-ui.mjs \
  /tmp/asspp-unfair-ui-dist /tmp/unfair-browser-bundle /tmp/unfair-browser-fixtures
```

Use `UI_BROWSER=webkit` with the locally installed Playwright WebKit environment
variables to exercise its capability guard and server transport path. These
desktop checks do not establish physical-iPhone memory limits.
