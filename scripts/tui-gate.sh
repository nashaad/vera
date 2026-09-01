#!/bin/sh
# Run TUI and architecture tests one file at a time.
# test/support/tui-harness.ts holds a process-global session guard, so a
# batched `bun test test/tui` reports phantom "session already open" failures.
set -eu
cd "$(dirname "$0")/.."
for f in test/tui/*.test.ts test/tui/driven/*.test.ts test/architecture/*.test.ts; do
    [ -f "$f" ] || continue
    n=$(bun test "$f" 2>&1 | grep -oE '^ [0-9]+ fail' | grep -oE '[0-9]+' || true)
    echo "$f ${n:-0}"
done
