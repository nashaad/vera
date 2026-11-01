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
`$HOME/.local`. A test prefix stops and starts only the host of the home that
`VERA_HOME` selects. Set `VERA_HOME` to a private home for a test install.
Against the default home the install is refused before anything is stopped.
The daily prefix goes with the default home, so an install without `--prefix`
is refused when `VERA_HOME` selects another home. Unset `VERA_HOME` for a
daily install.

## Roll back

`vera rollback` makes the previous release active again, without packing or
using the network. If a host is running, it stops it first and starts the
restored release's host afterward, as an install does. Failure leaves the
release that was active before. `--prefix DIR` and `VERA_HOME` pair the same
way as for an install. If an earlier install or rollback was interrupted,
`vera rollback` finishes it, names the release that is now active if there is
one, and rolls nothing back. If that is not the release you want, run
`vera rollback` again.

## Run checkout code

Use [development instances](runtime-and-worktrees.md) for isolated testing.
`bun run tui` packs into a checkout's `dist/release/` and starts its TUI;
it does not replace the installed command.
