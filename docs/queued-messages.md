---
title: "Queue messages while Vera works"
description: "Prepare follow-up prompts and choose when to send them."
---

# Queue messages while Vera works

You can write a follow-up while Vera is working. Press Enter to add it to the
current conversation's queue without interrupting the active turn.

Queued prompts wait for you to send them, even when the current turn finishes.
This lets you prepare several follow-ups and decide whether to send one or
send them together.

## Send queued prompts

With the composer empty and the queue visible:

| Key | Result |
| --- | --- |
| Escape | Stop the active turn and send the oldest queued prompt. |
| Enter | Stop the active turn and send the whole queue together. |
| Ctrl+C | Stop the active turn without sending queued prompts. |

Sending the whole queue preserves prompt order as separate user messages and
produces one response to the batch. Sending only the oldest leaves the rest
queued.

If the composer contains text or an attachment, Enter adds that draft to the
queue instead of sending existing queued prompts.

## Leave and return

The queue belongs to the conversation. Switching away or returning from
another client preserves it while the conversation remains live.

If you stop a batch or it fails, Vera reports that result once. Prompts added
after the batch began remain queued.
