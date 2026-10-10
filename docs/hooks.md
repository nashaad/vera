---
title: "Hooks"
description: "Run an executable around a turn, a tool call, a compaction, or the start and end of a session."
---

# Hooks

A hook is an executable Vera runs at a fixed point in a conversation. Put the
executable in the home's `hooks/` directory and name it from the `hooks` list
in `config.json`. With no hooks configured, nothing runs.

Hooks run in list order. Entries in `config.json` run before hooks registered
by extensions. A subagent runs the hooks of the session that started it.
Sessions started with `--bare` or `--prompt-only` run no hooks, and neither do
their subagents.

> [!WARNING]
> **Safety**
> A hook runs with Vera's operating-system access. A failure does not always
> block the tool call, so a hook is not a security boundary.

## When a hook runs

<div data-diagram="hooks-lifecycle">

```text
Session start (start, resume, after compaction)
     |
     v
.- Each turn ----------------------------------.
| Your message                                 |
|     |                                        |
|     v                                        |
| Model ------------ answers ------> Response  |
|  ^  |                                        |
|  |  | calls a tool                           |
|  |  v                                        |
|  | .- Each tool call -------------------.    |
|  | | Before the tool ---- blocked ----. |    |
|  | |     |                            | |    |
|  | |     v                            | |    |
|  | | Permission check                 | |    |
|  | |     |                            | |    |
|  | |     v                            | |    |
|  | | Tool runs                        | |    |
|  | |     |                            | |    |
|  | |     v                            | |    |
|  | | After the tool                   | |    |
|  | |     |                            | |    |
|  '-+-----+----------------------------' |    |
|    '------------------------------------'    |
'----------------------------------------------'
```

</div>

| Phase | When it runs |
| --- | --- |
| `pre_tool_use` | Before a tool call runs. It can change the input, block the call, or replace the result. |
| `post_tool_use` | After a tool call finishes. It can change the result text or the error flag. |
| `session_start` | When a conversation starts, resumes, or finishes compaction. It can add context. |
| `pre_turn` | Before your message reaches the model. It can add context, narrow the tools, change the model, or block the message. |
| `turn_ending` | When the model gives a final reply with no tool calls. It can send the model back for one more pass. |
| `pre_compact` | When a compaction starts. It only observes. |
| `session_end` | When the host closes a session. It only observes. |
| `subagent_finished` | When a subagent hands its result back to the session that started it. It only observes. |

When the model asks for several tools in one reply, every `pre_tool_use` hook
runs for all of those calls before any tool runs. A call the agent does not
offer is refused before `pre_tool_use`. `post_tool_use` runs only for calls
that ran or were replaced, not for calls that were blocked or denied.

Compaction during a turn runs `session_start` again and the model continues.
After `/compact`, `session_start` runs and Vera waits for your next message.
Attaching to a conversation that is already running does not run
`session_start` again. Recovery after a failed deletion counts as a resume.

## Add a hook

Save this as `~/.vera/hooks/lookout` and make it executable. It blocks a shell
command that would delete the treasure, and leaves every other call alone.

```python
#!/usr/bin/env python3
import json, sys

call = json.load(sys.stdin)
tool = call.get("toolCall", {})
command = tool.get("input", {}).get("command", "")
if tool.get("name") == "bash" and "rm " in command and "treasure" in command:
    print(json.dumps({
        "power": "block",
        "reason": "Leave the treasure where it is.",
    }))
else:
    print(json.dumps({"power": "observe"}))
```

```sh
chmod +x ~/.vera/hooks/lookout
```

Add it to the home `config.json`:

```json
{
  "hooks": [{
    "phase": "pre_tool_use",
    "argv": ["lookout"],
    "timeout_ms": 1000
  }]
}
```

`argv` is the executable's file name, then any arguments. The name is resolved
inside `hooks/`. A path that leaves that directory is refused when the config
loads. Vera does not start a shell, expand variables, or interpret redirects.

`timeout_ms` defaults to 1000 and can be set up to 30000. Restart the resident
host after changing hook configuration.

Before `lookout` runs, Vera writes the call as JSON on stdin:

```json
{
  "type": "pre_tool_use",
  "toolCall": {
    "id": "call_1",
    "name": "bash",
    "input": { "command": "rm treasure/chest.yaml" }
  },
  "sessionId": "sess_1",
  "workspace": "/path/to/the/nest"
}
```

