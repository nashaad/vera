---
title: "Use Vera from scripts"
description: "Run a prompt, exchange structured messages, or export saved work."
---

# Use Vera from scripts

Use the command line for one-off prompts and exports. Use `vera stdio` to
control a hosted conversation through JSON messages. For application code,
see the [embedded SDK](embedded-sdk-reviewer.md) or
[Python workflows](python-workflows.md).

## Send a single prompt

Print mode sends a prompt from the terminal. Add `--prompt-only` for a request
containing only Vera's identity prompt and your message, with no tools:

```sh
vera -p "Summarize this text" --prompt-only
```

### Choose a minimal startup

| Flag | Effect |
| --- | --- |
| `--bare` | Omit model-side extensions, project instructions, memory, and scratch context. Client UI extensions remain available. |
| `--prompt-only` | Send only the identity prompt and user message, with no tools. |

Both also work without print mode. The selected startup mode is saved with
the conversation and restored on resume.

## Exchange JSON messages

`vera stdio` connects to the resident host and exchanges one JSON object per
line. Start a new conversation, attach to a live one, or resume saved work:

```sh
vera stdio
vera stdio --attach <agent-id>
vera stdio --resume <session-id|path>
```

The exchange includes prompts and responses to UI requests. This is the
message shape, with omitted fields shown as ellipses:

```text
{"type":"prompt","content":"Review this file"}
{"type":"ui_request",...}
{"type":"ui_response","requestId":"...","response":{...}}
```

## Export a conversation

Export the active conversation branch as Markdown:

```sh
vera export ~/.vera/runtime/sessions/<session-id>.jsonl
```

Add `--format json` for the same user-facing transcript as versioned JSON.
Output goes to stdout; redirect it to save a file. Export does not modify the
conversation or workspace.

## Inspect a recorded request

```sh
vera inspect ~/.vera/runtime/sessions/<session-id>.jsonl
```

This prints the latest recorded provider-neutral request: system prompt,
model-visible messages, and offered tools. It is not the provider's wire
payload.

> [!WARNING]
> The export can contain project files, tool results, prompts, and private
> reasoning from earlier messages. Treat it as sensitive local data.
