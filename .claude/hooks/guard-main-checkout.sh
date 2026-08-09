#!/usr/bin/env python3
"""Refuses a branch switch in the top-level checkout.

The top-level checkout is shared. Moving its HEAD changes the working tree
out from under everything else pointed at that directory. Linked worktrees
under .worktrees/ are unaffected.
"""
import json
import os
import re
import sys

MAIN_CHECKOUT = "/Users/nash/Projects/vera"

# `git switch` always moves HEAD. `git checkout` only moves HEAD when it is
# not restoring paths, which is the `--`, `-p`, and pathspec-after-ref forms.
SWITCH = re.compile(r"(?:^|[;&|]\s*)git\s+(?!-C\b)(?:[^\s;&|]+\s+)*?(switch|checkout)\b")
RESTORE = re.compile(r"git\s+checkout\b[^;&|]*\s(--|-p|--patch)\s")
# Returning the checkout to main is the fix for a drifted HEAD, not a cause.
BACK_TO_MAIN = re.compile(r"git\s+(switch|checkout)\s+main\s*$")


def main() -> int:
    try:
        payload = json.load(sys.stdin)
    except json.JSONDecodeError:
        return 0

    if payload.get("tool_name") != "Bash":
        return 0

    command = payload.get("tool_input", {}).get("command", "")
    cwd = os.path.realpath(payload.get("cwd") or "")
    if cwd != os.path.realpath(MAIN_CHECKOUT):
        return 0
    if BACK_TO_MAIN.search(command.strip()):
        return 0
    if not SWITCH.search(command) or RESTORE.search(command):
        return 0

    json.dump(
        {
            "hookSpecificOutput": {
                "hookEventName": "PreToolUse",
                "permissionDecision": "deny",
                "permissionDecisionReason": (
                    f"{MAIN_CHECKOUT} stays on main. Branch switches there change"
                    " the working tree for everything else using that directory."
                    " Use a linked worktree instead:\n"
                    f"  git -C {MAIN_CHECKOUT} worktree add .worktrees/<name> -b <branch>\n"
                    "then work from .worktrees/<name>. To act on another checkout"
                    " from here, pass `git -C <path>`."
                ),
            }
        },
        sys.stdout,
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
