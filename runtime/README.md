# Client Store runtime

This adapter runs ipatool revision
`b352566155a667d8aaeabaa7ecec4966080f92ab` inside the browser or the app's local
WKWebView. It reuses the macOS 27 ARM64 SAP, framework request engine, Anisette,
Store AMD provisioning, KBSync and entitlement download implementation. The
host does not replace these operations with legacy signed requests.

No authentication HTTP endpoint or hosted signer is used. Go terminates Apple
TLS inside the client. Browser Wisp forwards encrypted TCP; the native app
opens its own TCP connections with Network.framework. Both transports restrict
destinations to approved Apple hosts on port 443. Mozilla public CA roots and
Apple Root CA are bundled, and certificate/hostname verification remains on.
The OTA installer's separate device trust requirements remain unchanged.

The immutable root bundle's SHA-256 is
`aec261c5aa569a1fdef65e119eeb839cd9cfafc2641b9c8b15f168cbe18145ca`.
Apple Root CA's certificate SHA-256 is
`b0b1730ecbc7ff4505142c49f1295e6eda6bcaed7e2c68c5be91b5a11001f024`.
Environment-specific proxy roots must never enter published builds.

At build time the upstream range reader extracts only the pinned public images
from Apple's restore CDN. Verified images are packaged as compressed data with
the app/image, and checked again before entering the interpreter. No Apple
executable is checked into this repository or loaded by the host operating
system. Preparing images at build time avoids parsing a large restore image
inside a memory-limited iOS WebContent process. Verified images may persist in
browser IndexedDB or the app's public-asset cache.
Account records, cookies and provisioning state return to client IndexedDB or
Keychain. They never enter the public-image cache, server files or logs.

`build.sh OUTPUT` needs Go 1.26.5, Python 3, Git and esbuild. It downloads the
exact upstream revision, applies the checked-in adapters, removes unused OS
keyring providers and builds without VCS metadata or local paths.
`IPATOOL_SOURCE` can select an already checked-out copy of the exact revision.

`vendor/unicorn-arm64.mjs` is Unicorn.js
`1220477c7fb0f8fe4b500f4bd211de52f6dfe638`, with Unicorn
`8028ec436f2d9376525352dd38ed9ed6b9f6be10`. It uses the TCG interpreter,
not native JIT. The local build limits translation blocks to 32 instructions
and includes the CPU/translation-buffer controls absent from the npm bundle.
`rebuild-unicorn.sh` supplies the corresponding source and reproducible build
steps. See `licenses/` for the MIT, BSD and GPL notices. Go's generated
`wasm_exec.js` is copied from the selected compiler during the build.

Guest callbacks stop emulation before crossing into Go. The outer loop then
runs the host bridge and resumes the intercepted instruction when appropriate.
This allows framework callbacks to await network I/O without a blocked JS/WASM
call stack. Ordinary Store instructions stay in the JS address-policy check;
only bridge calls cross into Go. Guest instruction/time limits remain enforced.

Public images stream into Go through 64 KiB reads, rather than being kept as a
second complete JS filesystem copy. Native IPC uses the same bounded chunks.
Unicorn code/data pages are interned only after exact comparison, protected
read-only and copied on write outside the active CPU callback. Every unmapped
page starts at zero. Cached pages are freed when the last guest closes.
The additional vendor JS export exposes its existing WASM heap view; the
embedded Unicorn WASM code is unchanged and rebuild-unicorn.sh reproduces it.

Go/JS read and write staging buffers are reused, dispatch policies are updated
only when their complete address sets change, and emulation periodically yields
to the JS event loop. Tests enforce both linear-memory and WebContent RSS caps,
including repeated guests and cross-guest write isolation. The manual public
network probe also exercises Anisette provisioning without an Apple account;
its proofs and provisioning records are discarded rather than returned/logged.
