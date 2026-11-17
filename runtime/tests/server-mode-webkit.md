# Server-mode WebKit verification

`server-mode-webkit.mjs` runs the production frontend in desktop Playwright
WebKit, backed by the actual Express access-authentication, settings and Store
runtime routes. The child process is a deliberately synthetic Node helper that
accepts only `@example.test` accounts and the fixed fixture password. It never
contacts Apple. This test verifies UI and transport behavior, not Apple account
authentication or physical-iPhone memory limits.

Verified on 2026-11-17 with Node 24.22.1 and Playwright WebKit 2336:

- A fresh browser defaults to client processing with the login switch off. Attempting a client login
  constructs its worker and sends no request to the server runtime. A worker
  construction guard prevents loading the heavy client runtime in this positive
  control; it runs in a separate browser process from the RSS measurement.
- One switch on the Add Account form enables server processing, with a short
  line below it explaining operator access to Apple ID, password, 2FA codes,
  tokens and cookies for all accounts. No Settings step or modal is required.
  The actual API rejects requests without the explicit consent header.
- After opting in on loopback, the account form sends the access-authentication
  and credential-consent headers to the real API. The actual route spawns the
  fixture helper. A typed verification challenge displays the 2FA input; the
  second submission returns its provisioning state. The synthetic account
  survives a page reload through browser IndexedDB. The global server selection
  also survives reload and revisiting Add Account for later operations.
- A helper failure produces the fixed server error and does not fall back to
  the client. Turning the same login switch off aborts an in-flight
  request and kills its child process. No replacement request is issued.
- Server-mode account operations attempt zero Web Workers, call no WebAssembly
  compilation/instantiation methods, and fetch zero runtime scripts, WASM files
  or compressed public images.
- A remote HTTP origin disables server opt-in. A stale persisted server setting
  still cannot transfer an account request over that origin. An HTTPS origin
  permits explicit opt-in when its helper is available; an unavailable helper
  keeps the switch disabled. These origin-policy cases use Playwright routing to
  serve the same production frontend with synthetic APIs; they do not claim a
  network TLS or Apple certificate test.

The measured WebContent process peak for the complete mobile server account
scenario was **341,416 KiB (333.4 MiB)**. This includes the login switch, account
form, reload, synthetic failure and cancellation. The test keeps a 384 MiB
regression guard and records both this phase and the complete test peak. This
Linux desktop WebKit RSS is substantially below the approximately 725 MiB
client-runtime result, but it is not a prediction of iOS jetsam thresholds.

Latest evidence on this workspace:

- `/tmp/asspp-server-mode-webkit-login-toggle.log`
- `/tmp/asspp-server-webkit-artifacts/result.json`
- `/tmp/asspp-server-webkit-artifacts/server-consent-webkit.png`
- `/tmp/asspp-server-webkit-artifacts/server-fixture-account-webkit.png`

Build the frontend, then run from the repository root:

```sh
node --import ./backend/node_modules/tsx/dist/loader.mjs \
  runtime/tests/server-mode-webkit.mjs frontend/dist
```

For the libraries and browser downloaded in this particular workspace, prefix
that command with:

```sh
PLAYWRIGHT_SKIP_VALIDATE_HOST_REQUIREMENTS=1 \
LD_LIBRARY_PATH=/tmp/asspp-webkit-libs/root/usr/lib/x86_64-linux-gnu \
PLAYWRIGHT_BROWSERS_PATH=/tmp/asspp-playwright-browsers
```

The test writes screenshots and a JSON result under
`$SERVER_WEBKIT_ARTIFACTS`, defaulting to `/tmp/asspp-server-webkit-artifacts`.
Its helper directory is removed and browsers/server are closed at completion.
No real credentials, provisioning proofs or Apple requests are used.
