---
title: "Keyboard shortcuts"
description: "Use the common controls and remap supported actions."
---

# Keyboard shortcuts

Vera's command palette and dialog footers show the controls available in the
current screen. A picker may use a shortcut differently from the composer.

## Common controls

| Key | Action |
| --- | --- |
| Ctrl+P | Open the command palette. |
| Ctrl+X, then M | Open Switch model. Release Ctrl before M. |
| Shift+Tab | Open quick model, effort, access, and definition controls. |
| Ctrl+E | Open the conversation list. |
| Ctrl+F | Search the conversation on screen. |
| Ctrl+Shift+F | Search across conversations. |
| Ctrl+G | Change focus between conversation panes. |
| Ctrl+\ | Cycle split and single-pane layouts. |
| Ctrl+C | Stop work, clear an idle draft, or exit with an empty composer. |

Ctrl+C also exits when a stop is in progress. Other conversations can remain
running after the TUI exits. See [Saved conversations](sessions.md).

## Remap an action

`tui.json` maps supported action IDs to key combinations. It does not define
new actions or macros. For example:

```json
{
    "keybindings": {
        "open_model_picker": ["shift+tab"],
        "dials.open": ["ctrl+d"]
    }
}
```

An empty list unbinds an action:

```json
{ "keybindings": { "open_model_picker": [] } }
```

The help pane lists action IDs and shows the effective shortcuts after
remapping.

### What can be remapped

Supported remaps cover actions that open visible pickers and navigation
inside them. Core controls such as interrupt, Enter, Escape, text editing,
and scrolling remain fixed. Actions that change state without opening a
screen cannot be remapped.

### Key names

Use lowercase names with modifiers first, such as `ctrl+shift+tab`.
Supported modifiers are `ctrl` and `shift`. `alt`, `meta`, and `option` are
rejected because reporting differs between terminals.

Keys include `tab`, `backtab`, `enter`, `esc`, `space`, arrows, `home`, `end`,
`pageup`, `pagedown`, `delete`, `backspace`, `insert`, `f1` through `f12`, and
single printable characters.

Ctrl+Shift+letter combinations require a terminal that supports the kitty
keyboard protocol. Vera accepts them and shows a startup notice.

## Fix a rejected binding

Invalid entries are ignored and named at startup. They do not prevent the
TUI from starting. For example:

```text
keybinding ignored: dials.opne: unknown binding id
keybinding ignored: interrupt: this binding cannot be moved
```

If two actions use the same chord in the same scope, both remaps are ignored
and their defaults return. Correct the named entries rather than relying on
one to take precedence.
