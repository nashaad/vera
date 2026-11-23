---
title: "Manage extensions"
description: "Inspect installed capabilities, configure them, and enable or disable copies."
---

# Manage extensions

Extensions add capabilities to Vera. Run `/extensions` to inspect included
and plugin-owned extensions, their contributions, and their state. The same
screen is available from **Manage extensions** in Ctrl+P.

Installed plugins live in the Vera home. Vera does not load extensions from a
project folder; a `.vera/extensions` directory in a workspace is ignored.

A plugin is the package you install. It can hold an extension together with
skills, agents, and MCP servers. See [Plugins](plugins.md).

A plugin can include a desktop extension. Turn the plugin on or off with
`/plugin enable <name>` or `/plugin disable <name>`, and remove it with
`vera plugin remove <name>`; the desktop extension's own switch and Remove
do not change the plugin. See [Desktop extensions](desktop.md#desktop-extensions).

A plugin's host extension loads with the host when the plugin is on. Its
configuration can come from an `extensions` entry for its installed directory;
the plugin switch controls whether it loads. See [Plugins](plugins.md#host-extensions).

To write your own, see [Extension APIs](extension-apis.md).

## Install a local extension

Enter this in the composer with the source directory's path:

```text
/extension install <path>
```

The folder installs as a plugin, and the result names that plugin and its
capabilities. See [Permission rules](permission-rules.md). `/extension list`
opens `/extensions`; `vera extension list` lists included and core extensions.

## Inspect or change a copy

Use Up/Down to choose an extension and Enter to open details. The screen shows
its version, group, status, capabilities, path, and source. Rows are grouped as
Installed, Included, and Core. Plugin-owned rows are read-only: use `/plugin`
to turn the plugin on or off or remove it.

Space enables or disables an included or core copy by editing
`disabled_included_extensions` in `config.json`. Included copies cannot be
removed. `/extension enable <id>` and `/extension disable <id>` name the plugin
command when the extension belongs to a plugin. `/extension remove <id>`
removes its plugin when that plugin contains only the extension. If it has
other parts, the command names `/plugin remove <name>` instead. If migration
has left a legacy copy active, removal deletes it and prints its path.

### Understand status

| Status | Meaning |
| --- | --- |
| enabled | The copy is enabled. |
| disabled | The copy is turned off. |
| failed | The manifest did not load, or the host could not load the code. The row shows why. |

## Apply configuration changes

Loaded extensions expose their settings commands on the detail page. For
example, choose `vera.web-search`, then **Search providers**, to configure
[web search](web-search.md).

After a change, the TUI side of an extension reloads and the manager
refreshes. The host side needs a resident-host restart: when the extension has
host code, the note says to choose **Reconnect host** from Ctrl+P, which
restarts the host while this client is still connected. Until then the row
shows the new status, but the host still runs what it loaded at startup. The
transcript collects changes in one note; Ctrl+T collapses or expands it.

Editing `config.json` directly takes the same path. The running host notices
the change within a second and leaves the same note, naming the extension and
the restart. Enabling an extension works the same way: its client side loads
now and its host side loads at the next start. Sessions started before that
restart keep the tools the host loaded at startup.

For credentials, use exact `{env:NAME}` references in extension configuration.
See [Extension credentials](extension-credentials.md).

## Try checkout extensions

From a development worktree:

```sh
VERA_EXTENSIONS=extensions/btw,examples/extensions/plan bun run dev:tui
```

`VERA_EXTENSIONS` replaces the configured list with the supplied comma-separated
directories. It does not append them. A running host keeps the list from its
startup. See [Development instances](runtime-and-worktrees.md).

