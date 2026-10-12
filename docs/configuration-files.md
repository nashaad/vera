---
title: "Edit configuration files"
description: "Open the right home or project configuration in your editor."
---

# Edit configuration files

Use `/configure` when you need to edit configuration directly. For a setting
with a dedicated control, use `/settings` or its feature screen so Vera can
validate your choice.

## Open a file

1. Run `/configure`.
2. Use Up/Down to choose the configuration.
3. Press Enter to open it in your editor, or Escape to cancel.

The picker always offers Home config. Optional files appear only when they
already exist; choosing configuration does not create them.

## Choose the scope

| File | What it controls |
| --- | --- |
| Home config | Provider, model, permission, extension, and hook defaults for this home. |
| TUI preferences | Theme, layout, animation, live reasoning rows, and the `keybindings` block in `tui.json`. |
| Project config | Configuration in the attached workspace's `.vera/config.json`. |

`/settings` remains a separate menu of settings controls. For a map of other
saved data, see [Vera's files and settings](config-reference.md).

## Assistant message dots

Set `assistant_marker` at the top level of the home's `tui.json`:

```json
{
    "assistant_marker": "●"
}
```

Use `"●"` for large dots (the default), `"•"` for small dots, or `""` to hide
them. Hiding the dot keeps the text aligned. This affects only assistant
messages, not list bullets or status indicators. There is no Settings control.
Restart the TUI after editing the file.
