# btw

A readonly hosted agent beside the main conversation.

```
/btw                         # open the sidekick
/btw inspect the auth flow   # open it and send a message
@sidekick what did you find  # sidekick only, without changing focus
@all compare conclusions     # both visible agents
@sidekick                    # focus the sidekick
@vera                        # focus the main agent
```

Press `Ctrl+B` to switch focus between the two agents. A bare message goes to
the focused pane, and the sidebar shows a green rail while it is selected.
Mentions override focus for one message; only agents currently open in the two
panes are mentionable. Pointer input remains available for text selection and
resizing, but does not change agent focus.

The sidekick is a real hosted Vera session. It has its own transcript and can
continue running if its pane is replaced. `/btw` creates it with readonly
permissions, so it can inspect the workspace but cannot run bash or mutate
files. Use the focused session's permission controls if you deliberately want
to promote it.

This extension supplies only the `/btw` policy: readonly by default, sidebar
placement, and the `sidekick` mention. Vera owns agent creation, attachment,
message routing, permissions, and rendering.

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
