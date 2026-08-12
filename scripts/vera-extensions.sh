#!/bin/sh
# Runs this checkout's Vera with only the named extension directories, after
# stopping any resident host so the host picks up the same list.
#
#   scripts/vera-extensions.sh examples/extensions/btw -- --continue
set -e

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)

paths=""
while [ "$#" -gt 0 ]; do
    case "$1" in
        --)
            shift
            break
            ;;
        *)
            resolved=$(CDPATH= cd -- "$1" && pwd)
            if [ -z "$paths" ]; then
                paths=$resolved
            else
                paths="$paths,$resolved"
            fi
            shift
            ;;
    esac
done

if [ -z "$paths" ]; then
    echo "usage: $0 <extension-dir> [more-dirs...] [-- vera args...]" >&2
    exit 2
fi

bun run "$root/clients/cli/main.ts" host stop --yes || true
VERA_EXTENSIONS="$paths" exec bun run "$root/clients/tui/main.ts" "$@"
