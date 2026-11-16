#!/usr/bin/env bash
set -euo pipefail
runtime_root="$(cd -- "$(dirname -- "$0")" && pwd)"
output="${1:?output directory required}"
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
revision=b352566155a667d8aaeabaa7ecec4966080f92ab
source_path="${IPATOOL_SOURCE:-}"
if [[ -z "$source_path" ]]; then
 source_path="$work/upstream"
 git init -q "$source_path"
 git -C "$source_path" fetch -q --depth 1 https://github.com/majd/ipatool.git "$revision"
 git -C "$source_path" checkout -q --detach FETCH_HEAD
fi
python3 "$runtime_root/prepare.py" "$source_path" "$work/sdk"
python3 - "$runtime_root" <<'PY'
import hashlib,pathlib,sys
root=pathlib.Path(sys.argv[1])
for name,digest in {
 'overlay/internal/browsernet/roots.crt':'aec261c5aa569a1fdef65e119eeb839cd9cfafc2641b9c8b15f168cbe18145ca',
 'vendor/unicorn-arm64.mjs':'77275db68fda0284e9ca375239c4559e38af8ac34de5aedf4377a52d6aff1ca0'
}.items():
 if hashlib.sha256((root/name).read_bytes()).hexdigest()!=digest:raise SystemExit('Runtime dependency digest mismatch: '+name)
PY
(cd "$work/sdk" && GOOS=js GOARCH=wasm CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w' -o "$output/runtime.wasm" ./cmd/asspp-runtime)
(cd "$work/sdk" && CGO_ENABLED=0 go run -mod=readonly ./cmd/asspp-assets "$output/assets")
cp "$(go env GOROOT)/lib/wasm/wasm_exec.js" "$runtime_root/web/wasm_exec.js"
"${ESBUILD:-$runtime_root/../frontend/node_modules/.bin/esbuild}" "$runtime_root/web/entry.mjs" --bundle --format=iife --platform=browser --target=es2022 --define:import.meta.url=globalThis.location.href --minify --outfile="$output/store-runtime.js"
cp -R "$runtime_root/licenses" "$output/licenses"
printf '%s\n' '<!doctype html><meta charset="utf-8"><script src="store-runtime.js"></script>' > "$output/index.html"
printf '%s\n' "$revision" > "$output/upstream-revision.txt"
