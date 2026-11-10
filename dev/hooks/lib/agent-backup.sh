#!/bin/sh
# Refresh the agent guidance backup. Sourced by post-commit and post-merge.
# A missing configuration is not an error, and the caller always exits 0.

backup_root=${VERA_AGENT_BACKUP_DIR:-}
if [ -z "$backup_root" ]; then
    backup_root=$(git config --get vera.agentBackupDir 2>/dev/null) || exit 0
fi
if [ -z "$backup_root" ]; then
    exit 0
fi

command -v bun >/dev/null 2>&1 || exit 0

hook_dir=$(dirname "$0")
common_dir=$(git rev-parse --path-format=absolute --git-common-dir 2>/dev/null) ||
    common_dir=$(git rev-parse --git-common-dir 2>/dev/null)
if [ -n "$common_dir" ]; then
    main_root=$(dirname "$common_dir")
else
    main_root=$(CDPATH= cd -- "$hook_dir/../.." 2>/dev/null && pwd) || exit 0
fi

script="$main_root/dev/agent-guidance/sync-backups.ts"
[ -f "$script" ] || exit 0

VERA_AGENT_BACKUP_DIR=$backup_root bun "$script" --auto >/dev/null 2>&1
exit 0
