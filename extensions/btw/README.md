# btw and pair

Included extension for read-only sidekicks and tool-capable peers beside the main conversation. No side conversation starts until requested.

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

`Ctrl+\` cycles split, side-agent-only, and Vera-only layouts. Focus follows a
solo pane, so the composer never addresses an agent that is off screen. Vera's
composer footer keeps the mode and layout controls in their usual location.

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

A new sidekick inherits the primary conversation as reference context, then
starts behind a hidden boundary that makes only later sidekick messages active
instructions. `/pair` remains a fresh conversation rather than inheriting the
primary transcript.

This extension supplies the `/btw` and `/pair` policies: permission defaults,
attachment lifetime, sidebar placement, addressing, and the pane layout and
focus keys. Vera owns agent creation, attachment, validated
message delivery, permissions, persistence, and the generic TUI pane surface.

## Extension boundary

BTW is built from general client-extension primitives rather than a built-in
sidekick mode. `vera.agents.create()` can either create a fresh hosted agent or
branch a visible one with structured history. A branch may append bounded
initial user messages before its first turn; hidden messages remain visible to
the model but not the transcript and never count as user authorization.

An initial message may also be a compaction barrier. Vera can summarize history
before that seam but will not compact across it. This is intentionally
conservative: exact context ordering wins over reclaiming the later side
conversation. Hosts negotiate initial-message and compaction-barrier support
separately, so a mixed-version client fails clearly instead of silently losing
either behavior.

The extension owns the boundary wording and decides that BTW branches while
Pair starts fresh. The runtime only understands generic branch, message,
permission, attachment, and compaction semantics.

## Configuration

This extension ships with Vera. No separate installation is needed.
To disable the included copy, add `vera.btw` to `disabled_builtin_extensions`
in the home's `config.json`, then restart the client.
An explicitly configured or installed copy with the same ID replaces the
included copy, including when that explicit copy is disabled.

## Capabilities it uses

- `client.commands.register` for `/btw [message]`
- `client.agents` to create, attach, and message the hosted sidekick
- `client.ui.mentions` for the visible-agent composer names
- `client.experimental_tui` for pane layout and focus control
- `client.keybindings.register` for `Ctrl+G` and `Ctrl+\`
