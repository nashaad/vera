---
title: "Sandboxed commands"
description: "Run shell commands in a filesystem and network sandbox."
---

# Sandboxed commands

With the sandbox on, every shell command Vera starts runs inside `srt`
(`@anthropic-ai/sandbox-runtime`) on macOS and Linux. `bash` and the scripts a
skill runs are covered. The file tools (`read`, `write`, `edit`) are not: they
keep the permission check and nothing more.

The permission check comes first and does not change. A command that asks you
still asks, and one a rule denies is still denied. The sandbox is a second
layer around what runs.

## Turn it on

In the Home `config.json`:

```json
{
  "sandbox": {
    "enabled": true,
    "network": "open"
  }
}
```

The three keys are `enabled`, `network` (`"open"` or `"allowlist"`), and
`allowed_domains`. An unknown key, a wrong type, or `*` in `allowed_domains`
is refused. A change applies to the next command; there is no restart.

`/permissions` shows the current state:

```text
Sandbox: on, network open
```

## What a command can do

It can read every file your account can read, except a path a
`permission_rules` deny or ask rule names for reads.

It can write:

- the session's workspace;
- the session's scratch folder, when it has one;
- the temp folder;
- each folder a `permission_rules` allow names with a `path` and, at most, a
  write or delete verb.

In a linked worktree the repository's shared git folder is writable too, so
`git add` and `git commit` work there, while the protected names below stay
read-only there as well.

Inside a covered command `TMPDIR` points at a folder the sandbox owns with
mode `700`, created before the command starts. If it cannot be created, or it
belongs to another user, the sandbox is unavailable instead.

Inside those folders it still cannot write a path a deny or ask rule names, or
another git worktree of the same repository nested in the folder. It cannot
write the project's `.vera/config.json` or `.vera/rules/`, even when they do
not exist yet. The rest of `.vera/` stays writable for a command, and the
`write` and `edit` tools are not affected. Renaming `.vera` to replace them
is refused too. A folder that has neither `.git` nor `.vera` cannot gain
either from a sandboxed command, because the sandbox refuses the folder that
would hold the protected paths. Run `git init` or create `.vera` from your own
terminal, or in a `full_access` session.

The sandbox also protects the names `srt` treats as protected: git hooks and
config, editor and agent configuration folders, shell startup files, and
similar configuration files. It protects them at the workspace and, on macOS,
in any folder beneath it. Vera compiles this list itself, because `srt`
anchors its own at the folder its process runs in, which for a host is the
Vera home. On Linux the manager scans the workspace and the shared git folder
before each command and adds what it finds, so copies in subfolders and a
nested repository's `.git/hooks` are protected there too. A folder the scan
cannot read and that belongs to you is denied whole; another user's folder is
skipped. A scan that fails, or runs out of time, refuses that command rather
than running it with fewer protections.

Approving a prompt does not widen the sandbox. To let commands write somewhere
outside the workspace, add a `permission_rules` allow for that path. A path
named by an ask rule is blocked from commands even after you allow the prompt,
because an ask rule is also a write deny for the sandbox. The file tools still
write it.

## Network

`"network": "open"` puts no filter on connections: a command reaches any host.

`"network": "allowlist"` lets commands reach only `sandbox.allowed_domains`,
which holds exact names or `*.` patterns:

```json
{
  "sandbox": {
    "enabled": true,
    "network": "allowlist",
    "allowed_domains": ["github.com", "*.example.com"]
  }
}
```

Every other connection is refused, with no prompt. A local server a command
starts is reachable only from inside the sandbox.

## When a command is blocked

The command's own output and exit code are kept. The tool result ends with a
block like this:

```text
Blocked by sandbox:
  write /Users/me/.zshrc
  connect example.com:443
  and 3 more
```

At most five lines are listed, then the count of the rest. Each line is
`read`, `write`, or `connect` and its target. A command whose exit code is
zero still shows a block if something was denied.

## When the sandbox cannot run

The sandbox needs macOS or Linux. On Linux it needs `bubblewrap`, `socat` and
`ripgrep`, and the seccomp filter. When any of them is missing, or `srt`
cannot start, or its temp folder cannot be used, commands still run, without
the sandbox. The first such command in a conversation shows a notice naming
the missing piece and what to install. On Linux with bubblewrap missing it
reads:

```text
Sandbox unavailable: bubblewrap (bwrap) not installed. Commands run unsandboxed. Install bubblewrap, socat and ripgrep with your package manager.
```

On macOS there is no install line, because there is nothing to install. The
notice ends after `Commands run unsandboxed.`

Later commands in that conversation run without repeating the warning.
`/permissions` shows `Sandbox: unavailable (<reason>), commands run
unsandboxed` until the missing piece is installed and Vera restarts.

## full_access

In `full_access` the sandbox is not applied. Commands run directly, so long
operations are not slowed by wrapping. `/permissions` says
`Sandbox: on, not applied in full_access`.

## Where it is logged

The host log (`host.log`) records:

- `sandbox_started`: the platform, the `srt` version, the dependency check,
  the writable list, the read and write deny lists, and the network mode;
- `sandbox_unavailable`: the reason, the errors, and what to install;
- `sandbox_policy_changed`: the new writable and deny lists after a config
  change;
- `sandbox_command`: for each command, the session ID, tool call ID, command
  ID, whether it was wrapped and why not, the wrap error, the exit code, and
  the violation count;
- `sandbox_violation`: one entry per denial, with the kind, the target, and
  the raw line;
- `sandbox_monitor_unconfirmed`: the macOS violation monitor did not report in
  time, so a blocked command may end without its lines;
- `sandbox_scan_failed`: the Linux scan for protected paths failed, so a
  command was refused;
- `sandbox_recovery_failed`: the macOS log query after a turn failed. One such
  entry per turn, naming the time that was skipped, then queries carry on.

On macOS a denial that the live monitor missed is read from the system log a
few seconds after the turn ends, in the background, and logged as a
`sandbox_violation` with `recovered: true`. Vera asks only about the time covered commands were
running, in pieces of at most five minutes. A failed query is dropped rather
than widened on the next try, and a line already logged live is never logged
twice. On Linux the monitor reads denials in the same process, so there is
nothing to recover.

## Limits

Commands do not survive a policy change on Linux in full: `srt` fixes its
monitoring lists when it starts, so a command's violation lines can be
incomplete after the config changes. `srt` keeps the last 100 violation lines
per process; a command whose lines were pushed out reports the count it could
still read.

On macOS, Vera waits for `srt`'s violation monitor before the first command and
gives up after two seconds. A command then still runs sandboxed; only its
violation lines can be missing, and the log says so.
