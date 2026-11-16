#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
git init -q "$work"
git -C "$work" fetch -q --depth 1 https://github.com/AlexAltea/unicorn.js.git 1220477c7fb0f8fe4b500f4bd211de52f6dfe638
git -C "$work" checkout -q --detach FETCH_HEAD
git -C "$work" submodule update --init --depth 1
python3 - "$work" <<'PY'
import pathlib,sys
root=pathlib.Path(sys.argv[1])
path=root/'unicorn/qemu/include/tcg/tcg.h'
text=path.read_text();assert text.count('#define TCG_MAX_INSNS 512')==1
path.write_text(text.replace('#define TCG_MAX_INSNS 512','#define TCG_MAX_INSNS 32'))
path=root/'build.py'
text=path.read_text();needle="'-s', 'MODULARIZE=1',";assert text.count(needle)==1
path.write_text(text.replace(needle,needle+"\n        '-s', 'ENVIRONMENT=web,worker',\n        '-s', 'EXPORT_ES6=1',"))
path=root/'src/unicorn-wrapper.js'
path.write_text(path.read_text()+"\nModule['heapByteLength'] = function () { return HEAPU8.byteLength; };\n")
PY
docker run --rm -v "$work:/src" -w /src emscripten/emsdk@sha256:90b757eb11fa9a0e3ce4d2d9f76d932a56018e4accc37b5a28b2783751e60eb7 bash -c 'apt-get update -qq && apt-get install -y --no-install-recommends pkg-config && EMCC_CORES=4 python3 build.py aarch64 && chmod -R a+rwX dist'
cp "$work/dist/unicorn_aarch64.js" "$root/vendor/unicorn-arm64.mjs"
python3 - "$root/vendor/unicorn-arm64.mjs" <<'PY2'
import pathlib,sys
path=pathlib.Path(sys.argv[1]);lines=path.read_text().splitlines(keepends=True)
assert not lines[1].strip();lines[1]='\n';path.write_text(''.join(lines))
PY2
sha256sum "$root/vendor/unicorn-arm64.mjs"
