---
title: "Manage extensions"
description: "Inspect installed capabilities, configure them, and enable or disable copies."
---

# Manage extensions

Extensions add capabilities to Vera. Run `/extensions` to see included
extensions and installed copies, what they contribute, and whether they are
enabled. The same screen is available from **Manage extensions** in Ctrl+P.

Installed extensions live in the home, under `extensions/`. Vera does not load
extensions from a project folder; a `.vera/extensions` directory in a
workspace is ignored.

## Install a local extension

Enter this in the composer with the source directory's path:

```text
/extension install <path>
```

Then open `/extensions` to inspect the installed copy. `/extension list`
opens the same manager.

## Inspect or change a copy

Use Up/Down to choose an extension and Enter to open details. The detail
screen shows its version, group, status, contributed capabilities, path, and
source when recorded. Rows are grouped as Installed, Included, and Core.

Space enables or disables a managed or included copy. For an included copy
this edits `disabled_included_extensions` in `config.json`. **Remove** opens a
confirmation; it deletes the managed copy and leaves the source untouched.
Included copies cannot be removed. Unmanaged copies have no enable/disable
shortcut.

### Understand status

| Status | Meaning |
| --- | --- |
| enabled | The copy is enabled. |
| disabled | The copy is turned off. |
| failed | Loading failed. Inspect the details. |
| unmanaged | The copy is not managed through this installation registry. |

Installed copies appear above included ones. Desktop and web expose the same facts in their own lists.

## Apply configuration changes

Loaded extensions expose their settings commands on the detail page. For
example, choose `vera.web-search`, then **Search providers**, to configure
[web search](web-search.md).

After a change, the TUI side of an extension reloads and the manager
refreshes. The host side needs a resident-host restart. The transcript collects changes
in one note; Ctrl+T collapses or expands it.

For credentials, use exact `{env:NAME}` references in extension configuration.
See [Extension credentials](extension-credentials.md).

## Try checkout extensions

From a development worktree:

```sh
VERA_EXTENSIONS=extensions/btw,extensions/plan bun run dev:tui
```

`VERA_EXTENSIONS` replaces the configured list with the supplied comma-separated
directories. It does not append them. A running host keeps the list from its
startup. See [Development instances](runtime-and-worktrees.md).

For browser work, see [Work in a Chrome tab](chrome-browser.md).