The script prints a decision as JSON on stdout and exits 0. With the default
`vera` protocol, empty stdout is a failure, so print `{"power":"observe"}` to
leave the call alone.

## Decide what happens

Every result has a `power`. `observe` leaves the call alone.

### Before a tool call

| Power | JSON | Effect |
| --- | --- | --- |
| `observe` | `{"power":"observe"}` | Continue. |
| `mutate` | `{"power":"mutate","input":{}}` | Replace the tool input. Later hooks see the new input. |
| `block` | `{"power":"block","reason":"..."}` | Skip the permission check, the tool, and `post_tool_use`. `reason` is required. Later pre-tool hooks do not run. |
| `replace` | `{"power":"replace","result":{"content":[{"type":"text","text":"..."}],"isError":false}}` | Skip the permission check and the tool, and use this result. Later pre-tool hooks do not run. `post_tool_use` still runs. |

The stdin object has `type`, `toolCall` (`id`, `name`, `input`), `sessionId`,
and `workspace`.

### After a tool call

`observe` keeps the result. `mutate` patches it:

```json
{
  "power": "mutate",
  "patch": {
    "content": [{ "type": "text", "text": "The chest is still there." }],
    "isError": false
  }
}
```

Omit either field to leave it unchanged. A post-tool hook cannot block the
call; the tool has already finished.

Stdin adds `result` (`toolCallId`, `toolName`, `content`, `isError`) and
`durationMs` to the same fields as a pre-tool payload.

### When a conversation starts

Stdin:

```json
{
  "type": "session_start",
  "sessionId": "sess_1",
  "workspace": "/path/to/the/nest",
  "reason": "start"
}
```

`reason` is `start`, `resume`, or `compacted`. Return context, or `observe`
to add nothing:

```json
{"power":"mutate","context":"The crow likes short answers."}
```

```json
{"power":"observe"}
```

Each hook may supply up to 128 KiB of UTF-8 text. Text over that limit is
rejected, not shortened. Several hooks appear in the transcript under
numbered headings, in registration order. Compaction may summarize that text.
After compaction the hooks run again, and the displayed context usage includes
the new text. A session-start hook cannot block the conversation.

### Before a turn

Stdin:

```json
{
  "type": "pre_turn",
  "sessionId": "sess_1",
  "workspace": "/path/to/the/nest",
  "prompt": "where is the treasure?",
  "model": "anthropic/claude-sonnet-5-5",
  "tools": ["read", "bash"],
  "arrivedDuringTurn": false,
  "spawned": false
}
```

`arrivedDuringTurn` is true for a message you sent while a turn was running,
which joins that turn. `spawned` is true when another agent started the
session. Return `observe`, `block` with a `reason`, or `mutate` with any of
`context`, `tools` (a subset of the offered names), `model`,
`reasoningEffort`, and `display`:

```json
{"power":"mutate","context":"The crow buried it under the third palm."}
```

