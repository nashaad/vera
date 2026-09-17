---
title: "The conversation rail"
description: "Browse recent conversations and see which ones are working or waiting for you."
---

# The conversation rail

Press Ctrl+E to show or hide the conversation rail. It groups work by status
so you can see which conversations need attention, including work in other
projects.

Opening a row keeps the conversation you leave running. A saved conversation
opens for reading; one that already has a running worker attaches to it.

## Read the status groups

| Group | What it contains |
| --- | --- |
| Needs you | Conversations waiting for your response. |
| Working | Conversations with active work. |
| Idle | Live conversations that are not working. |
| Recent | Saved conversation history. |

Markers remain readable without color: `!` means needs you, a spinner means
working, a check mark means recently finished, and dots mark other idle or
saved work. A workspace name appears when needed to distinguish projects.

All live sessions are listed. Recent saved files are limited to five, plus
the conversation on screen if needed. Delegated conversations appear in
their normal status group. Temporary BTW conversations do not appear here.

## Resume saved work

Reading a saved file does not start a worker. To continue it, press Enter on
the file view's resume overlay. Ctrl+R opens the full conversation picker for
work that is not in the rail.

The rail header's menu control opens that picker; its plus control starts a
new conversation. Ctrl+N also starts a new one. Pinning and number-key jumps
are inactive.

To park live work, use `/close` or Ctrl+W from the composer. See
[Saved conversations](sessions.md).

## Show the rail at startup

The rail is closed by default. Add this to the home's `config.json` and
relaunch the TUI to open it at startup:

```json
{
  "tui": {
    "sidebar": {
      "open_at_launch": true
    }
  }
}
```

Global dialogs cover and dim the rail. A question or approval for the current
conversation leaves it visible, but its controls are inactive until you answer.
