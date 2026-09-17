---
title: "Agents and delegated work"
description: "Choose reusable instructions and tools, and control which models can handle delegated tasks."
---

# Agents and delegated work

An agent definition describes a role: its instructions and the tools it may
use. Select a definition with `/agent` for your own conversation, or ask Vera
to delegate a task to it in a separate conversation.

Definitions can restrict the conversation's permissions. They cannot grant
access beyond what the conversation allows.

## Use the explorer

Explorer is an included role for investigating questions. It reads, searches,
and lists material, then returns findings with references. It cannot edit
files, run shell commands, or invoke skills.

1. Open `/defaults` and assign a model to **eco**.
2. Ask Vera to use explorer for a question and name the material to inspect.
3. Read the returned findings. The result also identifies the definition,
   model, and reasoning effort used.

Delegated explorer tasks use eco. That model does not also need a Subagents
assignment. If eco is unavailable, fix that assignment and retry.

Selecting explorer with `/agent` instead changes the current conversation's
instructions and tools. It leaves the conversation model unchanged.

## Allow models for subagents

Open `/defaults` and choose **Subagents**. Add the models delegated tasks may
use, in fallback order. Models can come from different connected providers.

**Spawning session model** is a separate option. Turn it on to allow the
parent conversation's model after the assigned list. It is off by default.

A requested model must be in the list, or be the parent model with that
option enabled. An unassigned model is refused.

### If a model is unavailable

Vera tries the remaining assigned models in order. It reports a substitution
with the requested model, the model used, and the reason. It does not choose
an unassigned model.

If no model is assigned and parent fallback is off, an interactive client
opens the Subagents settings. An unattended client returns a failure.
Once a child starts, request retries apply to its selected model; exhausting
retries does not restart the assignment search.

## Create a definition

Use `/create-agent` to describe a recurring job and review a proposed
definition before saving it. See [Create an agent definition](skills.md#create-an-agent-definition).

### Definition reference

An omitted tool list allows all available tools. An empty list allows none.

A definition can bind delegated launches to a particular assignment with
`subagent_assignment` in Markdown frontmatter, or `subagentAssignment` in an
extension registration. That assignment replaces the ordinary Subagents list
and disables parent fallback. Explorer's eco assignment works this way.
Explicit model requests must remain inside the bound assignment.

The parent-model option is stored as
`model_assignments.subagents.allow_self`; an absent value means off.
