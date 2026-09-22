---
title: "Session start hooks"
description: "Add context when a conversation starts, resumes, or compacts."
---

# Session start hooks

A session-start hook supplies context when a conversation starts, when a saved
conversation resumes, and after compaction. Its text appears in the transcript
and is included in the model's history. Attaching to a conversation that is
already running does not run the hook again. Recovery after a failed deletion
counts as a resume.

## Add an executable hook

Place an executable in the home's `hooks/` directory. Add an entry to the
`hooks` list in `config.json`:

```json
{
    "hooks": [{
        "phase": "session_start",
        "argv": ["greet"],
        "protocol": "vera",
        "timeout_ms": 1000
    }]
}
```

`greet` is that executable's file name. The command receives JSON on stdin
with `type`, `sessionId`, `workspace`, and `reason`. Reason is `start`,
`resume`, or `compacted`. Return JSON on stdout:

```json
{"power":"mutate","context":"Context for this conversation."}
```

Return `{"power":"observe"}` to add nothing. Commands run without shell
expansion. The timeout defaults to one second and can be set up to 30 seconds.
Restart the resident host after changing hook configuration.

## What the hook may add

Each hook may supply up to 128 KiB of UTF-8 text. Text over that limit is
rejected, not shortened. Several hooks appear under numbered headings in
registration order. A failure or invalid output is logged and the session
continues. Hosted failures are written to `runtime/logs/host.jsonl` with type
`session_start_hook_failed`. A hook cannot block a session.

Compaction may summarize the added context. After that, the hooks run again.
The displayed context usage includes the new text.

## Register from an extension

An extension may declare `hooks.session_start` and register a function with
`api.hooks.registerSessionStart`. It may also register an executable through
the existing `hooks.command` capability.
