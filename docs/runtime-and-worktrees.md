---
title: "Development instances and process cleanup"
description: "Test a checkout separately from daily Vera and manage its processes."
---

# Development instances and process cleanup

The installed `vera` command uses your daily home at `~/.vera`. A development
instance uses a private home for one worktree, with separate settings,
conversations, and sockets.

Use a development instance to test checkout changes. Installing a release is
a separate action described in [Installation and upgrades](installation.md).

## Start a development instance

From the worktree you want to test:

```sh
cd /path/to/vera/.worktrees/NAME
bun run dev:tui
```

The first launch copies the factory home from `dev/factory-home`, not your
daily `~/.vera`. The TUI displays a DEV marker. Reusing the worktree keeps its
development conversations; a different worktree gets a different home.

The first launch should omit `-c`, since there is no prior conversation to
continue. Starting a TUI from a checkout without this launcher can attach to
the daily host instead of testing that checkout's code.

For a development instance with a separate session process, run
`bun run dev:tui --pool`. Clients attach to the session process and use the
host to find it again after a disconnect. If the session process exits,
the host replaces it and an interrupted prompt turn fails. Send the prompt
again to retry it. After three process failures in one minute, the host leaves that
process unavailable until the development host restarts.
An interrupted inbox, schedule, or watch wake stays unread and appears when
you next attach. A later entry can wake the conversation normally.

When a development instance has to start its own host, that host and the
worker and supervisor processes it starts run this checkout's code: the
checkout's packed release if it has one, otherwise the source. They never run
the installed release. The annex follows the same rule. Without a packed
release, the annex serves the web page from the checkout's `dist/release/annex`,
which `bun run pack:web` writes. If that page is missing, the annex does not
start, and the host reports `annex: failed` with the command to run. It never
uses the installed annex or its page.

### Provider keys

A new instance has no stored provider credentials and copies none from
`~/.vera`. Its host reads the provider keys exported in the shell that runs
`bun run dev:tui`. The factory configuration uses OpenRouter, so an exported
`OPENROUTER_API_KEY` is enough to start a conversation. For another provider,
export its key, such as `DEEPSEEK_API_KEY`, or connect it from the model pane
inside the instance; a key entered there is stored in the instance home.

A running host keeps the environment it started with. After exporting a new
key, run `bun run dev:tui --stop` and launch again.

### Inspect or stop it

Run these from the same worktree:

```sh
bun run dev:tui --status
bun run dev:tui --stop
```

`--fresh` recreates the private home after confirmation. `--discard` removes
the instance. Both stop the home's host first, and stop and delete nothing when
the host cannot be confirmed as the Vera host. Use `bun run factory:home` to
refresh the factory configuration.

If the private home still has a host from an older build, the launcher replaces
that host and reports the PID and builds. It does not replace the daily host.

## Choose a cleanup command

| Command | Scope and effect |
| --- | --- |
| `vera` | Start daily Vera without killing existing processes. |
| `vera doctor` | Inspect this home and clean eligible leftovers after confirmation, or with `--yes`. |
| `vera prune` | List posted processes in this home and ask separately before stopping each. |
| `vera host stop` | Stop this home's host after its running turns end. New turns are refused meanwhile. |
| `vera host stop --force` | Cut the running turns and stop this home's host now. |
| `bun run dev:tui --stop` | Stop the development host belonging to the current worktree. |
| `bun run dev:sweep` | Stop processes that have run for two days or longer in the homes of registered development instances. It never stops the default home's host. |

A host registers as a development instance only when it runs from a Git
checkout or worktree on a home other than the default `~/.vera`. An installed
release, and a checkout run on the default home, never register.

A plain-shell `vera host stop` targets daily Vera. Use the development
launcher to stop a trial.

> [!CAUTION]
> Do not run two hosts against one runtime directory.

A host stops itself within about half a minute once its socket file is deleted
or replaced, for example when a script deletes its home. Run `vera host stop`
first anyway, so the host closes while its home still exists.

