---
title: "Installation and upgrades"
description: "Install Vera from a release download or a checkout."
---

# Installation and upgrades

Install Vera from a release download, which needs nothing else installed, or
from its source checkout using Bun. The desktop app requires an installed
`vera` command and does not install it on launch.

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

### The desktop app on macOS

On macOS `bun run install:local` also builds the desktop app from the checkout
and installs it. It builds the desktop package for the same build as the host
and puts it under `share/vera/desktop/` in the install prefix before the host
build becomes current, so the app never finds a current build without its
package. The package's version is the checkout's product version.

`Vera.app` goes in the folder the installer script uses: `/Applications` when
you can write there, otherwise `~/Applications`, and `VERA_INSTALL_APPLICATIONS`
names another folder. When there is no `Vera.app`, the command installs one.
When the installed shell is older than the package needs, it replaces the
shell. Otherwise it leaves the installed `Vera.app` as it is, the same as
`vera update`. It writes the same install record the installer script writes, so
the desktop app and `vera update` find the app afterwards. It never opens the
app. It prints the app path it installed, replaced or kept.

A `Vera.app` that is not the Vera desktop app is left alone and the command
prints why. When the app needs replacing while Vera is running, the command
does not replace it. The package and the host build are still installed, and the
command prints a line asking you to quit Vera and run it again. When the desktop step fails for any
reason, the host install is not undone or blocked. The command prints the
reason after the host install finishes and exits with status 1.

`bun run install:local --no-desktop` skips the desktop app. On Linux the command
installs the host only and prints nothing about the desktop. The desktop app
finds Vera only in `~/.local`, so the desktop step runs only for that prefix.
With `--prefix` naming any other directory the command installs the host, skips
the app, prints `The desktop app needs Vera in ~/.local; it was not installed.`
and exits with status 0, the same as the installer script.

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

## Uninstall

Run the uninstall script from a terminal:

```sh
curl -fsSL https://raw.githubusercontent.com/nashaad/vera/main/scripts/uninstall.sh | sh
```

The script lists the installed launcher, release files, Vera desktop app and
Vera home that it found, with their sizes, then asks before removing them. The
home is `~/.vera` unless `VERA_HOME` names another location. The install prefix
is `~/.local` unless `VERA_INSTALL_PREFIX` names another location. On macOS the
script checks the desktop install record, or looks in `/Applications` and
`~/Applications` when the record or its app is missing. It leaves an app that
is not Vera in place. If `VERA_HOME` is a symlink, the script stops and asks
you to use its actual directory instead. It refuses the filesystem root, your
home directory, and any ancestor of your home directory.

The script asks all questions before stopping anything. It offers to back up
the Vera home, defaulting to yes, and requires an answer on whether to include
provider sign-ins from `machine/auth.json`. It asks where to save the backup,
with your home folder as the default. A backup directory can start with `~` or
`~/`.

The script then quits the desktop app and stops the host. If it cannot confirm
that the host stopped, nothing is removed. If the host is waiting for running
turns, run the script again after it stops. After stopping the host, the script
creates the backup before removing anything. If backup creation fails, nothing
is removed; the host starts again the next time you run `vera`. The user-only
`vera-backup-<date>-<time>.tar.gz` archive has a README describing its contents
and restoration. Other home files can contain secrets even when sign-ins are
excluded.

Without an interactive terminal, uninstall requires `VERA_UNINSTALL=yes`. It
then backs up the home including sign-ins by default, unless
`VERA_UNINSTALL_BACKUP=no` disables the backup. `VERA_UNINSTALL_BACKUP_DIR`
sets the backup location in either mode and is the interactive default.

Uninstall removes the listed launcher, release files, desktop app and home. It
leaves macOS preferences and saved application state at
`~/Library/Preferences/dev.vera.desktop.plist` and
`~/Library/Saved Application State/dev.vera.desktop.savedState` when present,
and reports those paths and the backup path.

## Upgrade

From an installed release, run:

```sh
vera update
```

It installs the newest published release and prints its release notes first.
`vera update <version>` installs a named version, and `vera update --check`
reports the running and newest versions without installing anything.
`vera update --download-only` fetches the release and stops before switching.
On macOS the update moves the host and the desktop app together, and replaces
`Vera.app` when the new desktop package needs a newer one. It waits for running
sessions to finish, and a failed or interrupted update leaves either the whole
previous version or the whole new one. A checkout or development instance is
refused; update that install with `bun run install:local` instead. See
[Update from a release](installed-command.md#update-from-a-release).

From the checkout containing the version you want, run the same installation
commands. Vera verifies the release before activating it. With no host running,
the release becomes active at once. From a terminal, an install with a host
on another build waits for running turns, stops the host and activates the
release; the next `vera` starts the new host if no host has been restarted. Inside a Vera session, or with `VERA_HOT_UPDATE=1`, the host
instead hands off to the new build after running turns end. A command inside a
session returns when the host accepts the handoff. A test `--prefix` is refused
unless `VERA_HOME` selects a private home, and the daily prefix is refused when
`VERA_HOME` selects another home; see
[Activate a new release](installed-command.md#activate-a-new-release).

The installer asks a reachable host to stop. When it cannot confirm the host
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
