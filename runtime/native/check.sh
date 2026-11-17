#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
output="$(cd -- "${1:?native output directory required}" && pwd)"
work="$(mktemp -d)"
trap 'rm -rf "$work"' EXIT
if [[ "$(uname -s)" != Linux ]]; then echo 'Use the app simulator preflight for Apple targets.' >&2; exit 1; fi
cc -O2 -shared -fPIC "$root/tests/deny-jit.c" -o "$work/deny-jit.so"
cc -O2 "$root/tests/no-jit-control.c" -o "$work/no-jit-control"
LD_PRELOAD="$work/deny-jit.so" "$work/no-jit-control"
cc -O2 -rdynamic -I "$output/include" "$root/tests/abi-check.c" -Wl,--whole-archive "$output/libAssppStoreRuntime.a" -Wl,--no-whole-archive -lpthread -ldl -lm -o "$work/abi-check"
for operation in bridge-preflight memory-preflight preflight adi-preflight framework-preflight; do
 LD_PRELOAD="$work/deny-jit.so" "$work/abi-check" "$output/assets" "$operation"
done
