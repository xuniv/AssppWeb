#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
output="${1:?output directory required}"
target="${2:-ios-arm64}"
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
work="${ASSPP_NATIVE_WORK:-$(mktemp -d)}"
mkdir -p "$work"
work="$(cd -- "$work" && pwd)"
if [[ -z "${ASSPP_NATIVE_WORK:-}" ]]; then trap 'rm -rf "$work"' EXIT; fi
revision=b352566155a667d8aaeabaa7ecec4966080f92ab
unicorn_revision=8028ec436f2d9376525352dd38ed9ed6b9f6be10
source_path="${IPATOOL_SOURCE:-}"
if [[ -z "$source_path" ]]; then
 source_path="$work/upstream"
 git init -q "$source_path"
 git -C "$source_path" fetch -q --depth 1 https://github.com/majd/ipatool.git "$revision"
 git -C "$source_path" checkout -q --detach FETCH_HEAD
fi
python3 "$root/prepare.py" "$source_path" "$work/sdk"
python3 - "$root" <<'PY'
import hashlib,pathlib,sys
p=pathlib.Path(sys.argv[1])/'overlay/internal/browsernet/roots.crt'
assert hashlib.sha256(p.read_bytes()).hexdigest()=='aec261c5aa569a1fdef65e119eeb839cd9cfafc2641b9c8b15f168cbe18145ca','public root identity mismatch'
PY
patch_digest="$(python3 - "$root/patches/unicorn-tci-native.patch" <<'PYHASH'
import hashlib,pathlib,sys
print(hashlib.sha256(pathlib.Path(sys.argv[1]).read_bytes()).hexdigest())
PYHASH
)"
if [[ ! -f "$work/unicorn/.asspp-tci-patched" ]] || [[ "$(cat "$work/unicorn/.asspp-tci-patched")" != "$patch_digest" ]]; then
 git init -q "$work/unicorn"
 git -C "$work/unicorn" fetch -q --depth 1 https://github.com/unicorn-engine/unicorn.git "$unicorn_revision"
 git -C "$work/unicorn" reset -q --hard "$unicorn_revision"
 git -C "$work/unicorn" clean -q -fd
 git -C "$work/unicorn" checkout -q --detach FETCH_HEAD
 git -C "$work/unicorn" apply "$root/patches/unicorn-tci-native.patch"
 printf '%s\n' "$patch_digest" > "$work/unicorn/.asspp-tci-patched"
fi
cmake_args=(-DUNICORN_TCI=ON -DUNICORN_ARCH=aarch64 -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF -DUNICORN_BUILD_TESTS=OFF -DUNICORN_INSTALL=OFF)
export CGO_ENABLED=1
case "$target" in
 ios-arm64|ios-simulator-arm64|macos-arm64|macos-amd64)
  case "$target" in
   ios-arm64) sdk=iphoneos; triple=arm64-apple-ios17.0; GOOS=ios; system=iOS ;;
   ios-simulator-arm64) sdk=iphonesimulator; triple=arm64-apple-ios17.0-simulator; GOOS=ios; system=iOS ;;
   macos-arm64) sdk=macosx; triple=arm64-apple-macos15.0; GOOS=darwin; system=Darwin ;;
   macos-amd64) sdk=macosx; triple=x86_64-apple-macos15.0; GOOS=darwin; system=Darwin ;;
  esac
  export GOOS GOARCH=arm64
  apple_arch=arm64
  if [[ "$target" == macos-amd64 ]]; then export GOARCH=amd64; apple_arch=x86_64; fi
  sdkroot="$(xcrun --sdk "$sdk" --show-sdk-path)"
  compiler="$(xcrun --sdk "$sdk" --find clang)"
  export SDKROOT="$sdkroot" CC="$compiler"
  export CGO_CFLAGS="-target $triple -isysroot $sdkroot"
  cmake_args+=(-DCMAKE_SYSTEM_NAME="$system" -DCMAKE_OSX_SYSROOT="$sdkroot" -DCMAKE_OSX_ARCHITECTURES="$apple_arch" -DCMAKE_C_COMPILER="$compiler" -DCMAKE_C_FLAGS="$CGO_CFLAGS")
  if [[ "$system" == iOS ]]; then cmake_args+=(-DCMAKE_OSX_DEPLOYMENT_TARGET=17.0); else cmake_args+=(-DCMAKE_OSX_DEPLOYMENT_TARGET=15.0); fi
  export ARCHFLAGS="-arch $apple_arch"
  ;;
 linux-amd64|linux-arm64) export GOOS=linux GOARCH="${target#linux-}"; compiler="${CC:-cc}" ;;
 *) echo "Unsupported native target: $target" >&2; exit 1 ;;
