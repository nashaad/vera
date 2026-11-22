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
`async_subagent` returns a child ID immediately. When the child finishes, its
summary joins the parent's next model request after the current tool step, or
starts a new turn if the parent is idle. It does not interrupt a running model
request or tool. The guidance reserves it for substantial independent work the
parent can continue without the child's answer. To send more work to your
child, use `message_subagent`; `agent_send` is for peer conversations. When a
child starts a monitored command, its exit notice belongs to that child's
conversation and can wake it while detached; the parent does not receive that
notice as its own.

Definitions can restrict the conversation's permissions. They cannot grant
access beyond what the conversation allows.

A definition's `posture` applies when it is narrower than the conversation's
current permission mode. Selecting the definition with `/agent`, or delegating
to it, then runs in the posture. A posture equal to or wider than the current
mode changes nothing. If the definition forbids the current mode with
`forbidden_access`, it uses its posture when that is narrower and allowed, or
the narrowest mode it allows. Neither path ever picks a mode wider than the
current one. If no allowed mode fits, a selection with `/agent` is refused with
a message and nothing changes, and a delegated launch is refused. If the
narrower mode is saved but the selection itself cannot be saved, the selection
is refused with the error, the conversation keeps its previous agent, and the
narrower mode stays in force. If the selection is saved but the agent's
default model cannot be saved, the agent is selected and a notice says the
session kept its previous model. Resuming a session whose definition now
forbids its mode narrows it the same way and saves the new mode; if no allowed
mode fits, the session switches to the default agent and keeps its mode. Only
the four built-in modes can be compared, so a custom mode never counts as
narrower and a custom posture never applies.

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

## Use the chat agent

Chat is an included role for conversations that are not about a project. It
has no instructions of its own. Its tools are `web_search`, `web_fetch`,
`read`, `list`, `write`, `edit`, `builtin_browser`, and `file_feedback`, so it
can look things up on the web, keep files in the conversation's own folder, use
the built-in browser when its tools are on, and save a feedback report.

A conversation started without a project folder is a chat. The host creates
its folder beside the session file, as `<session-id>.jsonl.files`, works in
it, and starts the conversation on the default agent with all of its tools.
`/agent chat` switches a chat to the chat agent, and `/agent default` switches
it back. A `chat` agent in your own or a project's agents folder replaces the
included one.

The model is told that a chat's folder is the chat's own.

## Choose the agent of a new chat

On the desktop's New Chat page the composer bar has an agent pill beside the
approval pill. It shows the agent the new session starts on, which is `default`
until you pick another. Click it, or type `/agent` with no name, to open Choose
Agent. It lists the agents a session started there would offer: the included
ones, your own, and, when a folder is picked, that folder's project agents. With
no folder picked it lists what a chat offers, which has no project agents.
`/agent crow` picks the agent `crow` directly, and says `No agent named crow`
when the list does not offer it. The host reads the list without starting a
session.

Picking a different folder reads the list again. If the agent you picked is not
offered in the new folder, the pill goes back to `default` and a line under the
composer says `The crow agent is not offered here. This chat starts on default.`

When you send, the window creates the session as usual, switches it to the
agent you picked, and sends your first message only after the session confirms
the switch. If the host refuses the switch, the message is not sent: your text,
images and files go back into that session's composer with the host's reason,
such as `No agent named crow`. If the session does not answer within ten
seconds, they come back with `The session did not answer in time`. Sending with
the default picked starts the session on the default agent and switches nothing.

The pill and the list need a host that has this request. After updating Vera,
restart the host. A host that has not been restarted shows no agent pill on New
Chat, and Choose Agent there says to open a session.

## Suggest keeping notes

Every session the desktop window creates while Settings > Agents > Suggest
keeping notes is on, chats and folder sessions alike, carries a short
instruction in its system prompt. The switch is on by default. The instruction tells the model that
you may want to keep notes from the conversation, and to offer once, in one
sentence, when documents were shared, a decision was settled or a topic keeps
coming back, and to ask where you keep notes, such as a notes app you already
use or a folder. If you decline or ignore the offer, the model does not offer
again. If you agree, it keeps the notes where you say, one page per topic, and
keeps the pages current; if its tools cannot write there, it says so. If you
have nowhere in mind, it uses a `notes/` folder in the working directory with
an `index.md` that links the pages.

The choice is made when the session is created and does not change for that
session, so the start of its system prompt stays the same. Turning the switch
off affects new sessions only. The window keeps the switch in the desktop's
browser storage. Branches and clones keep the choice of the session they came
from; subagents do not get the instruction. Sessions started from the terminal,
`vera -p` or the web client never have it.

Moving a chat to the trash moves its folder with it. Resuming a chat
recreates its folder when it is missing. Branching or forking a chat copies the
folder, so the branch and its source change files independently; a branch that
is temporary keeps working in the source's folder. Delegated children of a chat
work in the same folder and are not chats themselves.

In the desktop, a chat's folder chip has `Move to folder…`, which moves the
conversation and its files into a folder you pick. The conversation then works
in that folder and is no longer a chat. The host refuses the move when a file
in that folder has the same name as one of the chat's files, or while the
conversation is still working.

## Use the help agent

Help is an included role that answers questions about using Vera. It reads
Vera's product guide a section at a time and answers from it. It can list
which model providers are connected and which extensions failed to load, and
it can open a screen to show where something is. It cannot change a setting,
answer a dialog, read your files or run commands, and the other agents do not
have its tools.

In the desktop, the Help button in the sidebar's footer starts a new chat on
the help agent each time you press it. The chat is an ordinary session and
appears in the session list. When the agent shows you something, the window
opens that dialog, Settings section or page. In the terminal, `/agent help`
selects the agent. It opens the terminal's own dialog for a screen that has
one, and says so when the terminal has none. If a dialog is already open in
the terminal, the agent's request is declined and the notice asks you to close
the dialog and ask again.

## Allow models for subagents

Open Defaults from `/models` and choose **Subagents**. Add the models delegated tasks may
use, in fallback order. Models can come from different connected providers. Type to
search the list, then press Enter to add the highlighted model, or to remove it if it
is already assigned. Favorites are listed first. Assigned subagent models
must be favorites, so assigning a model that is not a favorite, here or to
any other default, also adds it to favorites.

**Spawning session model** allows the parent conversation's model after the
assigned list. It is on by default and can be turned off.

A requested model must be in the list, or be the parent model with that
option enabled. An unassigned model is refused.

### If a model is unavailable

Vera tries the remaining assigned models in order, then the parent model if
that option is on. It reports a substitution with the requested model, the
model used, and the reason. It does not choose another unassigned model.

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
read, and the model is not shown it twice. If Vera cannot record the turn,
it tries again a few times, then shows a notice that the note is still held
in the inbox. A conversation running in the
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
`model_assignments.subagents.allow_self`; an absent value means on.
