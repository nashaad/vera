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

Run `bun run install:local` from the checkout you want to install. It packs and
verifies the release first. With no host running, or a host already on that
build, it activates the release at once. From a terminal, when a host on a
different build is running, the install waits for its running turns, stops it,
and activates the release. After activation it checks for a host of another
build and stops it when idle. The next `vera` starts the new host. An attached
TUI shows that the host stopped. Press Ctrl+L or choose Reconnect host in a TUI
started through the `vera` launcher to restart into the active build with the
conversation and draft. Without the launcher, the TUI refuses to restart when
its build differs from the active release; quit and reopen Vera. A running host
of another build is identified as the host instead. Each TUI checks
the installation it runs from, including a private prefix.

Inside a Vera session, or with `VERA_HOT_UPDATE=1`, an install with a host on
another build uses a handoff. The host holds new turns while it waits, then
activates the new release and starts its host. A terminal command waits and
prints the sessions it waits for; a command inside a session returns when the
host accepts it. An attached TUI shows the update and waiting sessions. A TUI
started through the `vera` launcher restarts into the new build in the same
terminal and keeps its unsent draft. If the new host does not start, the
host attempts to restore the previous release and its host. A second update is refused while
one is pending.

`--prefix DIR` chooses a test installation prefix. The daily prefix is
`$HOME/.local`. A test prefix stops and starts only the host of the home that
`VERA_HOME` selects. Set `VERA_HOME` to a private home for a test install.
Against the default home the install is refused before anything is stopped.
The daily prefix goes with the default home, so an install without `--prefix`
is refused when `VERA_HOME` selects another home. Unset `VERA_HOME` for a
daily install.

Inside a Vera session, `bun run install:local` returns at once and the update
waits for running turns. Rollback to a release that supports the handoff also
returns at once from inside a session. For an older release, run `vera rollback`
from a terminal outside Vera.

## Update from a release

`vera update` honors `VERA_RELEASES_API` and `VERA_RELEASES_DOWNLOAD_BASE` as described in [Installation](installation.md).

Run `vera update` from an installed Vera to download and install the newest
GitHub release for your platform. `vera update <version>` installs that
version instead. `vera update --check` prints the running version and the
newest release without downloading or installing anything. It exits 0 when
the running release is equal to or newer than the newest published release,
10 when a newer release exists, and another nonzero code on an error. An
update to an older version is refused; use `vera rollback` to restore the
previous release.

