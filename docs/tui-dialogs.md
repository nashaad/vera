---
title: "Dialog controls and appearance"
description: "Navigate pickers and reports, and choose title and search-field styles."
---

# Dialog controls and appearance

Most Vera dialogs use arrow keys to choose, Enter to open or confirm, and
Escape to return or close. The footer shows the action for the focused
control. Typing in a searchable picker moves into its search field.

A brief overlay can appear as a full-width band at the top of the screen,
including above an open dialog, for work such as a catalog refresh. The
message types on quickly, then a tick or a failure mark. Press Escape to close
it when no dialog is open.
While a dialog is open, Escape still belongs to the dialog and the overlay
clears after a few seconds. Clicking it also closes it. Another overlay
waits its turn. It does not change the dialog's size.

## Open common dialogs

| Task | Command |
| --- | --- |
| Find an action | Ctrl+P |
| Change settings | `/settings` |
| Choose a model | `/model` |
| Review an earlier conversation point | `/rewind` |
| Manage standing preferences | `/nudges` |
| Manage extensions | `/extensions` |

Rewind previews the change before confirmation. It changes conversation
history, not workspace files or external effects. Enter confirms; Escape
returns to the previous screen.

## Read an inspection report

`/diagnostics`, `/doctor`, and `/context` open reports. In `/diagnostics`,
choose Session for the conversation or Vera for the host. Escape from a
report returns to that menu.

Drag to copy a section, or press Enter to copy the complete Markdown report.
Escape closes a standalone report without adding it to the transcript.
Tab, Left/Right, and Space have no action inside these reports.

On a diagnostics report, V checks whether a library model can answer. It
makes no such check until you request it. See [Troubleshooting](troubleshooting.md).

## Change dialog appearance

Add appearance settings to the home's `config.json` and relaunch the TUI:

```json
{
    "tui": {
        "dialogs": {
            "header_style": "box",
            "search_style": "border"
        }
    }
}
```

### Title style

| Value | Appearance |
| --- | --- |
| `underline` | Default title with an underline. |
| `box` | Inset filled title box. |

### Search-field style

| Value | Appearance |
| --- | --- |
| `fill` | Default neutral background without a border. |
| `border` | Thin border with the dialog background inside. |
| `plain` | One text row without fill, border, or leading padding. |

Removing either setting restores its default. Search styles preserve normal
typing, selection, cursor movement, and paste behavior.

## Dialogs and background work

Global dialogs dim the screen, including the rail. A question or approval
from the current conversation leaves the rail visible for context, but its
controls stay inactive until the request ends.
