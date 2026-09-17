---
title: "How Vera works"
description: "Understand conversations, tools, permissions, and recorded workflows."
---

# How Vera works

Vera is an agent harness. The model generates responses and requests tool calls;
Vera supplies context, checks permissions, runs tools, and saves the conversation.
You can inspect changes, stop work, or continue with another message.

For repeatable work, Halcyon lets you write Python workflows that save
completed steps across restarts.

## Conversations and tools

A conversation holds your messages, responses, and tool results. The selected
agent definition supplies instructions and a list of available tools. Your
permission setting limits what those tools may do.

<div data-diagram="conversation-loop">

```text
Your message
     |
     v
Model reads context <--- Tool results
     |                       ^
     +--> Tool request --> Permission check --> Run tool
     |
     v
Response
```

</div>

Tool use can repeat while Vera works on the task. You can review workspace
changes with `/diff` and stop the active turn with Ctrl+C. Messages you submit
during a turn are queued. See [Queue messages](queued-messages.md) for the
controls that send them.

### Models and definitions

The model generates responses and tool requests. The definition sets the
instructions and available tools for a role, such as planning or investigation.
Changing one does not necessarily change the other.

Use `/model` to choose a connected model and `/agent` to choose a definition.
See [Models](models.md) and [Agents and delegated work](agents.md).

### Permissions

The quick controls offer readonly, ask, and auto access. Open them with
Shift+Tab. A definition can restrict the conversation's permissions further;
it cannot grant broader access.

Automatic approval checks rules first and uses a classifier when needed. See
[Automatic approval](permission-classifier.md) for configuration and failure
behavior.

## Context and customization

Each request includes the conversation's working context. Instructions, tool
results, and other loaded sources use space in the model's context window.
Open `/context` to inspect that usage and its sources.

You can provide project instructions, reusable skills, standing instructions,
and extensions. `/customize` lets you browse their sources. Start with
[Customize Vera](customize.md) and [Vera's files and settings](config-reference.md).

As the conversation grows, compaction reduces earlier context. Its limits and
related controls are under `/settings`, then Overrides. See
[Context limits and compaction](context-levers.md).

## Saved and running work

Vera's resident host owns live conversations and tool execution. The terminal
and other clients display that state and send your actions to the host.
Closing a client does not necessarily stop the work it was displaying.

The conversation rail lets you browse saved conversations. Resuming a
conversation is a separate action. Use `/resume` to switch, choosing whether
the current work stops or keeps running. See [Saved conversations](sessions.md)
and [Switch conversations](session-switching.md).

Delegated work runs in child conversations. `/subagents` opens their list;
`/parent` returns to the parent conversation.

## Halcyon workflows

A workflow is Python code that calls recorded steps. On resume, Halcyon reuses
successful step results and runs steps that have no result in the journal.
Use it for repeated sequences, processing collections, and work that pauses
for a person's decision.

A step runs ordinary Python code. Progress is stored in a file or SQLite
journal that you choose. See [Halcyon workflows](halcyon.md) for the
execution and retry rules, then [write your first workflow](python-workflows.md).
