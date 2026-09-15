#!/bin/sh
set -eu

skill_dir=${VERA_SKILL_DIR:?Missing skill directory}
release_bun="$skill_dir/../../../../bun"
if [ -x "$release_bun" ]; then
    exec "$release_bun" "$skill_dir/scripts/validate.ts" "$@"
fi
exec bun "$skill_dir/scripts/validate.ts" "$@"
