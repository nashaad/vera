---
title: "Plugins page"
description: "Browse the instructions, definitions, skills, and extensions available to Vera."
---

# Plugins page

Plugins shows the sources that shape Vera's behavior. The desktop window has a
Plugins page, and the terminal opens the list with `/plugins`. Use either to
find a project instruction file, inspect a skill, or open a reusable definition
in your editor.

## The desktop page

Open Plugins from the sidebar, the Go menu, or the command palette. The page
reads what a session in the selected folder loads.

The toolbar holds a search field, a kind control, and Reload. The kind control
lists Plugins, Skills, Agents, Extensions, Instructions, and Memory with counts,
and the search field follows the selected kind. The page opens on Skills. Add
appears on Plugins with Install from folder, described as "A plugin folder".
On Extensions, Add offers Install from file.

The list stacks its scopes as sections. In this folder comes first, with its
count, a note naming the folder, and the folder menu on the right. The menu
chooses which folder to read, and Reload reads it again. Your home follows with
its count and a note that it loads in every folder. Built in sits last, starts
collapsed, and opens from its chevron; a kind with no items in that section has
no Built in section. Included extensions' skills and agents appear there. The
Plugins kind has only Your home because plugins are installed in the home.

Each section shows its first six rows in two columns, then a line naming the
next items; the line opens the rest of that section only. An empty In this
folder says so and notes that items from your home load there too. An empty
Your home says so. The empty Plugins kind says that no plugins are installed
and points to Add. With no folder selected, the folder menu reads `No folder`
and the section says there are none there.

Search filters every section. A section with no match hides, Built in opens
while it has a match, and when nothing matches the page says so.

Each row shows the kind's icon, the name, a one-line description, and a meta
line. The meta line reads `From <extension id>` when an installed extension
brought the item, or `From <plugin>` when a plugin brought a skill or agent,
followed by the skill's slash command or another kind's file path.
Paths read from the folder lose it, and paths in your home start with `~/`. An
instruction row shows the file's name, with its path on the meta line. Items
traced to an installed extension or plugin appear under Your home. A check marks
an item that is present, and the three-dot button opens the row menu. A disabled
desktop extension or plugin shows Off and a dimmed tile. A plugin package row
shows its parts summary on the meta line.

Selecting an ordinary row opens a sheet. The Overview tab shows the file
rendered as Markdown beside Location, Scope, Loads in, Command, and Files. The
Files tab shows the one file that was read, with a toggle between the rendered
file and its numbered source. The three-dot menu offers Open in editor, Show in
Finder (Open folder away from macOS), Copy Markdown, and Copy path. Try now
appears for skills: it opens a new chat with the skill's command in the composer
and does not send it.

Plugin skill and agent rows and plugin package rows are read-only. They have no
Open in editor, Uninstall, or switch action. A plugin package sheet shows its
name with "Plugin", its On or Off state as a plain label, its parts summary,
and its skills and agents as lists. Location, State, and Parts appear in its
facts column; its three-dot menu offers Show in Finder and Copy path only. The
sheet says to change a plugin with `vera plugin disable <name>`,
`vera plugin remove <name>`, or `/plugins` in the terminal.

On the Extensions kind, Add opens a menu with Install from file. An extension's
sheet has a switch that turns the extension on or off and an Uninstall button.
The extensions included with Vera are always on and are not listed. Their skills
and agents still appear under Skills and Agents, in Built in.

On the Plugins kind, Install from folder opens a folder chooser and then a
preview of the selected package. The preview shows its name, version, skills,
agents, MCP servers and transport, extension parts, ignored parts, and warnings.
Choose Install or Cancel. If the manager refuses the preview, the sheet shows
the reason and only offers Close. Install reports the result, then refreshes
the list so the plugin and its items appear. If the package includes a desktop
extension, the report says to reload desktop extensions or restart the app.
Preview and install run in a separate task process, not the desktop main
process. See
[Plugins](plugins.md) for package details.

Discover shows the theme catalog. Yours shows the list above.

## In the terminal

1. Run `/plugins` with no argument to open the browser. `/customize` and `/plugin` also work as aliases, with or without arguments; use `/plugins` for package operations described in [Plugins](plugins.md).
2. Choose Agents, Skills, Instructions, Memory, Plugins, or Extensions.
3. Type to search names, descriptions, scopes, and paths.
4. Press Enter on a result to preview its saved contents.

On Home, `/plugins` starts a conversation and opens the browser there.

Tab moves between Search and the list. Escape returns one level. The preview
shows where a source comes from and whether it belongs to the project or home.
A skill turned off by `disabled_skills` stays in the Skills list, marked
disabled. See [Turn a skill off](skills.md#turn-a-skill-off).

Extensions lists the extension folders you added to `config.json`. The
extensions included with Vera are not listed; manage them with `/extensions`.
Their skills and agents still appear under Skills and Agents.

Plugins lists each installed plugin with a summary of its parts and whether it
is on or off. Its skills appear under Skills and its agents under Agents, with
the scope naming the plugin, such as `plugin sea-chest`. Plugin items are
read-only here. See [Plugins](plugins.md) for package operations.

A Markdown file opens rendered. Press `s` to see its source.

## Edit a source

In the terminal, press Ctrl+O in a writable file's preview to open it in your
editor. Vera uses the editor set in `VISUAL` or `EDITOR`, and falls back to `vi`
when neither is set.

Vera reloads the preview when the editor closes. A terminal editor such as
`vi` or `nano` stays open until you quit, so this works on its own. A
graphical editor such as VS Code hands the file to its window and returns at
once, so Vera reloads before you have made any changes. Add its wait flag,
as in `EDITOR="code --wait"`, and it returns only when you close the file's
tab.

Bundled skills, plugin items and extension-provided definitions are read-only
here. Close and reopen Plugins to refresh all catalogs after changes.

### If an edit is invalid

An invalid definition appears as a catalog notice and is unavailable for use.
Correct the file and reopen Plugins. If the editor cannot start, the
preview stays open and shows the error.

## See what was loaded

Available sources are not necessarily loaded into the conversation. Loading
labels describe the last measured request. Individual skill loading is not
measured.

With the Context extension enabled, `/context sources` opens the sources
from its usage report. See [Inspect context usage](context-usage.md).

Memory loading and writing are disabled. The Memory category can display
existing files, but Vera does not recall them into new requests.
