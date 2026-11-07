---
title: "Troubleshooting"
description: "Check a connection or configuration problem and choose the relevant recovery action."
---

# Troubleshooting

Start with the error Vera reports. `/diagnostics` inspects the current
conversation or host, `/doctor` checks the runtime, and `/context` reports
context usage without sending a model request.

## The client lost its host

After a dropped connection that was not a planned stop, Vera makes one
automatic restart attempt. After a planned stop, the TUI makes no automatic
attempt; it shows "The host stopped." and waits. If the TUI says disconnected
or the host stopped, press **Ctrl+L** to restart the host into the same
conversation. To quit instead, press Ctrl+C twice. Vera prints
the command to resume this session before it exits.

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
started any other way prints the message and exits with status 1.

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

## config.json stopped loading

If `config.json` stops loading while Vera is running, for example after an
edit leaves it invalid, the model and provider pages and Switch model keep
showing the last settings that loaded. Each says so in one line that starts
with `config.json could not be read:` and gives the reason. Assigning a model
while the file is broken is refused with the same reason, and the page stays
open. Fix the file; each page reads it again when it opens.

Skills and `/customize` keep the last settings that loaded too. See
[Turn a skill off](skills.md#turn-a-skill-off).

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
shows "Resident agent stopped unexpectedly" and takes no further messages.
The failure is recorded in the file, so resuming the conversation starts it in
the failed state. Everything saved before the failure is kept.

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
