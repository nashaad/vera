#!/bin/sh
# Run Vera against a machine that has never seen Outrider, without disturbing
# the Outrider installed for development. HOME selects both the install layout
# and the state root, so a sandbox HOME is most of the isolation; the directory
# holding the real binary also leaves PATH, because Vera looks there first.
# Weights and the llama.cpp release are linked through: both are addressed by
# their own identity, so sharing them cannot change how the sandbox behaves.
set -eu

die() {
    echo "outrider uat: $*" >&2
    exit 1
}

root=$(CDPATH= cd -- "$(dirname -- "$0")/.." && pwd)
real_state="$HOME/Library/Caches/Outrider"
temporary="${TMPDIR:-/tmp}"
sandbox="${OUTRIDER_UAT_ROOT:-${temporary%/}/vera-outrider-uat}"

# One port, so the development gateway and the sandbox cannot both be up.
if lsof -nP -iTCP:11435 -sTCP:LISTEN >/dev/null 2>&1; then
    die "something is serving on 11435. stop it first: outrider stop"
fi

installed=$(command -v outrider || true)
if [ -n "$installed" ]; then
    hidden=$(dirname "$installed")
    filtered=
    IFS=:
    for entry in $PATH; do
        [ "$entry" = "$hidden" ] && continue
        filtered="${filtered:+$filtered:}$entry"
    done
    unset IFS
    PATH="$filtered"
    export PATH
    echo "outrider uat: $hidden left PATH"
fi

rm -rf "$sandbox"
mkdir -p "$sandbox/Library/Caches/Outrider" "$sandbox/Applications"
for shared in models llama.cpp; do
    if [ -d "$real_state/$shared" ]; then
        ln -s "$real_state/$shared" "$sandbox/Library/Caches/Outrider/$shared"
    fi
done

echo "outrider uat: HOME=$sandbox"
echo "outrider uat: weights linked from $real_state"

# Whatever the sandbox started holds the one port, and its binary is inside a
# directory the next run deletes, so it is stopped before this one returns.
cleanup() {
    binary="$sandbox/.local/bin/outrider"
    [ -x "$binary" ] || binary="$installed"
    [ -n "$binary" ] || return 0
    HOME="$sandbox" "$binary" stop >/dev/null 2>&1 || true
}
trap cleanup EXIT INT TERM

if [ "$#" -eq 0 ]; then
    set -- bun run "$root/scripts/dev-tui.ts" --fresh --yes
fi
status=0
HOME="$sandbox" "$@" || status=$?
exit "$status"
