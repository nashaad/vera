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

### Inspect or stop it

Run these from the same worktree:

```sh
bun run dev:tui --status
bun run dev:tui --stop
```

`--fresh` recreates the private home after confirmation. `--discard` removes
the instance. Use `bun run factory:home` to refresh the factory configuration.

If the private home still has a host from an older build, the launcher replaces
that host and reports the PID and builds. It does not replace the daily host.

## Choose a cleanup command

| Command | Scope and effect |
| --- | --- |
| `vera` | Start daily Vera without killing existing processes. |
| `vera doctor` | Inspect this home and clean eligible leftovers after confirmation, or with `--yes`. |
| `vera prune` | List posted processes in this home and ask separately before stopping each. |
| `vera host stop` | Stop this home's host and affect its attached clients. |
| `bun run dev:tui --stop` | Stop the development host belonging to the current worktree. |

A plain-shell `vera host stop` targets daily Vera. Use the development
launcher to stop a trial.

> [!CAUTION]
> Do not run two hosts against one runtime directory.

## Recover a host connection

`/reconnect` starts or replaces the current home's host and reattaches the
conversation. It refuses to replace a healthy busy host. See
[Troubleshooting](troubleshooting.md#the-client-lost-its-host).

If you intend to terminate that host despite active work, `vera host stop
--force` sends SIGKILL. Ordinary `vera host stop` sends SIGTERM and waits;
it prints Stopped only after the process exits, otherwise exits with status 1.

Stopping and reconnecting do not install checkout changes.

## What prune can see

Prune reads process registrations in `~/.vera/machine/live/`. Registered
hosts, clients, workers, watchdogs, supervisors, and the local helper can
appear there. Shell commands, tool subprocesses, launch wrappers, and
in-process SDK instances do not.

An older process that never registered will not appear merely because Activity
Monitor lists it. `vera prune` accepts no arguments; `--yes` belongs to doctor.

## Home layout

`VERA_HOME` relocates the entire home for tests and development. It is not a
separate runtime-directory selector. See
[Vera's files and settings](config-reference.md) for the directory reference.
