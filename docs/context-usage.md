---
title: "Inspect context usage"
description: "See how much of the model's context window is used and which sources are loaded."
---

# Inspect context usage

The context window holds the material available to the model for its next
response: instructions, conversation history, and tool results. Open
`/context` to see how much space is used and what contributes to it. This
inspection does not send a model request.

## Read the report

The compact report shows used, free, and reserved space, a category breakdown,
and loaded instruction files. Large tool results are called out so you can
spot an unusually expensive file read or command output.

Use `/context all` to expand individual messages and tools. A used total
without breakdown rows means that snapshot has no category detail. You do
not need to send another message to make the report valid.

### Understand the measurement

Tool results update the used count as they arrive. Rewinding updates it for
the remaining conversation. Between replies the count is an estimate that Vera
corrects with the provider's count for the last request, including reasoning
the provider carries forward, so it stays close to what the next request uses.
Each attached image counts as about 1,600 tokens until the provider reports
its real size. After resume, the loaded-file list describes the last measured
request.

The maximum comes from the model's known context window. If a local server
does not publish a window, Vera leaves it unknown rather than estimating one.
Used, free, and reserved space remain distinguishable without color.

The composer shows `ctx ?%` when the model's window is known but the current
conversation has no measured context yet. It replaces the question mark with
the measured percentage after a turn. Saved sample conversations may have no
measurement even when they contain messages. Any measured use fills at least
one cell of the meter. In a narrow terminal the composer drops the token
counts and keeps the meter, the percentage, the model, and the effort.

## Large instruction files

Everything in the INSTRUCTIONS section is sent with every request: home and
project rules, `AGENTS.md`, `AGENTS.local.md`, memory, the selected agent's
instructions, and the skill catalog. When that total reaches 8,000 estimated
tokens, `/context` shows a red line under INSTRUCTIONS with the total and the
biggest source, and Vera shows one short notice after the first reply in a
conversation, plus the same sentence as a brief overlay that types on
quickly, then a tick. Press Escape to close it when no dialog is open;
otherwise it clears after a few seconds. The numbers
match the Instructions row and the section heading.
While the red line shows, the per-file size warnings are hidden. Trim or split
the biggest source to clear it. The notice appears again in a new or resumed
conversation while the total stays over.

### Change the instruction budget

Find `vera.context` in `/customize` under Extensions and note its absolute
path. Add an explicit entry to the home's `config.json` and set
`instruction_budget_tokens`:

```json
{
    "extensions": [{
        "path": "/absolute/path/to/src/core-extensions/context",
        "enabled": true,
        "config": {
            "instruction_budget_tokens": 8000
        }
    }]
}
```

Set it to `0` to turn the warning off; `/context` still shows the total. A
value that is not a whole number of 0 or more prevents the extension from
activating.

## Inspect an instruction file

1. Press Ctrl+O in the report, or run `/context sources`.
2. Choose a source and press Enter to preview it in [Customize](customize.md).
3. For a writable source, open it in your editor from the preview.

Previews show the file's current saved contents. They are not historical
copies of what the model received.

## Copy or close the report

Drag over text to copy a section, or press Enter to copy the full Markdown
report. Escape closes it without adding the report to your conversation.

To change when Vera summarizes a long conversation, see
[Context limits and compaction](context-levers.md).
