---
title: "Agents and delegated work"
description: "Choose reusable instructions and tools, and control which models can handle delegated tasks."
---

# Agents and delegated work

An agent definition describes a role: its instructions and the tools it may
use. Select a definition with `/agent` for your own conversation, or ask Vera
to delegate a task to it in a separate conversation.

A delegated child starts without the parent conversation. Put the goal, why
it matters, what you already know, paths, and what to return in the spawn
description.

Vera's delegation guidance defaults to direct work, including small changes
that span several files. When delegation is justified, it prefers `subagent`,
which waits for the result. Independent calls can run in parallel.
`async_subagent` returns a child ID immediately and delivers its summary on
a later turn. The guidance reserves it for substantial independent work the
parent can continue without the child's answer.

Definitions can restrict the conversation's permissions. They cannot grant
access beyond what the conversation allows.

A definition's `posture` applies when it is narrower than the conversation's
current permission mode. Selecting the definition with `/agent`, or delegating
to it, then runs in the posture. A posture equal to or wider than the current
mode changes nothing. If the definition forbids the current mode with
`forbidden_access`, it uses its posture when that is narrower and allowed, or
the narrowest mode it allows. Neither path ever picks a mode wider than the
current one. If no allowed mode fits, a selection with `/agent` is refused with
a message and nothing changes, and a delegated launch is refused. Resuming a
session whose definition now forbids its mode narrows it the same way and
saves the new mode; if no allowed mode fits, the session switches to the
default agent and keeps its mode. Only the four built-in modes can be
compared, so a custom mode never counts as narrower and a custom posture never
applies.

## Use the explorer

Explorer is an included role for investigating questions. It reads, searches,
and lists material, then returns findings with references. It cannot edit
files, run shell commands, or invoke skills.

1. Open `/models`, choose Defaults, and assign a model to **eco**.
2. Ask Vera to use explorer for a question and name the material to inspect.
3. Read the returned findings. The result also identifies the definition,
   model, and reasoning effort used.

Delegated explorer tasks use eco. That model does not also need a Subagents
assignment. If eco is unavailable, fix that assignment and retry.

Selecting explorer with `/agent` instead changes the current conversation's
instructions and tools. It leaves the conversation model unchanged.

## Allow models for subagents

Open Defaults from `/models` and choose **Subagents**. Add the models delegated tasks may
use, in fallback order. Models can come from different connected providers. Type to
search the list, then press Enter to add the highlighted model, or to remove it if it
is already assigned. Favorites are listed first. Subagents only run models in
your favorites, so assigning a model that is not a favorite, here or to any
other default, also adds it to favorites.

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

## Message another conversation

Two conversations open in the same folder can message each other. Ask one
to send a note to the other by its title or its identity, for example "tell
lookout the crow's nest tests pass". Vera finds the other conversation and
stores the note. When the recipient starts a turn for it, the whole note
arrives in its transcript, marked as coming from that conversation and not
from you. A recipient that does not start a turn reads the note when it next
checks its inbox. The sender is not told when it is read.

If you are watching the recipient, Vera asks once whether messages from
other conversations may start a turn. You can allow it once, for this
conversation, or always. Dismissing the question with Escape is not an
answer: the note stays unread, and Vera asks again when another message
arrives for this conversation or when you reattach. A note that starts a turn
while an earlier one is still waiting is marked read after the earlier one is
read, and the model is not shown it twice. A conversation running in the
background with auto or full access permissions starts a turn on its own. One
with ask permissions keeps the message until you return to it.

## Create a definition

Use `/create-agent` to describe a recurring job and review a proposed
definition before saving it. See [Create an agent definition](skills.md#create-an-agent-definition).

### Definition reference

An omitted tool list allows all available tools. An empty list allows none.

Frontmatter is the block of fields between two `---` lines, and it must open
the file. A file is refused, with an error naming the fields, if it lists
definition fields in a `---` block that does not start the file, whether or not
the block is closed, or if it opens with `---`, lists definition fields and
never closes the block. A block runs to the next `---` line or the end of the
file. Apart from the frontmatter itself, a `---` line whose block lists no
definition field, such as a horizontal rule, is ordinary text. Blank lines or a
byte order mark before the opening line, and spaces or tabs after either `---`
line, are allowed. Text after the closing `---` is never read as a second block.

A definition can bind delegated launches to a particular assignment with
`subagent_assignment` in Markdown frontmatter, or `subagentAssignment` in an
extension registration. That assignment replaces the ordinary Subagents list
and disables parent fallback. Explorer's eco assignment works this way.
Explicit model requests must remain inside the bound assignment.

The parent-model option is stored as
`model_assignments.subagents.allow_self`; an absent value means off.
