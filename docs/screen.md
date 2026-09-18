---
title: "Conversations"
description: "Find live and saved conversations, leave one running, or start another."
---

# Conversations

Press Ctrl+E or run `/resume` to open the conversation picker. They are the
same searchable list. Live work sits above parked history.

Enter asks what happens to the conversation on screen, because closing a Vera
session stops its worker:

| Choice | Result |
| --- | --- |
| Stop & switch | Stop its work and open the selected conversation. |
| Switch, keep running | Leave it working and open the selected conversation. |
| Escape | Return to the picker. |

From Home or a saved-file view, Enter opens the selected conversation
directly. Ctrl+E again, or Escape, closes the picker.

## Read the status groups

| Group | What it contains |
| --- | --- |
| Needs you | Conversations waiting for your response. |
| Working | Conversations with active work. |
| Idle | Live conversations that are not working. |
| Recent | Saved conversation history. |

A group with no rows is omitted. Search keeps the same headings over the
matching rows. Delegated conversations appear in their normal status group.
Temporary BTW conversations do not appear here.

Keep running stays idle for ten minutes without a viewer, then Vera closes
that worker and keeps the saved file. Ctrl+Shift+Left and Ctrl+Shift+Right
cycle those live conversations without opening the picker.

Ctrl+N from a live session asks Close this conversation or Keep running, the
same as `/clear`. Home and file-view Ctrl+N start immediately.

To park live work, use `/close` or Ctrl+W from the composer. See
[Saved conversations](sessions.md).