esac
cmake_args+=("-DCMAKE_C_FLAGS=${CGO_CFLAGS:-} -ffile-prefix-map=$work=/source -fdebug-prefix-map=$work=/source -fmacro-prefix-map=$work=/source")
cmake -S "$work/unicorn" -B "$work/unicorn-build" "${cmake_args[@]}"
cmake --build "$work/unicorn-build" --target unicorn_archive --parallel "${ASSPP_NATIVE_JOBS:-4}"
# Resolve Unicorn from the host image; never load a downloaded dynamic library.
if [[ "$GOOS" == linux ]]; then
 export CGO_LDFLAGS="${CGO_LDFLAGS:-} -Wl,--export-dynamic"
else
 export CGO_LDFLAGS="${CGO_CFLAGS:-} -Wl,-export_dynamic"
fi
(cd "$work/sdk" && go build -mod=readonly -trimpath -buildvcs=false -buildmode=c-archive -ldflags='-s -w' -o "$output/runtime.a" ./cmd/asspp-runtime)
cp "$work/unicorn-build/libunicorn.a" "$output/libunicorn.a"
if [[ "$GOOS" == linux ]]; then
 mkdir -p "$work/sdk/cmd/asspp-runtime/native-static"
 cp "$output/libunicorn.a" "$work/sdk/cmd/asspp-runtime/native-static/libunicorn.a"
 (cd "$work/sdk" && go build -tags asspp_native_cli -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w -linkmode external' -o "$output/asspp-runtime-native" ./cmd/asspp-runtime)
fi
if [[ "$GOOS" == linux ]]; then
 python3 - "$output" <<'PY'
import pathlib,subprocess,sys
p=pathlib.Path(sys.argv[1])
script=f'create {p}/libAssppStoreRuntime.a\naddlib {p}/runtime.a\naddlib {p}/libunicorn.a\nsave\nend\n'
subprocess.run(['ar','-M'],input=script,text=True,check=True)
PY
else
 xcrun libtool -static -o "$output/libAssppStoreRuntime.a" "$output/runtime.a" "$output/libunicorn.a"
fi
mkdir -p "$output/include"
cp "$root/AssppStoreRuntime.h" "$root/module.modulemap" "$output/include/"
cp -R "$root/../licenses" "$output/licenses"
printf '%s\n' "$revision" > "$output/upstream-revision.txt"
# Reuse the existing public-asset build step; callers can reuse a previously prepared bundle.
if [[ "${ASSPP_NATIVE_SKIP_ASSETS:-0}" == 1 ]]; then
 :
elif [[ -n "${ASSPP_PUBLIC_ASSETS:-}" ]]; then
 mkdir -p "$output/assets"
 cp -R "$ASSPP_PUBLIC_ASSETS/." "$output/assets/"
elif [[ "${ASSPP_NATIVE_SKIP_ASSETS:-0}" != 1 ]]; then
 (cd "$work/sdk" && env -u GOOS -u GOARCH CGO_ENABLED=0 go run -mod=readonly ./cmd/asspp-assets "$output/assets")
fi
