---
title: "Queue messages while Vera works"
description: "Prepare follow-up prompts and choose when to send them."
---

# Queue messages while Vera works

You can write a follow-up while Vera is working. Press Enter to add it to the
current conversation's queue without interrupting the active turn.

When Vera finishes a tool step and is about to call the model again, waiting
prompts join the running turn in order. Vera reads them before its next step
and answers them without stopping its work.

A prompt queued under a different model or effort, or with an image the
current model cannot read, waits for its own turn. If the turn ends before a
prompt joins, Vera starts the oldest queued prompt after a successful reply
and continues one prompt and one reply at a time. You can also send waiting
prompts together before the current reply finishes.

## Send queued prompts

<div data-widget="screen-steps" data-steps="queued-messages"></div>

With the composer empty and the queue visible:

| Key | Result |
| --- | --- |
| Escape | Stop the active turn and send the oldest queued prompt. |
| Enter | Stop the active turn and send the whole queue together. |
| Ctrl+C | Stop the active turn without sending queued prompts. |

Sending the whole queue preserves prompt order as separate user messages and
produces one response to the batch. Sending only the oldest starts a turn for
it; the rest join that turn at its next tool step, or wait for its reply.

If the composer contains text or an attachment, Enter adds that draft to the
queue instead of sending existing queued prompts.

## Leave and return

The queue belongs to the conversation. Switching away or returning from
another client preserves it while the conversation remains live.

If you stop a batch or it fails, Vera reports that result once. Prompts added
after the batch began remain queued.
