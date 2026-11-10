---
title: "Installation and upgrades"
description: "Install Vera from a release download or from a checkout."
---

# Installation and upgrades

Install Vera from a release download, which needs nothing else installed, or
from its source checkout using Bun.

## Install a release

Releases are tagged `v<version>`, and alpha and beta builds are GitHub pre-releases.

Each GitHub release has one file per platform:

| Platform | File |
|---|---|
| macOS, Apple silicon | `vera-darwin-arm64.tar.gz` |
| macOS, Intel | `vera-darwin-x64.tar.gz` |
| Linux x64 (glibc) | `vera-linux-x64.tar.gz` |
| Linux arm64 (glibc) | `vera-linux-arm64.tar.gz` |

Run the release's `install.sh`. It picks the file for your platform,
checks its SHA-256 sum, and installs it:

```sh
curl -fsSL https://github.com/nashaad/vera/releases/latest/download/install.sh | sh
```

To install a file you already downloaded, pass it to the script:

```sh
sh install.sh ~/Downloads/vera-darwin-arm64.tar.gz
```

Set `VERA_VERSION` to install a version other than the latest, and
`VERA_INSTALL_PREFIX` to install somewhere other than `~/.local`. The release
includes its own runtime, so Bun and Node are not needed. Installing the same
release again leaves it in place, and installing a newer one keeps the previous
release for [`vera rollback`](installed-command.md).

## Install from a checkout

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
