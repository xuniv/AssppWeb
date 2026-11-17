# Portable UnfairPlay integration

The adapters pin UnfairPlay `d7503082a59e3dcfdd3ea7a70434dcecaaaf07df`.
They expose offline `model_inspect`, `doctor`, `verify`, `decrypt`,
`strip_account_data` and `convert_ipa_macos` operations. They do not expose
Mac enrollment, setup, collection, recovery, codesigning or native execution.

The native iOS/macOS adapter is part of the existing Store Go archive. Its
`asspp_unfairplay_call`, `asspp_unfairplay_cancel` and `asspp_unfairplay_free`
exports share the Store operation gate; no second Go runtime is linked.
Requests are UTF-8 JSON up to 4 MiB. Models are supplied as an array of base64
blobs and stay in memory. Formats v1/v2/v3 have exact sizes 4176/4184/8708 bytes;
at most 256 models are accepted. Imported collections may mix versions.
`model_inspect` validates their individual syntax and reports
`registryCompatible` separately. Crypto operations preserve upstream registry
rules: v1 is used alone, and SINF conversion accepts v2. Selector matching and
complete SINF authentication never fall back to another enrollment route.

The common request fields are `operation`, optional `requestID` UUID,
`inputPath`, optional `outputPath`, `models` and `stripAccountData` (false by
default). Unknown fields reject. Input/output paths are absolute and bounded;
outputs must be new files and are created mode 0600. Existing files and inputs
are never replaced. Failed outputs are removed. Archive central records are
bounded before ZIP allocation, metadata is bounded separately, and encrypted
Mach-O images use paged private random-access storage.

Native image scratch files are unlinked before image data is written. A
verification operation retains no plaintext output artifact or named scratch
file. Models and upstream private reports are never written. Responses expose
fixed error codes, counts, coverage flags and local output information;
`plaintextVerified` remains false when pre-encryption hashes are absent.
Decryption success is separate from Apple code-signature trust or installability.

Cancellation accepts the matching nonzero UUID outside the shared operation
gate. The active queue is bounded to 16 requests. Up to 16 pre-cancellations are
remembered for 30 seconds to cover cancellation immediately before registration;
a cancellation never affects another UUID or a Store request.

`build.sh OUTPUT linux-amd64|linux-arm64` creates the standalone pure-Go
`asspp-unfairplay --stdio` helper, with a ten-minute deadline and a 4 GiB Linux
file-size limit. It reads one bounded JSON request and emits one response; stdout
is private protocol data and must not be logged. No HOME, model directory,
network client, credentials or system enrollment state is required.

Apple builds use `runtime/native/build.sh`. It fetches the same source pin,
installs only the portable fairplay/scinfo packages into the Store SDK and adds
the new exports to its existing header/archive. Go and dependency notices ship
with both deliverables. The source remains MIT with its upstream Apache-2.0
DarkPhoenix and MIT macOSFairFree notices; the plist dependency carries BSD terms.

`ASSPP_UNFAIRPLAY_FIXTURES=1` on the iOS device build optionally runs an opt-in
host test generator with the `asspp_unfair_fixture` build tag. It emits tiny
invented IPA/model fixtures and a count-only summary under `OUTPUT/test-fixtures`,
outside production bundles and headers. These files are for the smoke app only;
no enrollment model or private IPA is checked into the repository.