## Recover a host connection

**Reconnect host** in the Ctrl+P palette starts a missing host, force-stops one
that is not answering, and reattaches the conversation. A healthy host is
restarted while this client is still connected, unless other work is using
it. Once this client is disconnected, Reconnect host attaches to a healthy
host instead. See [Troubleshooting](troubleshooting.md#the-client-lost-its-host).

Ordinary `vera host stop` asks the host to stop once its running turns end.
It lists the sessions it waits on and refuses new turns until the host stops.
An attached TUI shows the same sessions above its composer while the wait is open,
and removes the notice once the host stops or the wait is abandoned.
It prints Stopped only after the process exits. If the host does not answer,
the command leaves it running and exits with status 1. `vera host stop --force`
asks the host to cut the running turns and drop their queued prompts, then stop.
The dropped prompts are recorded as not started. If the host does not answer the cut,
or has not stopped within 10 seconds, the command sends SIGTERM, then SIGKILL
if the host ignores it, and says which of these happened.

In pool mode, an ordinary stop waits for running turns on every session
process, then stops all session processes before removing the host lock. A
forced stop stops the master first, then stops each verified session process.
If a session process is unavailable, `vera ls` keeps its last known session
summaries and names the unavailable process after the table. Reconnect host
and automatic restart keep pool mode when they replace a pooled host.
If a host is starting before its lock is published, stop reports the startup
in progress instead of reporting that no host is running.

Neither command signals a process whose start time the system cannot report.
They print that the PID could not be confirmed as the host, keep its lockfile,
and exit with status 1; run the command again. `bun run dev:tui --stop`
refuses the same way, and so does a launch that would replace an older
development host: the launch does not go ahead. A lockfile whose recorded
start time is not a valid time is cleared as stale only when its PID's command
line can be read and is not Vera; the command then goes ahead without
signalling that process. Otherwise it is refused the same way, and so is
`bun run dev:tui --discard`, which deletes nothing. Running the command again
does not help in that case: check that the PID in `runtime/host.json` is a
Vera host before you stop it. If it is not, deleting `runtime/host.json` in
the home is safe.
A lockfile that cannot be read as a whole is damaged, not absent. The same
commands read its PID when they can and refuse a Vera PID the same way. When
no PID can be read, they print the lockfile's path, say they cannot tell
whether a host is running, and exit with status 1; they do not report that no
host is running. `bun run dev:tui --status` shows the host PID as unknown, or
the PID with a note, and names the lockfile. A launch, and the first launch's
copy of the daily home, are refused the same way unless the lockfile is stale:
its PID has gone or runs another program.
A host that cannot finish closing, for example because a turn is stuck, exits
anyway after a short deadline, and quitting the TUI does not wait on it.

Stopping and reconnecting do not install checkout changes.

## What prune can see

Prune reads process registrations in `~/.vera/machine/live/`. Registered
hosts, clients, workers, watchdogs, supervisors, and the local helper can
appear there. Shell commands, tool subprocesses, launch wrappers, and
in-process SDK instances do not. A registered process whose start time the
system cannot report is not listed, and its registration is kept.

Before each signal, `vera prune`, `bun run dev:sweep` and the stray-process
cleanup in `vera doctor` check again that the PID still belongs to the process
that was listed. The start time must match and the command line must be
unchanged. If the command line could not be read when the process was listed,
the start time alone decides. This includes the SIGKILL that follows an
unanswered SIGTERM. A PID that another process has taken over is not signalled,
and the command says so. A process whose start time or command line cannot be
read at that moment is left running and reported. If that happens after a
signal was already sent, `bun run dev:sweep` reports that it could not confirm
the process exited and keeps its registration.

An older process that never registered will not appear merely because Activity
Monitor lists it. `vera prune` accepts no arguments; `--yes` belongs to doctor.

## Home layout

`VERA_HOME` relocates the entire home for tests and development. It is not a
separate runtime-directory selector. See
[Vera's files and settings](config-reference.md) for the directory reference.
