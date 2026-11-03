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
leaves the previous release active. A test `--prefix` is refused unless
`VERA_HOME` selects a private home, and the daily prefix is refused when
`VERA_HOME` selects another home; see
[Activate a new release](installed-command.md#activate-a-new-release). The
installer does not signal a host whose start time the system cannot report; it
says so, leaves that host running, and asks you to run the install again. A
lockfile with no valid start time is treated as stale, and the installer goes
ahead, only when the PID's command line can be read and is not Vera. Otherwise
it is refused the same way: check that the PID is a Vera host before you stop
it, and if it is not, delete `runtime/host.json` in the home.
A lockfile that cannot be read as a whole is handled the same way: a PID that
runs Vera is refused, and a lockfile with no readable PID is refused with its
path. Delete the file once you have checked that no host is running. An install,
and finishing an interrupted one, apply the same rule before they start a host.
Run the upgrade from a terminal outside Vera: from inside a Vera session, the
host it would stop is the session's own host, and the installer refuses rather
than end the session that is running it.

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
