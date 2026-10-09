---
title: "Extension APIs"
description: "Read the transcript, call models, observe turns, and title or question sessions from an extension."
---

# Extension APIs

An extension is a directory with a `vera.extension.json` manifest and one
entrypoint. The entrypoint can export two functions:

- `activate(vera)` runs in the host. It keeps running whatever client is
  attached, or with none attached.
- `activateClient(vera)` runs in each client that loads the extension, such as
  the TUI.

Every API on this page needs a capability named in the manifest. Without it,
a call throws, or rejects if it returns a promise. This is the manifest of the
included `vera.titles` extension:

```json
{
    "id": "vera.titles",
    "version": "1.0.0",
    "sdk": "1",
    "entrypoint": "./extension.ts",
    "capabilities": [
        "hooks.turn_finished",
        "model.oneshot",
        "sessions.title"
    ]
}
```

Install the directory with `/extension install <path>`, or load it from a
development checkout with `VERA_EXTENSIONS`. See
[Manage extensions](extensions.md). After a change, the client half reloads on
its own; the host half needs the resident host restarted.

## Client APIs

| API | Capability | What it does |
| --- | --- | --- |
| `vera.thread.entries()` | `client.thread.read` | Returns the conversation as this client shows it, oldest first. |
| `vera.ui.reveal(target)` | `client.ui.reveal` | Scrolls the transcript to one entry, or to the end. |

### Read the transcript

`thread.entries()` returns a snapshot. Each entry has a `kind`: `user`,
`assistant`, `tool_call`, `tool_result`, `edit`, `checklist`, or `failure`.
Notices and extension output are left out. Call it again to see later
changes.

Stored entries carry an `id` and an `at` time in epoch milliseconds, set when
the host wrote them. The turn still running has no `id`, and its `at` is when
this client saw it. The last entry of a finished turn also carries
`turnDurationMs`.

A compaction, a rewind, or a reconnect replaces what `entries()` returns, so
keep IDs only as long as you need them.

### Jump to an entry

Pass an entry's `id` to scroll the transcript to the row it drew, or `end` to
scroll to the bottom:

```ts
vera.ui.reveal({ entryId: entry.id });
vera.ui.reveal({ end: true });
```

`reveal` returns `false` when the conversation no longer has that entry. Tell
the user instead of leaving them where they were.

The included `/recap` command is built on these two calls. See
[Recap a conversation](included-extensions.md#recap-a-conversation).

## Host services

| API | Capability | What it does |
| --- | --- | --- |
| `vera.model.oneshot(request)` | `model.oneshot` | Asks the `snappy`, `eco`, or `extra` model for one answer. |
| `vera.hooks.registerPreTurn(hook)` | `hooks.pre_turn` | Runs a function before each prompt's work starts. See [Hooks](hooks.md). |
| `vera.hooks.registerTurnEnding(hook)` | `hooks.turn_ending` | Runs a function on a final reply, before the turn ends. See [Hooks](hooks.md). |
| `vera.hooks.registerTurnFinished(hook)` | `hooks.turn_finished` | Runs a function after each finished turn. |
| `vera.hooks.registerPreCompact(hook)` | `hooks.pre_compact` | Runs a function when a compaction starts. See [Hooks](hooks.md). |
| `vera.hooks.registerSessionEnd(hook)` | `hooks.session_end` | Runs a function when the host closes a session. See [Hooks](hooks.md). |
| `vera.sessions.setTitle(sessionId, title)` | `sessions.title` | Names a session that has never had a name. |
| `vera.sessions.ask(request)` | `sessions.ask` | Asks an open session's own model a side question. |

These calls work once the host has started its sessions. Called earlier, or
after the host has shut extensions down, they reject. Worker processes load
extensions for tools only, so these calls reject there too.

### Ask a model for one answer

`model.oneshot` sends one request to the models assigned to the intent slot
named in `assignment` (see [Assign defaults](models.md#assign-defaults)).
The request has an optional `systemPrompt`, one or more user or assistant
`messages`, an optional `maxTokens`, and an optional abort `signal`. The answer
is the reply `text` plus the `model` and `provider` that gave it.

The slot's models are tried in order, skipping any whose context window cannot
hold the request. If none answers, the call rejects. It never falls back to a
conversation's model.

### Run code after each turn

Register the hook inside `activate`. Registering later throws, and so does
registering without `hooks.turn_finished`.

The hook gets one plain object per finished turn:

| Field | Meaning |
| --- | --- |
| `sessionId`, `workspace` | Which conversation the turn belongs to. |
| `outcome` | `completed`, `error`, or `aborted`. |
| `turns` | User prompts on the conversation's current branch, this one included. |
| `spawned` | `true` when another agent started the conversation. |
| `prompt` | The user's prompt, plus any prompts queued into the turn. |
| `reply` | The assistant's visible text. |

Tool calls, thinking, and internal messages are not in `prompt` or `reply`.
Either can be empty.

The hook only observes. Nothing waits for it, and the next turn can start
while it runs. A hook that throws is logged and does not affect the
conversation or other hooks. Temporary helper sessions do not fire it, and
reopening a saved conversation does not replay old turns.

### Title a conversation

`setTitle` names a conversation only if it has never had a name. A name the
user set wins, and so does a name the user cleared. The title is trimmed and
whitespace runs, line breaks included, become one space.

It resolves to `set`, `named` when the conversation already had a name, or
`not_found` when it is not an open conversation. A new title shows in every
client, including the window title of one that has the conversation open.

A short version of `vera.titles`:

```ts
export function activate(vera) {
    vera.hooks.registerTurnFinished(async (turn) => {
        if (turn.turns !== 1 || turn.spawned || turn.outcome !== "completed") {
            return;
        }
        const { text } = await vera.model.oneshot({
            assignment: "snappy",
            systemPrompt: "Name this voyage in five words or fewer.",
            messages: [{ role: "user", text: turn.prompt }],
            maxTokens: 32,
        });
        await vera.sessions.setTitle(turn.sessionId, text);
    });
}
```

After the first turn of "plot a course for the shiny buttons", the
conversation is titled "Raid on the button factory". If the user had already
run `/rename Loot`, `setTitle` returns `named` and the title stays "Loot".

### Ask a conversation a side question

`sessions.ask` takes a `sessionId`, a `question`, and optionally `maxTokens`
and a `signal`. It answers with `text`, `model`, and `provider`.

```ts
const { text } = await vera.sessions.ask({
    sessionId,
    question: "Which island did the crow hide the stolen buttons on?",
});
```

What you can rely on:

- It resends the conversation's last saved model request with your question
  added as one user message. The model, provider, system prompt, tools,
  messages, and reasoning effort are the same, so a provider cache can reuse
  most of the request.
- The question is not added to the transcript. Nothing the model sees in later
  turns changes.
- It never waits for a running turn and never blocks one. During a turn it
  answers from the last saved request.
- Tools are offered to the model but never run. A reply that calls a tool
  rejects.
- It makes one attempt with that one model. An error rejects and names the
  provider and model.
- A conversation that has not sent a model request yet, or is not open,
  rejects.

When the provider reports usage, the call is billed to that conversation and
counted in [`/usage`](usage.md) with its spend and requests.
