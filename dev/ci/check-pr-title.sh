#!/bin/sh

set -eu

if [ "$#" -ne 1 ]; then
    printf 'usage: %s <title>\n' "$0" >&2
    exit 2
fi

script_dir=$(CDPATH= cd -P "$(dirname "$0")" && pwd)
message_file=$(mktemp "${TMPDIR:-/tmp}/vera-pr-title.XXXXXX")
trap 'rm -f "$message_file"' 0
trap 'exit 1' HUP INT TERM

printf '%s\n' "$1" > "$message_file"
"$script_dir/../hooks/commit-msg" "$message_file"
