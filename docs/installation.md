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
commands. Vera verifies the release before activating it. If a host is running,
the installer stops it and starts the new release's host. A failed upgrade
leaves the previous release active.

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
