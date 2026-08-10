# btw and pair

Readonly sidekicks and tool-capable peers beside the main conversation.

```
/btw                         # open the sidekick
/btw inspect the auth flow   # open it and send a message
/pair investigate the bug    # open a tool-capable peer and send a message
@sidekick what did you find  # sidekick only, without changing focus
@all compare conclusions     # both visible agents
@sidekick                    # focus the sidekick
@vera                        # focus the main agent
```

Press `Ctrl+G` to switch focus between the two agents while both are visible.
A bare message goes to the focused pane, and a green rail marks its target.
Mentions override focus for one message; only agents currently open in the two
panes are mentionable. Pointer input remains available for text selection and
resizing, but does not change agent focus.

`Ctrl+/` cycles split, side-agent-only, and Vera-only layouts. Focus follows a
solo pane, so the composer never addresses an agent that is off screen. The
footer names the active `btw` or `pair` mode and the current layout.

`/btw` starts its agent in `readonly`; `/pair` starts its peer in `ask`. The
sidebar header always shows the attached name and effective permission mode.
BTW's pane attachment is ephemeral, while Pair's attachment is restored across
Vera restarts. The peer conversation remains available through `/resume` even
after its pane is closed.

The sidekick is a real hosted Vera session. It has its own transcript and can
continue running if its pane is replaced. `/btw` creates it with readonly
permissions, so it can inspect the workspace but cannot run bash or mutate
files. Use the focused session's permission controls if you deliberately want
to promote it.

This extension supplies the `/btw` and `/pair` policies: permission defaults,
attachment lifetime, sidebar placement, addressing, mode and layout status, and
the pane layout and focus keys. Vera owns agent creation, attachment, validated
message delivery, permissions, persistence, and the generic TUI pane surface.

## Install

Add it to your Vera config:

```json
{
  "extensions": [
    { "path": "/path/to/vera/examples/extensions/btw", "enabled": true }
  ]
}
```

## Capabilities it uses

- `client.commands.register` for `/btw [message]`
- `client.agents` to create, attach, and message the hosted sidekick
- `client.ui.mentions` for the visible-agent composer names
- `client.experimental_tui` for mode status and pane-surface control
- `client.keybindings.register` for `Ctrl+G` and `Ctrl+/`
