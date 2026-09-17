---
title: "Included extensions"
description: "Use planning, side conversations, context inspection, and other capabilities that ship with Vera."
---

# Included extensions

Vera includes extensions for planning, side conversations, workspace diffs,
context inspection, and command hooks. They appear in `/extensions` and
`/customize`; no separate installation is needed.

## Plan before making changes

Use `/agent plan` to investigate and plan with read, search, and listing
tools. Use `/agent default` to return to the default definition.

Selecting Plan from auto or full_access changes access to readonly. Selecting
one of those incompatible access modes later returns to the default definition.

### Configure Plan

Plan's extension configuration supports:

| Option | Effect |
| --- | --- |
| `compose_suggestion: true` | Offer to switch from the composer. Off by default. |
| `allow_skill_scripts: true` | Allow guarded scripts from permitted skills. Off by default. |
| `skills` | List allowed skills. Omit for installed skills, or use `[]` for none. |

A home or project `plan.md` overrides the included definition.

## BTW and Pair

Use `/btw` for a read-only side conversation that can refer to the primary
conversation. `/btw <message>` opens it and sends the message. Its pane is
temporary.

Use `/pair` for a fresh peer conversation with ask permissions.
`/pair <message>` sends a message as it opens. `/pair close` closes its pane.
Pair attachments survive restart, and the conversation is available in `/resume`.

### Work with two panes

Ctrl+G changes focus. Ctrl+\ cycles split and single-pane layouts.
`@sidekick`, `@peer`, and `@vera` address the currently visible conversation;
`@all` addresses both visible conversations.

## Inspect changes and context

Use `/diff` to [review workspace changes](workspace-diff.md). Use `/context`
to [inspect context usage](context-usage.md). The Context extension also
provides `/dashboard`; disabling it removes both commands.

## Run command hooks

Command hooks run configured executables around tool calls. With no hooks
configured, the extension runs nothing.

Find `example.command-hooks` in `/customize` under Extensions and note its
absolute path. Add an explicit entry to the home's `config.json`:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/extensions/command-hooks",
        "enabled": true,
        "config": {
            "hooks": [{
                "phase": "pre_tool_use",
                "argv": ["/absolute/path/to/hook"],
                "protocol": "vera",
                "timeout_ms": 1000
            }]
        }
    }]
}
```

### Hook behavior

`argv` contains the executable and arguments, without shell expansion. Scripts
receive JSON on stdin and return a hook result as JSON on stdout. The default
timeout is one second; the maximum is 30 seconds.

Scripts run with Vera's operating-system access. Hook failures do not guarantee
a blocked tool call, so hooks should not be used as a security boundary.
Malformed supplied configuration prevents activation.

## Configure or disable included copies

Use the extension manager for available controls. To suppress included copies
in configuration, name their IDs in `disabled_builtin_extensions`:

```json
{
    "disabled_builtin_extensions": ["example.plan", "example.command-hooks", "vera.btw"]
}
```

Other included IDs include `vera.diff` and `example.context`. An explicit
extension entry with the same ID replaces the included copy, even when that
explicit entry is disabled. It keeps its own configuration.

For Plan configuration, use an explicit entry with the absolute path shown in
Customize. Restart the host for command-hook or Plan changes. Restart the
client for Plan or BTW changes.
