#!/bin/sh
# The TUI with no outrider on PATH and a curl that serves its installer, so the install step can be walked end to end.
set -e
here=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo=$(CDPATH= cd -- "$here/../.." && pwd)
bin="${TMPDIR:-/tmp}/vera-dev/outrider-fake/bin"
mkdir -p "$bin"
# A real outrider anywhere on PATH would answer the presence check first, and
# then the install step is never reached.
kept=""
IFS=:
for dir in $PATH; do
    [ -x "$dir/outrider" ] && continue
    kept="${kept:+$kept:}$dir"
done
unset IFS
PATH="$bin:$here:$kept"
export PATH
cd "$repo"
exec bun run dev:tui "$@"
