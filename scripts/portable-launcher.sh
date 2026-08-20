#!/bin/sh
# Entrypoint for a self-contained Vera release bundle.
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
version=$(tr -d '\r\n' < "$root/VERSION")
export VERA_RELEASE_VERSION=${VERA_RELEASE_VERSION:-$version}

exec "$root/runtime/bun" "$root/clients/cli/main.ts" "$@"
