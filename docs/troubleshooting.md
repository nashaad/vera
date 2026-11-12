---
title: "Troubleshooting"
description: "Check a connection or configuration problem and choose the relevant recovery action."
---

# Troubleshooting

Start with the error Vera reports. `/diagnostics` inspects the current
conversation or host, `/doctor` checks the runtime, and `/context` reports
context usage without sending a model request.

## Use a single-process host

In `/configure`, choose Home config and set `host.workers` to `0`. Save the
file, then press Ctrl+P and choose Reconnect host to apply the change.

## The client lost its host

After a dropped connection that was not a planned stop, Vera makes one
automatic restart attempt. After a planned stop, the TUI makes no automatic
attempt; it shows "The host stopped." and waits. If the TUI says disconnected
or the host stopped, press **Ctrl+L** to restart the host into the same
conversation. To quit instead, press Ctrl+C twice. Vera prints
the command to resume this session before it exits.

During automatic recovery, the TUI keeps the conversation visible, shows
`reconnecting…`, and stops the live turn and tool timers until it reconnects.

Ctrl+L does what Reconnect host does: it starts a host if none runs and
reopens this session. If the installed build differs from the
TUI's build, the TUI relaunches into the installed build and keeps the
conversation. If the restart fails, the conversation says so and prints
`vera resume <id>`.

To stay in the TUI instead, press Ctrl+P and choose **Reconnect host**. It
attaches to or replaces the host associated with this Vera home and returns to
the same conversation without changing the installed build. It is not a slash
command. Choosing it authorizes that recovery; there is no second prompt.

### What recovery does

| Host state | Result |
| --- | --- |
| Missing or dead | Start a host and reattach the conversation. |
| Process alive but not answering | Force-stop that process, start a host, and reattach. |
| Healthy and idle, client still connected | Ask it to shut down, replace it, and reattach. |
| Healthy and busy, client still connected | Refuse replacement while other work is using it. |
| Healthy, client already disconnected | Attach to it and reattach the conversation. It is not asked to shut down. |

A busy refusal protects active work. The composer stays usable. Let that work
finish, or use the deliberate shutdown controls in
[Development instances and process cleanup](runtime-and-worktrees.md).

Reconnect host does not signal a process whose start time the system cannot
report, or whose lockfile records a start time that is not a valid time. If the
unresponsive host is such a process, it says it could not confirm the PID,
leaves the process and its lockfile alone, and starts no new host. Run it
again. If the message says the lockfile has no valid start time, check that
the PID is a Vera host before you stop it; if it is not, deleting
`runtime/host.json` in the home is safe. A lockfile with no valid start time
whose PID runs another program is stale, and Reconnect host replaces it.

A lockfile that exists but cannot be read as a whole, for example one that is
cut off or has no socket path, is damaged, not absent. `vera host stop` reads
its PID when it can. A damaged lockfile's start time is never trusted, so a PID
that runs a Vera process is refused with the same message and its lockfile is
kept; a PID that is gone or runs another program has the lockfile cleared. When
no PID can be read, `vera host stop` prints the lockfile's path, says it
cannot tell whether a host is running, and exits with status 1. Check for a
running host with `vera doctor`; if there is none, delete the file.

The commands that would start or replace a host read a damaged lockfile the
same way. Starting Vera, Reconnect host, `vera ls`, `vera abort` and `vera
close` do not start a host or report that none is running when the lockfile may
stand for one. Like `vera host stop`, they name the PID to check, or the
lockfile's path when no PID can be read. A damaged lockfile whose PID has gone,
or runs another program, is stale and reads as no host.

When no PID can be read, `vera doctor` shows the resident host as unknown,
names the lockfile, and lists no stray hosts, and `vera prune` prints the
lockfile message, lists nothing and exits with status 1. When a PID can be read
and runs a Vera process, `vera doctor` shows it as the resident host and
`vera prune` does not offer it for stopping.

A supervised host that finds a damaged lockfile at start, with a socket that
does not answer, prints the message once and keeps waiting. It starts when the lockfile is fixed or deleted. A host
started any other way prints the message and the command `vera host reset`, which
backs up the runtime records, stops this home's Vera processes and clears the lock
after asking, and exits with status 1.

