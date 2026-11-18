---
title: "Installation and upgrades"
description: "Install Vera from the desktop app's disk image, a release download or a checkout."
---

# Installation and upgrades

Install Vera from the desktop app's disk image, from a release download, which
needs nothing else installed, or from its source checkout using Bun.

## Install from the disk image

On macOS, the desktop app comes as a disk image named for its platform, such as
`Vera-darwin-arm64.dmg`. The app carries a complete Vera release inside it, so
nothing else needs to be installed first.

1. Open the disk image and drag Vera onto the Applications folder beside it.
2. The app is not notarized yet, so macOS refuses a plain double click the
   first time. Control-click Vera in Applications, choose Open, and confirm
   Open in the dialog. Later launches open normally.
3. On first launch the app installs its release as the `vera` command, then
   attaches to the host as usual. The terminal UI, the CLI and the host are
   part of that release, so `vera` works in any new terminal once
   `~/.local/bin` is on PATH (see [Add the launcher to PATH](#add-the-launcher-to-path)).

The install goes where the release installer puts it: the release under
`~/.local/share/vera/` and the launcher at `~/.local/bin/vera`. Opening the app
installs nothing when the `vera` command already runs the app's release or a
newer one. It installs the app's release when the command is missing, does not
run, or runs an older release, and the release it replaces stays as the
rollback, as in [`vera rollback`](installed-command.md). The install does not
stop a host that is already running, and that host keeps its own build until it
is restarted.

While the install runs, which takes a few seconds the first time, the
connection state at the bottom of the sidebar reads `Installing Vera…`.

If the install fails and a `vera` command already works, the app attaches with
that command and shows a banner saying the app's release could not be
installed, with the reason and a Dismiss button. If no working command exists,
the app shows `Vera did not start` with the reason and a Try again button. A
`vera` command you had before is left as it was. See
[Desktop app](desktop.md#finding-the-host).

## Install a release

Releases are tagged `v<version>`, and alpha and beta builds are GitHub pre-releases.

Each GitHub release has one file per platform:

| Platform | File |
|---|---|
| macOS, Apple silicon | `vera-darwin-arm64.tar.gz` |
| macOS, Intel | `vera-darwin-x64.tar.gz` |
| Linux x64 (glibc) | `vera-linux-x64.tar.gz` |
| Linux arm64 (glibc) | `vera-linux-arm64.tar.gz` |

Run the installer. It finds the newest published release, pre-releases
included, picks the file for your platform, checks its SHA-256 sum, and
installs it:

```sh
curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/install.sh | sh
```

To install a file you already downloaded, pass it to the script:

```sh
sh install.sh ~/Downloads/vera-darwin-arm64.tar.gz
```

Set `VERA_VERSION` to install a version other than the newest, and
`VERA_INSTALL_PREFIX` to install somewhere other than `~/.local`. Without
`VERA_VERSION`, the installer asks the GitHub API for the newest release; if
that request fails, set `VERA_VERSION` to install a specific version.
`VERA_RELEASES_API` overrides the release-list URL, and
`VERA_RELEASES_DOWNLOAD_BASE` overrides the release download base used for the
platform archive and its `.sha256` checksum. The default download base is
`https://github.com/nashaad/vera/releases/download`; both variables can be set
when using a release mirror. The release includes its own runtime, so Bun and
Node are not needed. Installing
the same release again leaves it in place, and installing a newer one keeps
the previous release for [`vera rollback`](installed-command.md).

### Add the desktop app on macOS

After it installs `vera`, the installer asks `Also install the Vera desktop app? [Y/n] `,
and Enter answers yes. It reads the answer from the terminal rather than from
the script, so the question works when the script arrives through `curl | sh`.
With no terminal to ask on, it skips the app and prints how to add it later.

`VERA_DESKTOP` answers ahead of time: `yes` installs the app, `no` skips it
without asking, and `ask`, the default, asks. Any other value stops the
installer before it changes anything. On Linux the installer says the desktop
app is not available yet, and `VERA_DESKTOP=yes` fails there once `vera` is
installed. The desktop app finds Vera only in `~/.local`, so when
`VERA_INSTALL_PREFIX` names another directory the installer installs `vera`,
skips the app without a question, and `VERA_DESKTOP=yes` fails. A release that
has no desktop app yet is skipped without a question, and `VERA_DESKTOP=yes`
fails against it. Installing from a file you downloaded skips the app, because
the app comes from a release download; run the installer without a file to add
it.

The app comes from the same release as `vera`. Each macOS platform has two more
files in the release, each with a `.sha256` file: `vera-desktop-darwin-<arch>.tar.gz`,
the desktop code built for that release's host, and
`vera-desktop-shell-darwin-<arch>.tar.gz`, which holds `Vera.app`. The
installer checks both sums and the code's host build before it writes anything.
It puts the code under `share/vera/desktop/` in the install prefix, puts
`Vera.app` in `/Applications` when you can write there and otherwise in
`~/Applications`, clears the macOS quarantine flag on what it installs, and
opens the app. It never uses `sudo`.

An existing `Vera.app` that is not the Vera desktop app is left alone, and the
installer prints its path. An existing Vera desktop app is replaced, and put
back if the replacement fails. While Vera is running the installer does not
replace it: it asks you to quit Vera and run the installer again. When the
desktop step fails for any reason, the `vera` command stays installed and the
installer exits with status 1.

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

From an installed release, run:

```sh
vera update
```

It installs the newest published release and prints its release notes first.
`vera update <version>` installs a named version, and `vera update --check`
reports the running and newest versions without installing anything. A
checkout or development instance is refused; update that install with
`bun run install:local` instead. See
[Update from a release](installed-command.md#update-from-a-release).

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
