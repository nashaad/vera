---
title: "Included extensions"
description: "Use side conversations, workspace diffs, artifacts, context inspection, and other capabilities that ship with Vera."
---

# Included extensions

Vera includes extensions for side conversations, workspace diffs,
context inspection, commentable artifacts, and command hooks. They appear in `/extensions` and
`/customize`; no separate installation is needed.

Extension code lives in four places in the repository. Vera loads the first
two on its own:

```text
src/core-extensions/   core extensions: part of Vera, can be switched off
extensions/            optional extensions: on by default, delete a folder to remove one
examples/extensions/   example extensions: never loaded unless added by path
src/extensions/        the extension host: discovery, manifests, registry, manager
```

To use an example, install its folder with `/extension install <path>`, as in
[Install a local extension](extensions.md#install-a-local-extension).

The core and optional extensions are:

```text
core       vera.command-hooks, vera.context, vera.customize, vera.explorer,
           vera.reasoning-cycle, vera.session-identity, vera.web-search
included   vera.artifacts, vera.btw, vera.budget, vera.diff, vera.mcp,
           vera.recap, vera.titles
```

## BTW and Pair

Use `/btw` for a read-only side conversation that can refer to the primary
conversation. `/btw <message>` opens it and sends the message. Its pane is
temporary.

Use `/pair` for a fresh peer conversation with ask permissions.
`/pair <message>` sends a message as it opens. `/pair close` closes its pane.
Pair attachments survive restart, and the conversation is available in `/resume`.

### Work with two panes

Ctrl+G changes focus. Ctrl+\ cycles split and single-pane layouts.
`@sidekick`, `@peer`, and `@vera` address the currently visible conversation;
`@all` addresses both visible conversations.

## Inspect changes and context

Use `/diff` to [review workspace changes](workspace-diff.md). Use `/context`
to [inspect context usage](context-usage.md). The Context extension also
provides `/dashboard`; disabling it removes both commands.

## Recap a conversation

`/recap` opens a full-screen list of the conversation's phases, newest first.
Each row starts with the time the phase began, followed by its title, how long
Vera worked on it, and whether its last test run passed. `/timeline` does the
same. Commits, questions Vera asked you, long steps, side questions and
interruptions sit under the phase they happened in, each with its own time.
The right pane shows the selected row's details, including the files it
edited.

Phases are built from the conversation itself. Their titles come from the
snappy model (see [Assign defaults](models.md#assign-defaults)): when you open
`/recap`, Vera sends each finished phase that has no title yet (your
requests, the checklist items it ticked, the files it edited, its commits and
test result, and the start of its last reply) and asks for a one-line title.
Titles are kept until the client exits. With no snappy model, or if it does
not answer, a phase is titled with the checklist item it ticked, or else the
first words of your request. A phase still running keeps that title too.

Type to filter. Enter scrolls the transcript to that point, and the next
`/recap` starts on the row you jumped to. Otherwise it starts on the newest
phase. Time between turns, while Vera was
waiting on you, does not count toward a phase.

## Run command hooks

`vera.command-hooks` runs a `hooks` list from its own configuration, in any
hook phase: around tool calls and turns, when a conversation starts, resumes,
or compacts, when a session closes, and when a subagent hands back its result. With no list
configured, it runs nothing. Hooks in the home `config.json` are run by the
host, not by this extension, and disabling it does not stop them. See
[Hooks](hooks.md).

To configure this extension's list, add an `extensions` entry
whose path is the absolute directory shown for `vera.command-hooks` in
`/customize`. That entry replaces the included copy. Its `argv` is an absolute
path. Malformed supplied configuration prevents activation.

## Title new conversations

`vera.titles` names a conversation after its first turn finishes. It sends
your first message and the start of the reply to the snappy model (see
[Assign defaults](models.md#assign-defaults)) and asks for a title of six
words or fewer. The title shows in `/resume` and in the terminal window
title, including a window that already has the conversation open.

It only names a conversation that has never had a name, so a `/rename`
always wins, even one that cleared the name. It skips conversations another
agent started, and turns that were interrupted or failed. With no snappy
model assigned it does nothing. Disable it with `/extension disable vera.titles`.

## Write artifacts

`vera.artifacts` gives agents four tools: `artifact_write` and `artifact_edit`
write a markdown artifact, `artifact_read` reads one, and `artifact_comments`
lists, closes, or deletes your comments. The agent reads artifacts without
asking in every mode. In ask and auto mode it also writes artifacts and closes
comments without asking. Each artifact belongs to the conversation that wrote
it. An image, audio or video file written as `![alt](https://…)` shows as a
picture or player. A fenced block marked `html embed` runs its own HTML and
JavaScript, such as a wavesurfer.js player, in a sandboxed frame that cannot
read the page or act for you.

Read an artifact in the annex: run `/usage` and pick Artifacts from the `≡`
menu, or open the link the transcript shows after `artifact_write`. Hover a
block and click the comment button to comment on it. A comment does not start
a turn; the agent reads it the next time it checks. When the text a comment
was left on changes, the comment is marked Outdated.

Tick Send to Vera on a comment to also send it to the conversation. It starts
a turn right away, or after the running one, without asking. Disable it with
`/extension disable vera.artifacts`.

## Configure or disable included copies

Use the extension manager for available controls. To suppress included copies
in configuration, name their IDs in `disabled_included_extensions`:

```json
{
    "disabled_included_extensions": ["vera.diff", "vera.command-hooks", "vera.btw"]
}
```

Any ID from the lists above works here.
`/extension disable <id>` and `/extension enable <id>` edit this list, as does
Space on an included row in `/extensions`.

An `extensions` entry in `config.json` whose path is an included directory
replaces the included copy, even when that entry is disabled. It keeps its own
configuration. An installed extension with the same ID also replaces the
included copy.

Restart the host for command-hook changes. Restart the client for BTW
changes.

## Example extensions

Examples are not included. Install one by path to try it.

### Plan

Install it with `/extension install examples/extensions/plan`. Then use
`/agent plan` to agree a plan before the work starts. Use `/agent default` to
return to the default definition.

With Artifacts enabled, Plan writes its plan as an artifact you can comment on
in the annex, instead of keeping it only in the conversation. It works through
the steps you agree to and updates the artifact when the plan changes. It has
the default agent's tools and keeps the access mode you already have, so ask
mode still asks before it edits files or runs commands.

#### Configure Plan

An installed copy runs with the defaults. To set options, skip the install and
add a `config.json` `extensions` entry whose path is the absolute path of
`examples/extensions/plan`. Its configuration supports:

| Option | Effect |
| --- | --- |
| `compose_suggestion: true` | Offer to switch from the composer. Off by default. |
| `skills` | List allowed skills. Omit for installed skills, or use `[]` for none. |

A home or project `plan.md` overrides the extension's definition. Restart
the host and client after changing its configuration.
