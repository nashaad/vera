---
title: "Plugins"
description: "Install a folder as a plugin, inspect it, turn it on or off, and remove it."
---

# Plugins

A plugin is the package you install. It can hold skills, agents, MCP servers,
and extension code. The code part is a host extension (`vera.extension.json`)
or a desktop extension (`vera.desktop.json`). A plugin with only skills has no
extension.

Vera reads a local folder in one of these forms:

- an Agent Plugins 1.0 package with a root `plugin.json`;
- a Claude plugin with `.claude-plugin/plugin.json`;
- a Codex plugin with `.codex-plugin/plugin.json`;
- a folder holding a Vera extension, with no plugin marker.

For an Agent Plugins package, Vera reads the parts named under
`extensions["dev.vera"]`: `agents`, `extension`, and `desktop`. Each names a
directory. The defaults are `dev.vera/agents/`, `dev.vera/host/`, and
`dev.vera/desktop/`. A Claude or Codex package can put a host or desktop
manifest at its root; a Claude package also gets its root `agents/` folder.
Claude commands, Claude and Codex hooks, and Codex's `.app.json` metadata
are not read, and the preview names anything Vera ignored.

Plugins live in the Vera home only. A workspace cannot bring one.

## What loads

An enabled plugin's skills load with the other skills, after enabled
extensions and before your home skills. Its agents load with the other agents,
after the included ones and before your own. Each item names the plugin it
came from in Customize, and plugin items are read-only. A plugin that is off,
whose installed folder is missing, or whose folder has no record loads
nothing.

An enabled plugin's host extension loads when the host starts. Its MCP servers
load through the `vera.mcp` extension when that extension is on. Its desktop
extension loads with other installed desktop extensions, with worker commands,
keybindings and themes. Task and page commands and menu entries are available
only to extensions included with the app. A plugin desktop extension stays
inside the plugin folder and follows the plugin's state; its individual switch
and Remove control refuse and name the plugin command to use.

## Host extensions

The host reads enabled plugins at startup and loads their host extensions with
the other extensions. It passes the startup extension settings to session
workers. If an installed plugin folder has been replaced or removed, a later
session worker skips its host extension and logs a warning. The host also
checks before starting a model-turn worker and logs the warning once per plugin.
Restart the host to load the replacement and to apply changes to the extension's
configuration or whether it is on. The folder check does not detect in-place
edits. Extension data stays under the extension's ID, which may differ from the
plugin's install name.

To configure a plugin's host extension, add an `extensions` entry in
`config.json` whose `path` resolves to the extension directory inside the
installed plugin. The entry supplies `config`; the plugin's on or off state
controls whether the extension loads, regardless of that entry's `enabled`.
`vera -p` print mode loads a plugin's host extension only when such an entry
names it and the plugin is on.

The TUI loads client capabilities from enabled plugin host extensions when it
starts or when you run `/extension reload`. A change to the plugin switch takes
effect there at the next TUI start or extension reload.

Install and its preview refuse a host extension ID already used by an
included or core extension or recorded for another plugin. If an installed
extension's ID is edited, the host skips that part and logs the mismatch. To
repair it, install the plugin again from its source.

While migration has not run or is held back, a legacy host extension is skipped
when its ID is recorded by a plugin, even when the plugin is off. The host log
names the skipped extension and its plugin.

## MCP servers

A plugin can declare a stdio server with `command`, `args`, `env`, and `cwd`,
or an HTTP server with `url` and `headers`; plain `http` is allowed only to
`localhost`, `::1`, or an address in `127.0.0.0/8`. `sse` servers, OAuth
fields (`auth`, `oauth`, `clientId`), servers that try to override
`PLUGIN_ROOT` or `PLUGIN_DATA`, servers named `__proto__`, `constructor`, or
`prototype`, and servers with `{env:` anywhere in their configuration are
skipped, and `vera plugin show` gives the reason. Vera never passes a
`{env:` reference to the host's environment expansion. Unknown server fields
are reported and ignored.

`${PLUGIN_ROOT}` and `${PLUGIN_DATA}` expand in `command`, `args`, `env`, and
`cwd`. A command or `cwd` that names a path must stay inside the plugin folder
or its data folder, including after symlink resolution; a bare program name
such as `node` is looked up on `PATH`. Header values stay literal:
`${PLUGIN_ROOT}` is not expanded there.

The plugin's server names join the servers in the home `vera.mcp` config. A
name already taken keeps its owner: the home config first, then the first
plugin by name, and the host reports the skipped server with both owners. When
`disabled_included_extensions` names `vera.mcp`, no plugin MCP server starts,
and `vera plugin show` and the install preview say so.

Two tools from one server that bridge to the same name keep the first and
suffix the later one with `_2`. When two servers bridge tools to the same
name, the later tool is skipped and the host logs it. A later prompt whose
bridged command name is already taken is skipped and logged.

