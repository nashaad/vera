---
title: "Find a command"
description: "Search available actions or read the command-line reference."
---

# Find a command

Vera has a command palette for actions and help pages for learning the controls.
Use Ctrl+P to find an action, `/commands` to browse executable commands, or
`/help` to read guidance without running anything.

## From the terminal

```sh
vera help
vera help <topic>
```

`vera help` lists commands, flags, and available topics. `vera --help` and
`vera -h` show the same reference. Topic aliases resolve to their canonical
names. Help works without a running host, provider, or network request.

## In the TUI

`/palette` opens the same command palette as Ctrl+P. In `/help`, choose a
page with Up/Down and Enter. Escape returns to the menu.

The help pages are General, Keys, Slash commands, and Extensions. General is
text; the other pages are searchable lists. Tab moves between Search and the
list. Typing from the list starts a search.

### Conversation commands

Enter these in the composer. A command that opens a picker uses Up/Down to
choose, Enter to open, and Escape to return. Commands act on the focused
conversation unless they open a broader browser.

| Command | What it does |
| --- | --- |
| `/resume` | Choose a saved conversation to resume. |
| `/search` | Search past work. |
| `/work` | Show conversations that need you or are running. |
| `/rename [name]` | Name the conversation, or remove its name when omitted. |
| `/clone` | Duplicate the conversation. |
| `/fork` | Choose an earlier prompt to fork from. |
| `/rewind` | Choose a point to rewind the active conversation. |
| `/compact` | Summarize earlier messages to free context. |
| `/fresh` | Start a new conversation and keep this one running. |
| `/close` | Stop this conversation and retain its saved file. |
| `/subagents` | List this conversation's asynchronous children. |
| `/parent` | Return to the parent conversation. |
| `/back` | Return to the previously viewed conversation. |

See [Switching conversations](session-switching.md) for what keeps running
when you move between them, and [Context settings](context-levers.md) for
compaction controls.

### Settings and inspection

| Command | What it does |
| --- | --- |
| `/model` | Open Switch model. |
| `/models` | Browse every model, with favorites, defaults, and providers. |
| `/effort [level]` | Set the next turn's reasoning effort; supported levels depend on the model. |
| `/agent [name]` | Choose a definition, or switch to the named one. |
| `/settings` | Open settings controls. |
| `/configure` | Choose a configuration file to open in your editor. |
| `/themes` | Choose a terminal theme. |
| `/nudges` | Manage standing preferences. |
| `/extensions` | Inspect and manage extension copies. |
| `/diagnostics` | Inspect the current session or resident host. |
| `/reconnect` | Reconnect through the host recovery flow. |
| `/usage` | Open recorded usage and cost. |
| `/failure-report` | Write a report of recorded model failures. |

Installed skills and extensions contribute commands too. Their availability
depends on the active definition and enabled extensions. Use `/help` for the
commands currently loaded, or read [Included extensions](included-extensions.md).

## For another tool

`vera help --llms` prints all help topics as compact Markdown for another
program. It uses the same content as the topic commands.
