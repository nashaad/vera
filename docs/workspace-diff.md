---
title: "Review workspace changes"
description: "Inspect changed files and patches in the current Git worktree or another worktree of the same repository."
---

# Review workspace changes

Run `/diff` to inspect staged, unstaged, and untracked changes in your current
Git worktree. Patches appear on the left and a file tree on the right.
The viewer does not edit, stage, or revert files.

## Browse files and patches

<div data-widget="screen-steps" data-steps="workspace-diff"></div>

Select a file with Up/Down and press Enter to open it. Tab switches focus
between the tree and patches. Left/Right folds or expands folders.
File headers show additions and deletions.

| Key | Action |
| --- | --- |
| PageUp / PageDown | Scroll the patch. |
| N / P | Next / previous file. |
| `[` / `]` | Previous / next hunk. |
| B | Show or hide the file tree. |
| S | Switch between one patch and all patches. |
| V | Switch split / unified view when space permits. |
| M | Mark the file reviewed for this view. |
| W | Choose another worktree. |
| Escape or Q | Return to the conversation. |

Close and reopen `/diff` to refresh the changes.

## What the view includes

Tracked changes are compared against HEAD. Untracked files appear as
additions. Binary files and oversized untracked files show preview notices.

The view shows one worktree at a time. It does not identify who made an
edit.

## Look at another worktree

If the repository has more than one worktree, press W in the diff view. A list
shows each worktree with its branch and how many files have changed, and marks
the one this session works in. Choose one with Up/Down and press Enter. The
heading names the worktree you are looking at and says `other worktree` when
it is not this session's. Escape returns to the diff you were on.

To open another worktree directly, give its folder or branch name:

```text
/diff plunder
/diff feat/plunder
```

## Disable the viewer

The viewer is the included `vera.diff` extension, which runs in the TUI. Add
`"vera.diff"` to `disabled_included_extensions`, then run
`/reload-extensions` or restart the TUI.
