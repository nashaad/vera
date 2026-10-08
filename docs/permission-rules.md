---
title: "Permission modes and rules"
description: "Choose how much Vera may do without asking, and write your own rules."
---

# Permission modes and rules

Every tool call is checked before it runs. The answer is one of four: run it,
ask you, send it to the [classifier](permission-classifier.md), or refuse it.

## Built-in modes

| Mode | What runs without asking | Everything else |
|---|---|---|
| `readonly` | Reads, `ask_user`, reading process output | Refused, including every shell command |
| `ask` | Reads, writes inside the workspace, `git commit`, web searches and page fetches, subagent messages, memory notes | Asks you |
| `auto` | Same as `ask` | Goes to the classifier |
| `full_access` | Everything | None |

In readonly, ask, and auto, the file tools refuse to read a file named `.env`,
`*.pem`, or `id_rsa`. A shell command such as `cat .env` is not caught by this
rule. Stopping a process this conversation started is always allowed.

Shift+Tab switches the current conversation only. `/permissions <mode>`
switches it and also makes that mode your default. For a one-shot run, pass
`--permission-mode <mode>` to `vera -p`. With no default set, the mode is
`auto`.

A recursive `rm` is refused in every mode, including full access, when it
targets a filesystem root, your home directory, the workspace, everything in
it (`./*`), or a folder above it.

## Answer a prompt

| Key | Effect |
|---|---|
| 1 Allow once | Runs this call. |
| 2 Session | Allows calls like this one for the rest of the conversation. |
| 3 Deny | Refuses this call. |
| 4 Always | Saves an allow rule that applies in every conversation. |

Session and Always describe "calls like this one" as narrowly as Vera can: the
same operation, the same file, or the same shell command name. A prompt from a
subagent offers only Allow once and Deny.

To see or remove what Session and Always granted, open Ctrl+P and choose
**Review granted permissions**.

## Write a custom mode

A custom mode is a named list of rules in Home `config.json`. Here the crow may
read anything and write its log, may never push the stolen charts, and asks
about the rest:

```json
"permission_modes": {
  "crows-nest": {
    "default": "ask",
    "rules": [
      { "when": { "operation": "git.push" }, "then": "deny" },
      { "when": { "verb": "read" }, "then": "allow" },
      { "when": { "verb": "write", "path_scope": "workspace" }, "then": "allow" }
    ]
  }
}
```

Select it with `/permissions crows-nest`.

Each action takes the first rule that matches; if none match, it gets
`default`. When one tool call is several actions (a fetch is both a web
operation and a read of a URL), the strictest answer wins.

A custom mode starts empty. It does not copy the `.env` rule or anything else
from the built-in modes, so add what you want to keep.

### Rule fields

A `when` must name at least one field, and every field it names must match.

| Field | Matches |
|---|---|
| `tool` | A tool name, such as `bash` or `web_fetch`. |
| `verb` | `read`, `write`, `delete`, or `unknown`. |
| `path` | That absolute path or anything under it. |
| `path_glob` | The file name; `*` matches any run of characters. |
| `path_scope` | `workspace` or `outside_workspace`. |
| `operation` | An operation such as `git.push`, or a prefix ending in `*` such as `git.*`. |
| `executable` | A shell command name, such as `make`. |

`then` is `allow`, `ask`, `review`, or `deny`. A mode that uses `review`
anywhere needs a `reviewer_profile` naming an entry in `reviewer_profiles`.

Operations you can name: `agent.close`, `agent.inbox`, `agent.message`,
`agent.roster`, `agent.spawn`, `git.clone`, `git.commit`, `git.fetch`,
`git.ls_remote`, `git.pull`, `git.push`, `git.remote_update`, `memory.write`,
`process.kill`, `process.read`, `web.fetch`, `web.search`.

> [!WARNING]
> A mistake in any custom mode stops the whole config from loading. Mode names
> use lowercase letters, digits, `-`, and `_`. A custom mode cannot replace a
> built-in one.