A socket file existing on disk does not prove the host is answering.

### The host is a different build

A TUI attaches only to a host of its own build. If the host was restarted on a
different build while the TUI was open, the TUI stays disconnected, makes no
automatic restart, and shows an error naming both builds. The status line reads
`disconnected: host is a different build · quit and reopen Vera`. The error:

```text
The Vera host is now build vera-kraken-2, and this TUI is build vera-crow-1.
Quit and reopen Vera to continue.
```

Other requests to that host, such as listing, searching or starting sessions,
are not sent. Each fails with an error naming both builds. Quit and reopen
Vera. The new TUI starts on the installed build.

## A key or command did nothing

If a key, paste, or submitted message fails inside the TUI, the conversation
shows an error line that starts with what failed, such as `Key failed:` or
`Submit failed:`, followed by the reason. The TUI keeps running. The same
failure is written to the client's log under `runtime/logs/clients/`.

## Provider models look stale

Open Configure providers and refresh the affected provider. Check the endpoint
if the refresh fails. Restarting the TUI alone does not refresh provider state
held by the host.

See [Manage connections](first-run-setup.md#manage-connections) for refresh,
credentials, and sign-in controls.

## Vera does not start

When Vera cannot start, it names the cause and one way to get running. In a
terminal it draws a card and asks for one key before it changes anything: `y`
for yes, `n`, Escape or Ctrl+C for no, and Enter for the choice shown in capitals,
which is `N` unless the card marks `Y`. With `vera -p`, a pipe or CI
it asks nothing: it prints the cause and the one command to run as plain lines,
and changes nothing. Paths under your home folder show as `~/...` on a card, and
`NO_COLOR` turns its colours off.

### config.json is refused

The message names the field and the reason:

```text
Vera config at ~/.vera/config.json could not be read: it is valid JSON but not a Vera config. extensions[5]: path is missing; it must be an absolute path.
```

In a terminal the same facts are a card:

```text
            V  E  R  A
╭──────────────────────────────────────────────╮
│ ✗ Vera can't start                           │
│                                              │
│   file    ~/.vera/config.json                │
│   field   extensions[5]                      │
│   reason  path is missing; it must be an     │
│           absolute path                      │
│                                              │
│   Set aside extensions[5] and start Vera?    │
│   A backup is saved first.                   │
│   Once Vera starts, ask it to fix the entry  │
│   from the backup.                           │
│                                              │
│   [y] set aside and start      [N] quit      │
╰──────────────────────────────────────────────╯
```

Without a terminal the question is one line:

```text
Set aside extensions[5] ({"enabled":true}) and start Vera? A copy of the whole file is saved first. [y/N]
```

Yes saves a copy of the whole file next to it as `config.json.<date>-<time>.bak`
(readable only by you), removes only that entry or key, prints what it removed
and where the copy is, and reads the file again. If another field fails, Vera
offers that one next. No leaves the file alone and prints
`Fix or remove <path> and run Vera again.`

Removing one entry cannot repair a file that is not JSON or one without
`schema_version`, `model` or `provider`. For those Vera offers to move the file
to the `.bak` name and start first-run setup. The file is kept there.

Without a terminal Vera prints the command instead:

```text
vera doctor --config --yes
```

It does what yes does, without asking, for each failure in turn. When
`VERA_HOME` selects the home, the printed command starts with
`VERA_HOME=<home>`. `vera doctor --config` checks only the config file and says
whether it loads. Only the home's `config.json` is set aside. A failure in a
project's `.vera/config.json` names that file for you to edit.

### The home path is too long

A Unix socket path holds at most 103 bytes on macOS and 107 on Linux. Vera's
socket is `runtime/host.sock` under the home, so a home path can be at most 85
characters on macOS and 89 on Linux; a longer home cannot start a host. Vera
stops at once and says so:

```text
Vera's home path is too long.
Home: <home>
On macOS a Vera home path can be at most 85 characters, and this one is 120.
Start Vera with a shorter home, for example: VERA_HOME=/tmp/vera vera
Nothing in this home was moved or deleted.
```

In a terminal the same text is a card with `home` and `reason` rows and the
`VERA_HOME=` line on its own line to copy.

The shorter home is the default `~/.vera` when its socket fits and is not the
home in trouble, and `/tmp/vera` otherwise. It has its own config and sessions;
nothing in the long home is moved or deleted.

### The home is a file

When the home, or its `runtime` folder, is a file or sits under one, Vera names
the path and gives a `VERA_HOME=` example for another home instead of printing
`ENOTDIR`.

### The host stopped while starting

A host that dies while starting leaves its cause in
`runtime/host-startup-failure.json`. The launcher shows it as
`The Vera host stopped while starting: <cause>` instead of
`Resident host did not start before its deadline`. After the host has exited
during startup twice in a row, Vera stops respawning it and the message says
what the host reported. The offer to start on a fresh runtime folder names the
same cause.

## config.json stopped loading

If `config.json` stops loading while Vera is running, for example after an
edit leaves it invalid, the model and provider pages and Switch model keep
showing the last settings that loaded. Each says so in one line that starts
with `config.json could not be read:` and gives the reason. Assigning a model
while the file is broken is refused with the same reason, and the page stays
open. Fix the file; each page reads it again when it opens.

Skills and `/customize` keep the last settings that loaded too. See
[Turn a skill off](skills.md#turn-a-skill-off).

## auth.json was written by a newer Vera

Vera refuses to read or change `auth.json` when a newer build wrote it, so the
saved logins stay in the file. Install the newer build again, or sign in to the
providers again with this build after the file is removed or moved by hand.
A file that is not JSON, or is JSON this build does not recognise, is moved
aside next to the original on the next save, and the TUI names the new path.

## A configured extension is missing

Open `/extensions` and inspect its status. A missing environment credential
can prevent it from loading. See
[Extension credentials](extension-credentials.md#diagnose-a-missing-variable).

## A model request failed

When a request fails and retrying cannot help, the turn ends with a **MODEL
REQUEST FAILED** error. It names the model, says what went wrong, quotes the
provider's own message when there is one, and ends with a **Fix** line:

```text
× MODEL REQUEST FAILED
  The model, custom/crow-main, rejected the request: The crow dropped the
  request in a storm.
  Fix: pick another model with /model. The Vera report in /diagnostics has
  the full error.
```

A spent usage limit shows when it resets. The error is saved with the
conversation, so a reopened conversation shows it too. The provider's full
response is in `/diagnostics`: open the **Vera** report and look under
**MODEL FAILURES**.

If Vera cannot build a request locally, it stops without retrying and the
Vera report in `/diagnostics` contains the error.

## A change could not be saved

Changing the permission mode or selecting an agent is saved to the session
file before it takes effect. If the save fails, for example because the disk
is full, the file is put back as it was, the change is refused with the error,
and the conversation keeps working. Try again once the disk has room.

If the file cannot be put back, the conversation refuses further changes and
says to reopen the session. Run `/close`, then choose the conversation
again from `/resume`. Vera then reads the file as it stands, including any
record the failed save did write.

A save that fails while a turn is running stops the conversation instead. It
shows the failure's message and takes no further messages. The host log at
`runtime/logs/host.jsonl` records the message and stack. The failure is recorded
in the session file when possible, so resuming starts it in the failed state.
Everything saved before the failure is kept.

## Capture a model failure

Use `/failure-report` for a shareable report of recorded model failures.
Failed compactions are recorded too, with the reason the summary did not land.
This is a model-failure report, not a general bug-report system.

Session files, request captures, and classifier logs can contain private
conversation and project material. Review them before sharing.

Logs under `~/.vera/runtime/logs/`, including request captures and classifier
logs, are deleted once they are more than seven days old. The host checks when
it starts and once a day. To keep them longer, set a whole number of days in
`config.json`, for example `"log_max_age_days": 30`. Copy a log elsewhere to
keep it for good. A running sidecar's log is never deleted. Session files in
`runtime/sessions/` are not logs and are never deleted this way.
