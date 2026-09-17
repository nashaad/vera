---
title: "Customize Vera"
description: "Browse the instructions, definitions, skills, and extensions available to Vera."
---

# Customize Vera

`/customize` shows the sources that shape Vera's behavior. Use it to find a
project instruction file, inspect a skill, or open a reusable definition in
your editor.

## Browse a source

1. Run `/customize`.
2. Choose Agents, Skills, Instructions, Memory, or Extensions.
3. Type to search names, descriptions, scopes, and paths.
4. Press Enter on a result to preview its saved contents.

Tab moves between Search and the list. Escape returns one level. The preview
shows where a source comes from and whether it belongs to the project or home.

## Edit a source

Press Ctrl+O in a writable file's preview. Vera uses `VISUAL`, then `EDITOR`,
then `vi`. For a graphical editor, use its wait option if you want the preview
to refresh when you finish editing.

Bundled skills and extension-provided definitions are read-only here. Close
and reopen Customize to refresh all catalogs after changes.

### If an edit is invalid

An invalid definition appears as a catalog notice and is unavailable for use.
Correct the file and reopen Customize. If the editor cannot start, the
preview stays open and shows the error.

## See what was loaded

Available sources are not necessarily loaded into the conversation. Loading
labels describe the last measured request. Individual skill loading is not
measured.

With the Context extension enabled, `/context sources` opens the sources
from its usage report. See [Inspect context usage](context-usage.md).

Memory loading and writing are disabled. The Memory category can display
existing files, but Vera does not recall them into new requests.
