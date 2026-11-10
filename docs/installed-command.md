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
verifies the release first. With no host running, the release becomes active at
once. With a host running, the installer leaves `current` where it is and asks
the host to move to the new release when its running turns end. The host holds
new turns while it waits, then moves `current` and starts the new release's
host as it exits. From a terminal the install waits and prints what the host
waits on. An attached TUI shows the update build and the sessions it waits for.
When the host moves, a TUI started through the `vera` launcher restarts into
the new build in the same terminal and keeps its unsent draft. A TUI started
without the launcher shows the notice and stays attached. From inside a Vera
session the install returns at once with a line that the update happens when
running turns end. If the new host does not start, the previous release is made
active again and its host is started. A second install that arrives while an
earlier update still waits is refused until that update finishes.

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
not move `current`, `rollback`, or the running host before the handoff. A
failed download, checksum, or unpack leaves the previous release untouched.
Once the handoff begins it follows the same rules as
[Activate a new release](#activate-a-new-release).

Run `vera update` from an installed release. A checkout or development
instance is refused and pointed at `bun run install:local`, and the command
always uses the install prefix of the running release.

## Roll back

`vera rollback` makes the previous release active again, without packing or
using the network. When the previous release supports the handoff, rollback
waits for running turns and restarts an open TUI in the same terminal with its
session and unsent draft, as an update does. For an older release, rollback
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
