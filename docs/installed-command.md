---
title: "The installed vera command"
description: "Understand which release runs when you type vera."
---

# The installed vera command

`vera` starts the activated release through `~/.local/bin/vera`. It runs
independently of a source checkout and its dependencies. Your settings and
conversations remain in `~/.vera`.

## Check which build you run

```sh
command -v vera
vera --version
```

The launcher should be `~/.local/bin/vera`. It follows the active release:

```text
~/.local/bin/vera
        |
        v
~/.local/share/vera/current -> releases/<build-id>
```

## Activate a new release

Run `bun run install:local` from the checkout you want to install. It packs
and verifies the release before changing the active version. If it stops an
existing host, it starts the new release's host afterward. Failure leaves the
previous release active.

`--prefix DIR` chooses a test installation prefix. The daily prefix is
`$HOME/.local`.

## Run checkout code

Use [development instances](runtime-and-worktrees.md) for isolated testing.
`bun run tui` packs into a checkout's `dist/release/` and starts its TUI;
it does not replace the installed command.
