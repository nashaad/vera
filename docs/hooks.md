---
title: "Hooks"
description: "Run an executable when a conversation starts or around a tool call."
---

# Hooks

A hook is an executable Vera runs at a fixed point in a conversation. Put the
executable in the home's `hooks/` directory and name it from the `hooks` list
in `config.json`. With no hooks configured, nothing runs.

Hooks run in list order. Entries in `config.json` run before hooks registered
by extensions. Sessions started with `--bare` or `--prompt-only` run no hooks,
and neither do their subagents.

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

## Use the `claude` protocol

Set `"protocol": "claude"` to exchange snake_case payloads and a
`hookSpecificOutput` reply instead of Vera's shape. The default protocol is
`vera`. The `claude` protocol supports `pre_tool_use` and `session_start`. It
does not support `post_tool_use`.

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

This format does not implement matchers, shell command strings, environment
overrides, async hooks, or input updates.

## When a hook fails

A hook in `config.json` that times out, exits non-zero, prints nothing under
the `vera` protocol, or returns invalid JSON before a tool call blocks that
call. The same failure from an extension
command hook is ignored, and the call continues. A failure after a tool call
leaves the result unchanged: when one hook in `config.json` fails there, the
patches from earlier hooks are dropped too. A session-start failure is logged and the
conversation continues. Hosted session-start failures are written to
`runtime/logs/host.jsonl` with type `session_start_hook_failed`.

A `hooks` entry with an unknown phase or protocol, an empty `argv`, a path
outside `hooks/`, or a `timeout_ms` that is not a positive whole number
prevents the home config from loading. A running host keeps its last valid
config. Other limits on this page, such as the 30000 ms timeout, are checked
when a session starts its hooks. An invalid list on the command-hooks
extension prevents that extension from activating.

Each executable stops at its own `timeout_ms`. The hooks for one tool call
also share a deadline: 60 seconds before the call and 5 seconds after it. At
session start, each hook has its own 60-second limit.

`argv` holds at most 16 arguments, and its JSON is at most 8 KiB. Stdin sent
to one executable is at most 256 KiB. Stdout is at most 64 KiB, except a
session-start hook, which may return its 128 KiB of context.

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
change the model or reasoning effort.

An extension can run a function after each turn ends with
`registerTurnFinished`, after declaring `hooks.turn_finished`. It gets the
session ID, workspace, outcome, how many prompts the session has had, whether
another agent started the session, and the turn's prompt and reply text. It
only observes: nothing waits for it, and a failure is logged without touching
the session.

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
