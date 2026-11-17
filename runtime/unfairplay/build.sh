#!/usr/bin/env bash
set -euo pipefail
root="$(cd -- "$(dirname -- "$0")" && pwd)"
output="${1:?output directory required}"
target="${2:-linux-amd64}"
case "$target" in linux-amd64|linux-arm64) ;; *) echo 'Apple builds use runtime/native/build.sh and the existing Store archive.' >&2; exit 1;; esac
mkdir -p "$output"
output="$(cd -- "$output" && pwd)"
work="${ASSPP_UNFAIRPLAY_WORK:-$(mktemp -d)}"
mkdir -p "$work"
if [[ -z "${ASSPP_UNFAIRPLAY_WORK:-}" ]]; then trap 'rm -rf "$work"' EXIT; fi
source="${UNFAIRPLAY_SOURCE:-}"
if [[ -z "$source" ]]; then
 source="$work/upstream"
 git init -q "$source"
 git -C "$source" fetch -q --depth 1 https://github.com/DrWhax/unfairplay.git d7503082a59e3dcfdd3ea7a70434dcecaaaf07df
 git -C "$source" checkout -q --detach FETCH_HEAD
fi
python3 "$root/prepare.py" "$source" "$work/sdk"
(cd "$work/sdk" && GOOS=linux GOARCH="${target#linux-}" CGO_ENABLED=0 go build -mod=readonly -trimpath -buildvcs=false -ldflags='-s -w' -o "$output/asspp-unfairplay" ./cmd/asspp-unfairplay)
mkdir -p "$output/licenses"
cp -R "$root/licenses/." "$output/licenses/"
for name in LICENSE NOTICE LICENSE-DARKPHOENIX.txt LICENSE-MACOSFAIRFREE.txt; do cp "$source/$name" "$output/licenses/UnfairPlay-$name"; done
printf '%s\n' d7503082a59e3dcfdd3ea7a70434dcecaaaf07df > "$output/upstream-revision.txt"
