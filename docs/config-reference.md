---
title: "Vera's files and settings"
description: "Find your settings, reusable instructions, and saved conversations."
---

# Vera's files and settings

Vera keeps your personal settings and conversation history in `~/.vera`.
Project-specific customization lives with the project. The installed
application is separate from both.

For most changes, use the relevant settings screen. `/configure` opens
configuration files in your editor, and `/customize` browses instructions,
definitions, skills, and extensions.

## Find what you need

| You want to | Start here |
| --- | --- |
| Connect a provider or change credentials | [Configure providers](first-run-setup.md) |
| Choose or assign a model | [Models and defaults](models.md) |
| Edit a home or project setting | [Configuration files](configuration-files.md) |
| Inspect instructions or a skill | [Customize](customize.md) |
| Change keyboard shortcuts | [Keybindings](keybindings.md) |
| Return to saved work | [Saved conversations](sessions.md) |

Home settings apply to this Vera home. An existing project configuration at
`.vera/config.json` appears separately in `/configure`.

## Files you can customize

These paths are inside `~/.vera`:

| Path | Purpose |
| --- | --- |
| `config.json` | Provider, permission, model, extension, and hook settings. |
| `tui.json` | Display preferences and keybindings. |
| `skills/` | Installed skills. |
| `agents/` | Reusable definitions. |
| `extensions/` | Installed extensions. |
| `standing-nudges.json` | Preferences managed through `/nudges`. |

Use a validating settings screen when one is available. The file editor is
useful for settings without a dedicated control.

## Data Vera manages

These files support the application and its saved work. Use the corresponding
Vera screen or command to manage them.

| Path inside `~/.vera` | Contents |
| --- | --- |
| `runtime/sessions/` | Saved conversation files. |
| `runtime/logs/` | Diagnostic logs. |
| `runtime/` | Host socket, databases, and caches. |
| `machine/` | Credentials and live process records. |
| `pool.json` | Saved model catalog data. |
| `preferences.json` | Saved permission answers. |
| `extensions.json` | Installed-extension registry. |
| `tips.json` | Tips already shown. |
| `memory/` | Existing memory files; loading and writing are disabled. |

One resident host owns a home's runtime directory. Clients attached to it
share live conversations. Existing memory files may appear in Customize but
are not recalled into requests.

## Use a separate development home

`VERA_HOME` relocates the entire tree for tests and development instances.
There is no profile flag or separate runtime-directory selector. Use
[development instances](runtime-and-worktrees.md) to test a checkout apart
from your daily Vera.

An older home containing `profiles/` is refused with instructions to run
`vera migrate-home`.
