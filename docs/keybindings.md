# Keybindings

Every key the TUI dispatches has an id. `tui.json` maps ids to chords, and
nothing else: there are no macros and no action definitions, so a remap can
only move a key Vera already has.

```jsonc
// ~/.vera/tui.json — put the permissions picker on shift+tab, dials on ctrl+d
{
  "keybindings": {
    "permissions.open": ["shift+tab"],
    "dials.open": ["ctrl+d"]
  }
}
```

An empty list unbinds:

```jsonc
{ "keybindings": { "open_model_picker": [] } }
```

## What can move

Only bindings that open a visible picker, and movement inside one. Interrupt,
enter, escape, cursor movement, text entry and scrolling stay where they are.
So does every binding that changes state without showing you anything: those
are grandfathered where they exist and no new one is accepted, which is what
stops blind cycling from being rebuilt out of a config file.

`vera` names the ids in the help pane (`?`), and the help pane renders from the
same merged table dispatch uses — so after a remap it shows your chord, not the
default.

## Chords

Lowercase, joined with `+`, modifiers first: `ctrl+shift+tab`. The two
modifiers Vera binds are `ctrl` and `shift`. `alt`, `meta` and `option` are
refused, because the TUI's key reader does not report them consistently across
terminals: a chord that carries one would validate and then never fire.

Key names: `tab`, `backtab`, `enter`, `esc`, `space`, `up`, `down`, `left`,
`right`, `home`, `end`, `pageup`, `pagedown`, `delete`, `backspace`, `insert`,
`f1`–`f12`, or a single printable character.

A `ctrl+shift+<letter>` chord only reaches Vera in terminals that speak the
kitty keyboard protocol. It is accepted, with a line at startup saying so.

## When something is wrong

Nothing in this block can stop the TUI from starting. A bad entry is ignored
and named at startup:

```
keybinding ignored: dials.opne: unknown binding id
keybinding ignored: interrupt: this binding cannot be moved
keybinding ignored: dials.open: alt+x: alt chords are not reported by every
  terminal, so Vera does not bind them
```

An unknown id is a warning rather than an error on purpose: a block written for
a newer Vera has to stay readable by an older one.

Two entries landing on the same chord in the same scope both stand down and the
defaults come back, with both ids named. Vera does not pick a winner, because
the pick would be a guess and the guess would be invisible.
