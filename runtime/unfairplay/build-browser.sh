#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
output="${1:?output directory required}"
source="${UNFAIRPLAY_SOURCE:?pinned upstream source checkout required}"
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
python3 "$root/prepare-browser.py" "$source" "$work/sdk"
(cd "$work/sdk" && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w' -o "$output/unfairplay.wasm" ./cmd/unfairplay-wasm)
"${ESBUILD:-$root/../../frontend/node_modules/.bin/esbuild}" "$root/web/worker.mjs" --bundle --format=iife --platform=browser --target=es2022 --minify --outfile="$output/unfairplay-worker.js"
mkdir -p "$output/licenses"
for name in LICENSE NOTICE LICENSE-DARKPHOENIX.txt LICENSE-MACOSFAIRFREE.txt; do install -m 644 "$source/$name" "$output/licenses/$name"; done
install -m 644 "$root/licenses/Howett-plist-BSD.txt" "$output/licenses/Howett-plist-BSD.txt"
install -m 644 "$root/../licenses/Go-BSD-3-Clause.txt" "$output/licenses/Go-BSD-3-Clause.txt"
printf '%s\n' d7503082a59e3dcfdd3ea7a70434dcecaaaf07df > "$output/upstream-revision.txt"
