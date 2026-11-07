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

`/close` leaves the conversation's saved file on screen for reading. That view has no worker
attached for this client. Use its resume overlay when you want to continue
working. Home means no conversation is open.

## Stop, park, or exit

| Action | Result |
| --- | --- |
| Ctrl+C while working | Stop the active turn. |
| Ctrl+C while a stop is in progress | Exit the TUI. |
| Ctrl+C while idle with a draft | Clear the draft. |
| Ctrl+C twice while idle with an empty composer | Exit the TUI. |
| `/close` or Ctrl+W from the composer | Park the live conversation and keep its saved history. |

When a side pane such as `/btw`'s sidekick is focused, `/close` or Ctrl+W
closes that pane instead and leaves the live conversation running.

`/clear` starts a new conversation and asks Close this conversation or Keep
running. Keep running stays idle for ten minutes, then closes. `/clear stop`
and `/clear keep` make that choice without asking. `/new` is the same command
as `/clear`.

In the New conversation picker, `1. Close this conversation` closes the source
and starts fresh, while `2. Keep running` keeps the source running and starts
fresh. Either number acts immediately without Enter. Arrow navigation, Enter,
and Escape keep their usual picker behavior.

Other conversations can remain running after the TUI exits.

## Block a session that will not stop

`vera abort <agent-id>` ends a live agent's active turn and leaves the agent
running. `vera close <agent-id>` ends the agent and discards its queued prompts.
When a session ignores both, `vera block <agent-id>` is the stronger move.

`vera block <agent-id>` lists the session and every session it started, with
their ids and whether each is live, then asks you to confirm. Once confirmed,
Vera stops their running turns and writes a block for each one. A blocked
session stays open and inert: a new prompt, a queued prompt, an inbox message,
a scheduled job, or a resume does not start a turn in it. It is not closed.
Run `vera close <agent-id>` afterwards to end it.

`vera block --reason <text>` records a short reason with the block.

`vera unblock <agent-id>` lists the sessions blocked with that session, asks
you to confirm, and clears their blocks. Turns can start again after that.

Both commands need a terminal to confirm. Without one they refuse, and nothing
is blocked or unblocked.

## Recognize a finished turn

A **Worked for** divider records active turn time after turns that ran at least
five minutes, whether they finished, failed or were interrupted. It counts
model and tool work but pauses while Vera waits for your response or approval.
Shorter turns omit it during live conversation.
Reopening finished work shows its final divider even for a short turn.
When the classifier allowed low-risk actions during a turn, the divider also
shows how many, such as `Worked for 6m 00s · 3 auto-approved`. A short turn's
divider then shows only the count.

For work finished more than 24 hours ago, the divider also shows the saved
finish date and time in your local timezone. Older turns without timing data
have no divider.

## Where history is stored

Session files live in `~/.vera/runtime/sessions/`. One host owns the home's
runtime directory at a time. Replacing that host preserves conversation
identity; **Reconnect host** (Ctrl+P) returns to the same conversation.

`VERA_HOME` relocates the whole home for tests and development. There is no
separate runtime-directory selector or daily profile flag. See
[Vera's home directory](config-reference.md) and
[Development instances](runtime-and-worktrees.md).
