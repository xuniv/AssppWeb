# Native Store runtime

This target runs the same pinned ipatool Store protocol in native Go with a
statically linked ARM64 interpreter. It needs no WebView, JIT entitlement,
jailbreak, downloaded native library or authentication server. The optional
private-server adapter invokes the same Linux executable once per operation.

`build.sh OUTPUT TARGET` requires Go 1.26.5, CMake, Python 3, Git and a C compiler.
Apple targets require macOS and the selected Xcode SDK. Targets are
`ios-arm64`, `ios-simulator-arm64`, `macos-arm64`, `macos-amd64`, `linux-amd64`
and `linux-arm64`. Linux targets use a compiler matching the selected architecture.

The output contains `libAssppStoreRuntime.a`, `include/AssppStoreRuntime.h`, a
Clang module map, compressed public `assets/`, revision and licenses. Linux also
produces `asspp-runtime-native`. `IPATOOL_SOURCE` may select an existing checkout
at the exact pinned revision. `ASSPP_PUBLIC_ASSETS` may reuse a previously built
bundle's `assets` directory. `ASSPP_NATIVE_SKIP_ASSETS=1` skips that duplicate step.
`ASSPP_NATIVE_WORK` optionally retains a private build directory.

Link the complete merged archive with `-force_load` and `-export_dynamic` so
purego can resolve its static Unicorn API. Apple callers also link `resolv`,
`Security` and `CoreFoundation`. Package the device, simulator and universal Mac
libraries in an XCFramework; they have different platform identities.

Call `asspp_runtime_configure` once with an absolute public-assets directory.
`asspp_runtime_call` accepts the existing UTF-8 JSON request and returns an owned
UTF-8 JSON response. Free it exactly once with `asspp_runtime_free`. Calls block
and serialize inside Go; invoke them off the main thread. Requests are limited
to 8 MiB and responses to 12 MiB. Account records and cookies remain in the
caller's state envelope and belong in Keychain in the native app.

The Linux private-server command is `asspp-runtime-native --stdio /absolute/assets`.
It reads one bounded request from stdin and writes one response to stdout. Its
stdout is protocol data and must never be copied into server logs.

The native adapter reads each packaged image through bounded zlib decompression
and verifies the upstream size and SHA-256 before guest use. It performs no
restore-image extraction or cache writes at runtime. Native TCP and Go TLS use
the bundled public Mozilla/Apple roots, require approved Apple hosts on port 443,
and bypass environment proxies. TLS failures never replace the pinned roots.

The source pins match the browser runtime: ipatool
`b352566155a667d8aaeabaa7ecec4966080f92ab` and Unicorn
`8028ec436f2d9376525352dd38ed9ed6b9f6be10`. The patch restores QEMU 5.0.1 TCI
from unicorn.js `1220477c7fb0f8fe4b500f4bd211de52f6dfe638`, selects it explicitly,
uses read/write translation data, disables Apple JIT handling and makes the
interpreter return-address state thread local. Native builds use TCI's native
helper calling convention; the WebAssembly-specific helper adapters are omitted.

`check.sh OUTPUT` runs the real C ABI, callback and memory-isolation fixtures,
and SAP, Modern ADI and Store framework startup using the packaged public images.
On Linux it first verifies a seccomp control that rejects anonymous executable
mappings and every `mprotect` adding execute, then runs all fixtures with those
restrictions. It needs no Apple account or network. Apple simulator and device
checks remain necessary before release; Linux timings do not predict iPhone speed.
