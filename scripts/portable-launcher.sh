#!/bin/sh
# Entrypoint for a self-contained Vera release bundle.
set -eu

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
version=$(tr -d '\r\n' < "$root/VERSION")
export VERA_RELEASE_VERSION=${VERA_RELEASE_VERSION:-$version}

exec "$root/runtime/bun" "$root/clients/cli/main.ts" "$@"
