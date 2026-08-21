#!/bin/sh
# Entrypoint for Vera's npm package. npm links this file into its global bin.
set -eu

entrypoint=$0
while [ -L "$entrypoint" ]; do
    entrypoint_dir=$(CDPATH= cd -P -- "$(dirname -- "$entrypoint")" && pwd)
    entrypoint_target=$(readlink "$entrypoint")
    case "$entrypoint_target" in
        /*) entrypoint=$entrypoint_target ;;
        *) entrypoint=$entrypoint_dir/$entrypoint_target ;;
    esac
done
root=$(CDPATH= cd -P -- "$(dirname -- "$entrypoint")/.." && pwd)

if ! command -v bun >/dev/null 2>&1; then
    echo "vera: Bun 1.3.6 or newer is required: https://bun.sh" >&2
    exit 1
fi
bun_version=$(bun --version 2>/dev/null || true)
if ! printf '%s\n' "$bun_version" | grep -Eq \
    '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$'; then
    echo "vera: could not determine the installed Bun version" >&2
    exit 1
fi
if ! printf '%s\n' "$bun_version" | awk -F. '
    $1 > 1 { ok = 1 }
    $1 == 1 && $2 > 3 { ok = 1 }
    $1 == 1 && $2 == 3 && $3 >= 6 { ok = 1 }
    END { exit ok ? 0 : 1 }
'; then
    echo "vera: Bun 1.3.6 or newer is required; found $bun_version" >&2
    exit 1
fi

if [ "$(uname -s)" = "Linux" ]; then
    libc=$(getconf GNU_LIBC_VERSION 2>/dev/null || true)
    case "$libc" in
        glibc\ *) ;;
        *) echo "vera: the current Linux package requires glibc" >&2; exit 1 ;;
    esac
fi

version=$(tr -d '\r\n' < "$root/VERSION")
export VERA_RELEASE_VERSION=${VERA_RELEASE_VERSION:-$version}

exec bun "$root/clients/cli/main.ts" "$@"
