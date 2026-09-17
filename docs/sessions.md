---
title: "Saved conversations"
description: "Understand what survives when you stop work, close the client, or restart the host."
---

# Saved conversations

Vera saves conversations as you work. Stopping a turn or closing the terminal
client does not delete the conversation. You can return to its history and
resume it later.

The resident host owns live work. A client is the window you use to read and
control it, so closing one client does not stop every conversation.

## Return to a conversation

Run `/resume` to choose saved work. From the terminal, `vera -c` continues the
most recent conversation. See [Switch and search conversations](session-switching.md)
for moving between active tasks.

The rail can also open a saved file for reading. That view has no worker
attached for this client. Use its resume overlay when you want to continue
working. Home means no conversation is open.

## Stop, park, or exit

| Action | Result |
| --- | --- |
| Ctrl+C while working | Stop the active turn. |
| Ctrl+C while a stop is in progress | Exit the TUI. |
| Ctrl+C while idle with a draft | Clear the draft. |
| Ctrl+C while idle with an empty composer | Exit the TUI. |
| `/close` or Ctrl+W from the composer | Park the live conversation and keep its saved history. |

Other conversations can remain running after the TUI exits.

## Recognize a finished turn

A **Worked for** divider records elapsed time after long turns, errors, or
interruptions. Quick successful replies omit it during live conversation.
Reopening finished work shows its final divider even for a short turn.

For work finished more than 24 hours ago, the divider also shows the saved
finish date and time in your local timezone. Older turns without timing data
have no divider.

## Where history is stored

Session files live in `~/.vera/runtime/sessions/`. One host owns the home's
runtime directory at a time. Replacing that host preserves conversation
identity; `/reconnect` returns to the same conversation.

`VERA_HOME` relocates the whole home for tests and development. There is no
separate runtime-directory selector or daily profile flag. See
[Vera's home directory](config-reference.md) and
[Development instances](runtime-and-worktrees.md).