Vera adds `context` after your message, as a message of its own. The
transcript shows one row naming the executable, such as "remember added
context", but not the text. `display` replaces that row with one line of up
to 200 characters. A joining message cannot change the model or reasoning
effort. [Register from an extension](#register-from-an-extension) covers the
same results in more detail.

### When a turn ends

Stdin has `type` (`turn_ending`), `sessionId`, `workspace`, `prompt`, `reply`,
`spawned`, and `continuations`, the number of times the turn has already been
continued. Return `observe` to let the turn end, or send the model back with
non-empty `context`:

```json
{"power":"continue","context":"You said done but drew no map."}
```

A turn gets one continuation. Once it has been used, the hook still runs but
`continue` is ignored. The transcript shows "map-check continued the turn",
or the `display` line if the result has one.

### Compaction, session end, and subagents

`pre_compact`, `session_end`, and `subagent_finished` only observe. Vera
writes the same payload an extension function gets (see [Register from an
extension](#register-from-an-extension)) and ignores stdout. Nothing waits for
these executables: compaction goes ahead, the session closes, and the parent
gets the subagent's result. A `session_end` hook that is still running when
the host exits may be cut off.

## Use the `claude` protocol

Set `"protocol": "claude"` to run a script written for Claude Code hooks. It
gets snake_case payloads and answers with exit codes, plain text, or
`hookSpecificOutput`. The default protocol is `vera`.

With this protocol, `phase` may be a Claude event name. A Vera phase name
means the top-level event in the same row:

| `phase` | Vera phase | Runs in |
| --- | --- | --- |
| `PreToolUse` or `pre_tool_use` | `pre_tool_use` | every session |
| `SessionStart` or `session_start` | `session_start` | every session |
| `UserPromptSubmit` or `pre_turn` | `pre_turn` | your sessions, not subagents |
| `Stop` or `turn_ending` | `turn_ending` | your sessions, not subagents |
| `SubagentStop` | `turn_ending` | subagents only |
| `PreCompact` or `pre_compact` | `pre_compact` | your sessions, not subagents |
| `SessionEnd` or `session_end` | `session_end` | your sessions, not subagents |

The `claude` protocol does not support `post_tool_use` or
`subagent_finished`. A Claude event name without `"protocol": "claude"`
prevents the config from loading.

```json
{
  "hooks": [
    { "phase": "UserPromptSubmit", "protocol": "claude", "argv": ["remember"] },
    { "phase": "Stop", "protocol": "claude", "argv": ["map-check"] }
  ]
}
```

Exit 2 sends the trimmed stderr back as a reason. Before a tool call or a
turn, it blocks; at `Stop` or `SubagentStop`, it continues the turn with the
reason as context; at `SessionStart`, `PreCompact`, and `SessionEnd`, it is
ignored. Exit 2 with empty stderr is a failure where the reason is used. Any
other non-zero exit is a failure.

On exit 0, stdout that is not a JSON object is plain text. `UserPromptSubmit`
and `SessionStart` add it as context. The other events ignore it. This
`map-check` sends the model back once when it says done without a map:

```python
#!/usr/bin/env python3
import json, sys

turn = json.load(sys.stdin)
if not turn["stop_hook_active"] and "map" not in turn["last_assistant_message"]:
    print("Draw the map before you say done.", file=sys.stderr)
    sys.exit(2)
```

A pre-tool payload uses `session_id`, `hook_event_name` (`PreToolUse`),
`tool_name`, `tool_input`, `tool_use_id`, and `cwd`. Vera's `bash` tool is
named `Bash`. Other tool names are unchanged.

Empty stdout, or `permissionDecision` of `"allow"`, leaves the call alone.
`"deny"` blocks it and requires a non-empty `permissionDecisionReason`:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "PreToolUse",
    "permissionDecision": "deny",
    "permissionDecisionReason": "Leave the treasure where it is."
  }
}
```

`"allow"` does not grant permission. Vera still applies its own permission
check. Any other `permissionDecision`, such as `"ask"`, is a failure.

A session-start payload uses `session_id`, `cwd`, `hook_event_name`
(`SessionStart`), and `source`: `startup`, `resume`, or `compact`. Return
context as `hookSpecificOutput.additionalContext`. Whenever
`hookSpecificOutput` is present, `hookEventName` must match the phase:

```json
{
  "hookSpecificOutput": {
    "hookEventName": "SessionStart",
    "additionalContext": "The crow likes short answers."
  }
}
```

A `UserPromptSubmit` payload uses `session_id`, `cwd`, `hook_event_name`, and
`prompt`. `{"decision":"block","reason":"..."}` blocks the message, and
`hookSpecificOutput.additionalContext` adds context.

A `Stop` payload uses `session_id`, `cwd`, `hook_event_name`,
`stop_hook_active` (true once the turn has been continued), and
`last_assistant_message`. `SubagentStop` adds `agent_id`, the subagent's
session ID, which is also its `session_id`. `{"decision":"block","reason":"..."}`
continues the turn with the reason as context.

A `PreCompact` payload uses `session_id`, `cwd`, `hook_event_name`, `trigger`
(`manual` or `auto`), and an empty `custom_instructions`. A `SessionEnd`
payload uses `session_id`, `cwd`, `hook_event_name`, and `reason`, which is
always `other`. Both ignore stdout.

No payload has `transcript_path`. A `SessionStart` hook also runs in
subagents, and its payload does not say so. This format does not implement
matchers, shell command strings, environment overrides, async hooks, input
updates, or `continue: false`.

## When a hook fails

A hook in `config.json` that times out, exits non-zero, prints nothing under
the `vera` protocol, or returns invalid JSON before a tool call blocks that
call. The same failure from an extension
command hook is ignored, and the call continues. A failure after a tool call
leaves the result unchanged: when one hook in `config.json` fails there, the
patches from earlier hooks are dropped too. A session-start failure is logged and the
conversation continues. Hosted session-start failures are written to
`runtime/logs/host.jsonl` with type `session_start_hook_failed`.

A failed `pre_turn` hook in `config.json` blocks the message and ends the
turn. The same failure from an extension command hook is ignored. A failed
`turn_ending` hook in `config.json` lets the turn end, and later `turn_ending`
hooks do not run for that reply. The same failure from an extension command
hook is ignored. A failed
`pre_compact`, `session_end`, or `subagent_finished` hook is logged to
`runtime/logs/host.jsonl` with the executable's file name, as type
`pre_compact_hook_failed`, `session_end_hook_failed`, or
`subagent_finished_hook_failed`. Nothing else changes.

A `hooks` entry with an unknown phase or protocol, an empty `argv`, a path
outside `hooks/`, or a `timeout_ms` that is not a positive whole number
prevents the home config from loading. A running host keeps its last valid
config. Other limits on this page, such as the 30000 ms timeout, are checked
when a session starts its hooks. An invalid list on the command-hooks
extension prevents that extension from activating.

Each executable stops at its own `timeout_ms`. The hooks for one tool call
also share a deadline: 60 seconds before the call and 5 seconds after it. At
session start, each hook has its own 60-second limit. The `pre_turn` hooks for
one message share a 60-second deadline, and so do the `turn_ending` hooks for
one reply.

`argv` holds at most 16 arguments, and its JSON is at most 8 KiB. Stdin sent
to one executable is at most 256 KiB. Stdout is at most 64 KiB, except
`session_start`, `pre_turn`, and `turn_ending`, which may return 128 KiB of
context. Under the `claude` protocol, stderr past 64 KiB is dropped.

A workflow can run a different hook before one of its steps. That hook is
part of the workflow, not this list. See
[Control workflow steps](workflow-steps.md#run-a-hook-before-a-step).

## Register from an extension

An extension can register the same executables with `api.hooks.registerCommand`,
after declaring `hooks.command`. It can also register a function with
`api.hooks.registerPreToolUse`, `registerPostToolUse`, or
`registerSessionStart`, after declaring `hooks.pre_tool_use`,
`hooks.post_tool_use`, or `hooks.session_start`. An extension can also run a
function before each user prompt starts its work, with `registerPreTurn` and
`hooks.pre_turn`. It runs before the first model call of a turn, and again for
each queued prompt that joins the running turn. For a joining prompt it can
narrow the tools or block the prompt, which ends the turn, but it cannot
change the model or reasoning effort. The payload's `arrivedDuringTurn` is
true for a joining prompt, and `spawned` is true when another agent started
the session, so a function can tell a subagent's turn from yours.

A `pre_turn` function can also return `context`. Vera adds that text after
your message, as a message of its own, before the model sees the turn. The
transcript shows one row naming the extension, such as "lookout added
context", but not the text. The context stays in the conversation, counts in
`/context`, and is still there after a restart. Empty text adds nothing.

```js
export function activate(vera) {
    vera.hooks.registerPreTurn((turn) => {
        if (!/treasure/i.test(turn.prompt)) return { power: "observe" };
        return { power: "mutate", context: "the crow buried it under the third palm" };
    });
}
```

An extension can send the model back for one more pass with
`registerTurnEnding`, after declaring `hooks.turn_ending`. It runs when the
model gives a final reply with no tool calls, before the turn ends. It does not
run when the turn fails or is stopped. The payload has the session ID,
workspace, this turn's prompt, the reply, whether another agent started the
session, and `continuations`, the number of times the turn has already been
continued.

Return `observe` to let the turn end, or `continue` with `context`. Vera keeps
the first reply, adds the context as a message of its own, and runs the model
again in the same turn. The transcript shows one row naming the extension, such
as "lookout continued the turn", but not the text. A turn gets one
continuation. The first `continue` wins and later functions do not run for that
reply. Once a turn has been continued, the functions still run but `continue`
is ignored. The text cannot be empty. A function that throws, returns something
invalid, or takes longer than 60 seconds lets the turn end as if it were not
registered. Esc never waits for a hook: the turn stops at once and whatever
the hook returns later is dropped.

```js
export function activate(vera) {
    vera.hooks.registerTurnEnding((turn) => {
        if (!/\bdone\b/i.test(turn.reply) || /\bmap\b/i.test(turn.reply)) {
            return { power: "observe" };
        }
        return { power: "continue", context: "You said done but drew no map." };
    });
}
```

Either function can also return `display`, one line of up to 200 characters
that the transcript shows in place of the default row. The extension's name
stays after it, dimmed, as in "Spotted: treasure under the third palm ·
lookout". The context text is still not shown. Leave `display` out, or empty,
for the default row. A `display` with a line break or over the limit makes the
whole result invalid. To let people change the words without editing code,
read them from the extension's own `config` in its `config.json` `extensions`
entry, as the lookout example does:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/examples/extensions/lookout",
        "config": { "rows": { "spotted": "Land ho", "nudge": "Keep digging" } }
    }]
}
```

The Python SDK takes the same two functions on `vera.run()`, as
`prepare_turn` and `before_turn_ends`. See [Run Vera from
Python](/python-agents/).

An extension can run a function after each turn ends with
`registerTurnFinished`, after declaring `hooks.turn_finished`. It gets the
session ID, workspace, outcome, how many prompts the session has had, whether
another agent started the session, and the turn's prompt and reply text. It
only observes: nothing waits for it, and a failure is logged without touching
the session.

An extension can run a function when a compaction starts with
`registerPreCompact`, after declaring `hooks.pre_compact`. It fires for
`/compact` and for automatic compaction in the sessions the host runs. It
gets the session ID, workspace, `reason` (`manual` or `automatic`), the
estimated context size in `tokens`, the context window in `capacity` when
Vera knows it, and `spawned`, which is true when another agent started the
session. It only observes: the
summary does not wait for it. The session file keeps every message after a
compaction, so a hook that is still running when the summary lands has lost
nothing.

```js
vera.hooks.registerPreCompact(async (compaction) => {
    await stowTheLog(compaction.sessionId, "before the crow folds the map");
});
```

An extension can run a function when a session closes with
`registerSessionEnd`, after declaring `hooks.session_end`. A session stays
open in the host while a client is attached or it is set to keep running, so
the hook fires when the host closes it. It gets the session ID, workspace,
`turns`, `spawned`, and a `reason`:

| Reason | When |
| --- | --- |
| `detached` | The last client left: quitting, `/new`, or switching sessions. |
| `closed` | A client or the parent agent closed it. |
| `idle` | The host parked it after it sat idle. |
| `deleted` | It was moved to the trash. |
| `shutdown` | The host stopped. |

Closing a session also ends the subagents it started, each with
`spawned: true`. It only observes, and nothing waits for it, including host
shutdown, so a slow hook may be cut off when the host exits. It does not fire
after a crash.

```js
vera.hooks.registerSessionEnd((session) => {
    if (session.turns > 0) logbook.push(`${session.sessionId} dropped anchor: ${session.reason}`);
});
```

An extension can run a function each time a subagent hands its result back
with `registerSubagentFinished`, after declaring `hooks.subagent_finished`. It
gets `parentSessionId`, `subagentId`, `workspace`, `background` (false for a
subagent the parent waited on), `outcome` (`completed` or `error`), and
`text`, the subagent's final text. A background subagent that is sent more
work fires again when it hands back the next result. A subagent stopped with
Esc, or closed before its result arrives, does not fire. It only observes: the
parent gets the result without waiting for it.

```js
vera.hooks.registerSubagentFinished((scout) => {
    crewLedger.push(`${scout.subagentId} (${scout.outcome}): ${scout.text}`);
});
```

From host code, an extension that declared `sessions.ask` can ask an open
session one side question with `vera.sessions.ask({ sessionId, question })`.
Vera sends the session's last model request again, with the question added
as one more user message, to the same provider and model. The answer comes
back as text and the session gains nothing but a billing record, so `/usage`
counts the call as `ask`. Tools are offered but never run: a reply that asks
for a tool rejects. The call does not wait for a running turn, and it rejects
instead of trying another model when the session's model is unreachable.

```js
const reply = await vera.sessions.ask({
    sessionId,
    question: "Which island did the crow hide the stolen buttons on?",
});
```

The included `vera.command-hooks` extension reads a `hooks` list from its own
configuration and runs nothing until that list is set. The host runs the
`config.json` list itself, so disabling this extension does not stop it. An `extensions` entry
whose path is that extension's directory replaces the included copy. Its
`argv` is an absolute path, not a file name in `hooks/`. See
[Included extensions](included-extensions.md).
