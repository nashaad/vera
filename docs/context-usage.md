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
the remaining conversation. After resume, the loaded-file list describes the
last measured request.

The maximum comes from the model's known context window. If a local server
does not publish a window, Vera leaves it unknown rather than estimating one.
Used, free, and reserved space remain distinguishable without color.

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
