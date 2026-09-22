---
title: "Switch and search conversations"
description: "Return to saved work, find a past message, and move between delegated tasks."
---

# Switch and search conversations

Vera keeps conversations separately so you can move between tasks without
mixing their history. You can read saved work, resume it, or leave one
conversation running while you open another.

## Resume a conversation

<div data-widget="screen-steps" data-steps="resume-conversation"></div>

Run `/resume`, choose a conversation, and press Enter. If you are leaving a
live conversation, choose what happens to it:

| Choice | Result |
| --- | --- |
| Stop & switch | Stop its work and open the selected conversation. |
| Switch, keep running | Leave it working and open the selected conversation. |
| Escape | Return to the picker. |

<div data-widget="screen-steps" data-steps="keep-running"></div>

From Home or a saved-file view, Enter opens the selected conversation directly.
`Ctrl+E` opens the same picker as `/resume`.

## Search for past work

| Command or key | Search scope |
| --- | --- |
| Ctrl+F | The conversation on screen. |
| Ctrl+Shift+F | Past work across conversations. |
| `/search` | Past work, available from any screen. |

Type a query, select a result, and press Enter to open the conversation at
that entry. Home has no current conversation, so use Ctrl+Shift+F there.

### Narrow or widen results

Tab moves between the query, filter control, and results. Open the filter
with Enter or Space to choose all content, messages, tools, or files.

Within search, Ctrl+W cycles through this conversation, this workspace, and
everywhere. The same key outside search has a different action.

## Visit delegated work

`/subagents` lists asynchronous child conversations. Select one to open it
while the parent keeps running. Use `/parent` to return to the parent, or
`/back` to return to the previously viewed conversation. These view changes
do not stop work.

A blocking delegated task is part of the parent's active turn. It shows as
Delegating and does not leave an openable child in this list.

For two visible conversation panes, Ctrl+G changes focus and Ctrl+\ cycles
between split and single-pane layouts. See [BTW and Pair](included-extensions.md#btw-and-pair).

## Copy conversation text

Drag over transcript text or your draft. Vera copies the selection immediately
and reports the character count. Copying a draft does not change it.
