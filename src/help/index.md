# Vera help

Vera help explains the state Vera is showing and the next command to try. It
is also the source for the compact output intended for agents and other tools.

Use `vera help <topic>` for one subject. Use `vera help --llms` when a tool
needs the whole help corpus in a compact, stable form.

## home — Home and configuration

Aliases: `profile`, `profiles`, `config`, `configuration`

Vera keeps one home per OS user, at `~/.vera`. There is no profile flag and
no profile environment switch. Edit it with `vera configure`. Check the resident
host and local process state with `vera doctor`. Configuration changes apply
to new sessions; restart a client when it says a setting was read at startup.

## models — Models and defaults

`/model` changes the model for the current session; it does not rewrite the
home or agent default.

An agent definition can provide a `default_pair`. In the TUI, `*` means the
current session is using a user-owned override instead of the selected
agent's default pair. The marker describes this session's origin; it does not
mean that the profile file was edited.

Use `vera library list` to see models in your library, `vera library add` to add
one, and `vera models refresh` to refresh the model catalog from providers.
If Vera is already running, that refresh updates the live host. Restart is
not required.

## agents — Agent definitions

User agent definitions live under `~/.vera/agents/<name>.md`. A project can
override one under `.vera/agents/<name>.md`. Project definitions take
precedence over user definitions, and extension-provided definitions are
read-only.

The YAML frontmatter accepts an optional `default_pair`. Invalid frontmatter
or an invalid pair is reported as a catalog notice and that definition is
skipped. Use the TUI agent picker to inspect the active definition and save a
current pair as its default when the definition is writable.

## status — TUI markers

The model marker `*` means the current session has a user-owned model/pair
override. The posture marker `!` has the same meaning for posture. No marker
means the value came from the selected agent or another inherited default.

These markers describe session state. They do not identify who last edited a
home file.

## doctor — Checking Vera

`vera doctor` checks this runtime's resident host, leftover processes,
leftover Vera tmux sockets, configuration, and providers without contacting
provider endpoints. Add `--check-providers` to test provider reachability
and credentials. Doctor reports problems. Leftovers in this runtime can be
removed after a confirm; `--yes` skips the confirmation. SDK instances and
live tmux servers are left alone.
Doctor only unlinks dead Vera socket files. To stop Vera-owned processes
across this home's runtimes one by one, use `vera prune`.

## prune — Stopping Vera processes

Aliases: `pruning`

`vera prune` lists Vera's own processes for this home: host, TUI, worker,
supervisor, and watchdog. Each row shows the pid, kind, and the runtime
directory it started from. Worktrees that share this home appear together.
A relocated `VERA_HOME` is a different list.

It asks `[y/N]` before stopping each process. `--yes` does not skip that.
Without a terminal it prints the list and refuses to kill. A process that
has been running since before this command existed will not appear until
it is started again.

## sessions — Continuing and exporting work

Use `vera -c` to continue the most recent session. Use
`vera resume <session-id|path>` to choose one. `vera export <session-path>`
exports Markdown by default; add `--format json` for structured output.

## recovery — When Vera is stuck or work is at risk

If the resident host is not answering, run `vera host stop --force` and then
start Vera again. If leftover Vera processes sit around, run `vera prune`
and answer each `[y/N]`.

Before destructive recovery, preserve the session and workspace state. Vera
does not currently provide a general file restore or checkpoint command.
Project recovery may require Git, the preimage stash under
`~/.vera/stash/<session-id>/`, or conversation rewind.

## commands — Finding the command you need

`vera help`, `vera --help`, and `vera -h` print the same top-level command,
flag, and topic overview. They are aliases backed by one renderer and must not
drift into separate help surfaces. Use `vera help <topic>` for detailed
guidance. `/help` opens the TUI help surface, and `/commands` opens its
executable command palette. Help is read-only: it explains a command but does
not run it.