Before installing an update, `vera update` prints the nonempty release notes
for published releases newer than the running version, oldest first. If the
release list exceeds the page limit, it prints the notes gathered and a link
to the releases page for the rest. It
verifies the tarball's SHA-256 checksum and refuses musl Linux. It unpacks into
a staging directory inside the install prefix's `releases` directory and does
not move `current`, `rollback`, or the running host before activation. A
failed download, checksum, or unpack leaves the previous release untouched.
Activation follows the same rules as
[Activate a new release](#activate-a-new-release).

On macOS, when the desktop app was installed with Vera, `vera update` keeps the
app and the host matched. It downloads the release's
`vera-desktop-darwin-<arch>.tar.gz` and its checksum, verifies them, and installs
the desktop package for the new host build before `current` moves. A checksum
failure activates nothing. If the release has no desktop package, or its package
was built for another host build, `vera update` still downloads and unpacks the
host release but leaves `current` where it is and prints `Vera <version> is
downloaded. It turns on once the desktop app for it is released; run 'vera
update' again then.` Run `vera update` again after that release to activate it. A CLI-only install, and any install on Linux,
updates without a desktop package.

The desktop app is a shell, `Vera.app`, that runs the desktop package for the
host build. When a new package needs a newer shell than the installed app,
`vera update` downloads the release's `vera-desktop-shell-darwin-<arch>.tar.gz`,
verifies it and replaces `Vera.app` in place in the folder it was installed to,
as part of the same update. The new app takes the old one's place in one step,
so the app is never missing. The old copy is removed once the new one is in
place, or by a later update when the desktop app was still running. The update
changes nothing and prints why when:

- there is no app at the recorded path: `Vera <version> needs a newer desktop
  app, but there is no app at <path>. Nothing was changed. Run the Vera
  installer to add it.`
- the recorded path is not the Vera desktop app, so it is left alone;
- the folder is not writable, so the app cannot be replaced;
- the release has no desktop package or shell archive yet;
- the shell archive does not hold only the Vera desktop app, is older than the
  package needs, or does not match its checksum.

A rollback never replaces the app: a newer shell runs an older package.

`vera update --download-only` stages the release, its desktop package and, when
the app must be replaced, the shell archive, then stops without switching
anything. `vera update` afterwards switches without downloading again.

When a host is running on another build, `vera update` waits for its running
sessions to finish before it switches. It prints `Waiting for <titles> to finish
before updating (up to 30 minutes). Press Ctrl-C to stop waiting.` Ctrl-C, or
SIGTERM, while it waits stops the update with nothing changed. If sessions are
still running at the limit, nothing is changed and the message names them:
`Vera is still busy after 30 minutes: <titles>. Nothing was changed. Run the
update again when the sessions have finished.` Once the switch has begun,
signals are ignored and it finishes.

An interrupted `vera update`, whether the terminal closed, the process was
killed or the machine lost power, leaves either the whole previous pair of host
release and desktop package or the whole new pair; running `vera update` again
finishes it. A download that fails, ends early, does not match its checksum or
runs out of disk changes nothing, and running the update again fetches it
again. Only one `vera update` or `vera rollback` runs at a time; a second one
says which process holds the lock and exits.

Clients run the same update with `--json`. `vera update --check --json` prints
one object and exits 0 whatever the answer: `status` is `up_to_date`,
`available`, `downloaded` (the release and everything it needs is staged),
`held` or `unavailable`, with `current_version`, `current_build`,
`latest_version` and a `message` when there is something to say.
`vera update --json [--download-only]` prints one object per line: a `phase` of
`checking`, `downloading` (with `bytes` and `total` when known), `waiting` (with
the `sessions` that are running, each an `id` and a `title`, and `waited_ms`
against `limit_ms`) or `switching`, then one last object with `result` set to
`done`, `up_to_date`, `held`, `downloaded`, `failed` or `cancelled`, a
`message` when there is one, and `changed`, which is true only when the active
host and desktop package moved. It exits 1 for `failed` and `cancelled`. A check
that takes longer than 60 seconds ends `unavailable`, and a run that has not
begun switching after 40 minutes ends `failed` with nothing changed.

Run `vera update` from an installed release. A checkout or development
instance is refused and pointed at `bun run install:local`, and the command
always uses the install prefix of the running release.

## Roll back

`vera rollback` makes the previous release active again, without packing or
using the network. When the previous release supports the handoff, rollback
waits for running turns and restarts an open TUI in the same terminal with its
session and unsent draft, as a handoff does. For an older release, rollback
stops the host and starts the restored release's host; an open TUI says to quit
and reopen Vera. Failure leaves the
release that was active before. Rollback uses the running installation's
prefix by default; `--prefix DIR` overrides it. `--prefix DIR` and `VERA_HOME`
pair the same way as for an install. If an earlier install or rollback was interrupted,
`vera rollback` finishes it, names the release that is now active if there is
one, and rolls nothing back. An install that was interrupted after its start
failed is finished by restoring the previous release. So is an install that was
interrupted after it activated the new release, when the new release's host
does not start. If a host that earlier run launched is still running,
`vera rollback` stops it when the PID and start time match, and leaves alone a
PID that now belongs to another process or a host that holds the host lock. If
it cannot confirm or stop that host, it names the PID and changes nothing. An
install finishes an interrupted run the same way before it packs. When the
previous release's host does not start while the run is finished, the command
reports the failure, deletes the upgrade journal and leaves the previous
release active, so the next install or rollback runs normally. It keeps the
journal when another build's host holds the host lock, when a host it
launched cannot be stopped, or when no release is linked as current. If the
active release is not the one you want, run `vera rollback` again.

When the desktop app was installed with Vera, `vera rollback` refuses to switch
to a release whose host build has no installed desktop package. It prints
`vera rollback: Vera can't roll back to build <build>: the desktop app for that
build is not installed. Nothing was changed.` and changes nothing. Cleanup keeps the desktop package of the current
release, of the rollback release, and of a downloaded release that is not yet
active.

## Run checkout code

Use [development instances](runtime-and-worktrees.md) for isolated testing.
`bun run tui` packs into a checkout's `dist/release/` and starts its TUI;
it does not replace the installed command. The pack replaces the whole
`dist/release/` directory. It is built beside the directory and swapped in, so
a pack that fails leaves the previous one as it was. A crash between the two
renames leaves the previous pack in a `.retired-*` directory beside it, and the
next pack removes that directory and builds again. A directory with no release
stamp is replaced only when every top-level entry is a name a pack writes, such
as the output of `bun run pack:web`. The pack refuses to replace any other
non-empty directory with no release stamp, an installed release, and a
directory that is or contains the current directory, the checkout or the source
root, and deletes nothing.
