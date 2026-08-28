# Vera help

Vera help explains the state Vera is showing and the next command to try. It
is also the source for the compact output intended for agents and other tools.

Use `vera help <topic>` for one subject. Use `vera help --llms` when a tool
needs the whole help corpus in a compact, stable form.

## profiles — Profiles and configuration

Aliases: `profile`, `config`, `configuration`

Select a profile when Vera starts. `VERA_PROFILE=name vera` and
`vera --profile name` select the same profile. If neither is present, Vera
uses the `default` profile.

Edit the selected profile with `vera --profile name configure`. Check its
configuration and local process state with `vera --profile name doctor`.
Configuration changes apply to new sessions; restart a client when it says a
setting was read at startup.

## models — Models and defaults

Profile selection happens at launch. `/model` changes the model for the
current session; it does not rewrite the profile or agent default.

An agent definition can provide a `default_pair`. In the TUI, `*` means the
current session is using a user-owned override instead of the selected
agent's default pair. The marker describes this session's origin; it does not
mean that the profile file was edited.

Use `vera shortlist list` to see pinned models, `vera shortlist add` to pin
one, and `vera models refresh` to refresh the model catalog from providers.

## agents — Agent definitions

User agent definitions live under
`~/.vera/profiles/<profile>/agents/<name>.md`. A project can override one under
`.vera/agents/<name>.md`. Project definitions take precedence over user
definitions, and extension-provided definitions are read-only.

The YAML frontmatter accepts an optional `default_pair`. Invalid frontmatter
or an invalid pair is reported as a catalog notice and that definition is
skipped. Use the TUI agent picker to inspect the active definition and save a
current pair as its default when the definition is writable.

## status — TUI markers

The model marker `*` means the current session has a user-owned model/pair
override. The posture marker `!` has the same meaning for posture. No marker
means the value came from the selected agent or another inherited default.

These markers describe session state. They do not identify who last edited a
profile file, and they do not imply that a profile is currently editable.

## doctor — Checking Vera

`vera doctor` checks resident Vera processes, leftover Vera tmux sockets,
configuration, and providers without contacting provider endpoints. Add
`--check-providers` to test provider reachability and credentials. Doctor
reports problems. Leftover isolated hosts, their workers, test fixtures,
forgotten clients, and stale Vera tmux sockets are stray and can be
removed; `--yes` skips the confirmation. The user's `default` tmux socket
and non-Vera tmux servers are left alone.

## sessions — Continuing and exporting work

Use `vera -c` to continue the most recent session. Use
`vera resume <session-id|path>` to choose one. `vera export <session-path>`
exports Markdown by default; add `--format json` for structured output.

## recovery — When Vera is stuck or work is at risk

If the resident host is not answering, run `vera host stop --force` and then
start Vera again. If the default profile's host is wedged but you need a
working client, run `vera rescue`; it uses the isolated `rescue` profile.

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