## Install

```text
vera plugin install <path>
vera plugin install <path> --dry-run
```

The desktop Plugins page also installs a plugin from a folder; see
[Customize](customize.md#the-desktop-page). In the TUI, use
`/plugins install <path>`. The preview lists the skills,
agents, MCP servers with their transport, extension capabilities, ignored
parts, and each skipped MCP server with its reason. With
`--dry-run`, Vera prints the preview and stops.

Install and preview refuse a desktop extension id held by another plugin,
including one that is off, and name the plugin holding it. A replacement with
the same plugin name may keep its desktop extension id.

Install copies the package into `$VERA_HOME/plugins/<name>/` and records it in
`$VERA_HOME/machine/plugins.json`. It only reads the package: it does not run
the plugin's code, start an MCP server, or use a stored credential. A new
plugin is installed on.

Reinstalling the same folder with no changes leaves a matching installed copy
alone and restores one that is missing or damaged. Changed contents replace the
installed copy and keep the plugin's current on or off state. Installing a
folder whose Agent Plugins `name` is already taken replaces that plugin and
prints both source folders. Vera refuses a package that contains a symlink, a
special file, a path that leaves the folder, or more files or bytes than it
supports.

## List and show

```text
vera plugin list
vera plugin show <name>
```

`list` shows each plugin's name, version, state, and parts. It also flags a
plugin whose installed files changed after install. A plugin with no version
shows `-`. `show` prints the parts,
the source folder, when it was installed, the digest of the installed copy,
and the size of the plugin's data. In the TUI, `/plugins list` and
`/plugins show <name>` give the same output.

## Turn a plugin on or off

```text
vera plugin enable <name>
vera plugin disable <name>
```

One switch covers every part of the plugin. The model's skill list is rebuilt
on every turn, so an enabled or disabled plugin's skills take effect on the
running session's next turn. Agent lists are read again when agents are next
listed. A plugin with a host extension or MCP servers also needs a host
restart. A desktop extension list reads the plugin state again when refreshed;
reload the desktop extensions or restart the app to replace running code.
In the TUI, use `/plugins enable <name>` and `/plugins disable <name>`.

A skill turned off by `disabled_skills` stays off when a plugin brings it. A
user or project agent of the same name replaces a plugin agent, and Vera
reports the plugin it replaced. See [Use and write skills](skills.md) and
[Agents and delegated work](agents.md).

## Remove

```text
vera plugin remove <name>
vera plugin remove <name> --purge
```

Remove deletes the installed package and its record. For a plugin installed
from a local folder, the source folder is not touched. Plugin data in
`plugins/.data/<name>/` is kept so a reinstall finds it; `--purge` deletes that
data too. In the TUI, use `/plugins remove <name>`.

When migration was held back and a migrated plugin still has copies in an old
store, removal also deletes those copies and prints their paths. This prevents
them from loading or being migrated again.

## Migrate installed extensions

The host tries this migration at startup before loading plugins. If another
plugin operation holds the lock, it skips migration and keeps starting. Errors
are written to the host log, and legacy extensions remain available. Vera tries
again on the next host start; run the command below to retry sooner.

```text
vera plugin migrate
```

In the TUI, use `/plugins migrate`. Vera copies installed host and desktop
extensions into plugins, preserving their ids and on or off states. A host
and desktop extension with the same id and state share a plugin; otherwise
they remain separate. Existing extension data stays under its extension id.
The command updates matching extension paths in `config.json` and keeps their
configuration. Included and core extensions, other explicitly configured
paths, and `VERA_EXTENSIONS` are not migrated.

The report names copied and skipped extensions and any errors. An extension
that collides with an existing plugin or exceeds package limits remains in the
old store. Fix the reported issue and run the command again; completed copies
are skipped. If configuration cannot be updated, the plugins made by that run
are removed and the old stores remain active.

Once all extensions are copied, the old stores are renamed to
`extensions.pre-plugins`, `extensions.pre-plugins.json`, and the corresponding
names under `machine/desktop/`. These are rollback copies. A rollback copy
marks its store as migrated, so later entries in that store are not migrated.
After the desktop store is migrated, desktop extension installs and VS Code
theme imports stay there as desktop extensions, with their own switch and
Remove. Migration during host startup loads the migrated host parts in that
startup. After a manual migration, restart the host to load them. Restart the
desktop to load migrated desktop parts. An older desktop build cannot see those
parts; use a current build.

The TUI command `/plugin` remains an alias for `/plugins`.

## Files

- `plugins/<name>/` holds the installed copy.
- `plugins/.data/<name>/` holds the plugin's data.
- `machine/plugins.json` records the installed plugins and their state.
