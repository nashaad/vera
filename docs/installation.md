---
title: "Installation and upgrades"
description: "Install Vera from a checkout and activate a verified release."
---

# Installation and upgrades

Install Vera from its source checkout using Bun. The installer builds and
verifies a release, then makes it available as the `vera` command.

## Install

From the checkout's root directory:

```sh
bun install
bun run install:local
```

The release is installed under `~/.local/share/vera/`. Its launcher is
`~/.local/bin/vera`.

### Add the launcher to PATH

If your shell cannot find `vera`, add this to your shell startup file and
reload the shell:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

### Check the installation

```sh
command -v vera
vera --version
vera --help
```

The first command should identify `~/.local/bin/vera`. If it names another
installation, correct PATH before continuing. Help needs no provider or
running host.

Change to your project directory, run `vera`, and follow
[Getting started](getting-started.md).

## Upgrade

From the checkout containing the version you want, run the same installation
commands. Vera verifies the release before activating it. With no host running,
the release becomes active at once. With a host running, the installer unpacks
the release and leaves `current` where it is. The host then moves to the new
release when its running turns end. From a terminal the install waits and
prints what the host waits on. From inside a Vera session it returns at once,
and the update happens when the session's running turns end. A failed start of
the new host restores the previous release and starts it again. A test
`--prefix` is refused unless `VERA_HOME` selects a private home, and the daily
prefix is refused when `VERA_HOME` selects another home; see
[Activate a new release](installed-command.md#activate-a-new-release).

The installer never signals the running host. When it cannot confirm the host
from the lockfile, or the host does not answer, the host keeps running, current
stays where it was, and the install says why. Run `vera host stop` once to stop
that host, then install again. An install never starts a second host next to a
live one.

The installed command runs the activated release. Editing checkout files or
restarting the TUI does not install those edits. See
[The installed command](installed-command.md).

## Test a checkout without upgrading

From a worktree, run:

```sh
bun run dev:tui
```

This uses a private development home instead of daily data. See
[Development instances](runtime-and-worktrees.md) for status and cleanup.
