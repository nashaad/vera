---
title: "Extension APIs"
description: "Read the transcript, call models, observe turns, message sessions, add annex pages, and ship skills from an extension."
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

A tool that declares `extension.storage.read` or `extension.storage.write`
must also be named in an `unreviewed_tools` list in the manifest. See
[Permission rules](permission-rules.md).

Install the directory with `/extension install <path>`, or load it from a
development checkout with `VERA_EXTENSIONS`. See
[Manage extensions](extensions.md). After a change, the client half reloads on
its own; the host half needs the resident host restarted, which Reconnect
host does while the client is still connected.

## Client APIs

| API | Capability | What it does |
| --- | --- | --- |
| `vera.thread.entries()` | `client.thread.read` | Returns the loaded part of the conversation as this client shows it, oldest first. See [Load earlier history](#load-earlier-history). |
| `vera.thread.hasEarlier` | `client.thread.read` | `true` while older entries exist that this client can load. |
| `vera.thread.loadEarlier(signal?)` | `client.thread.read` | Loads the next older part of the conversation. Resolves at once when none is left. |
| `vera.ui.reveal(target)` | `client.ui.reveal` | Loads earlier history as needed and scrolls to an entry, or to the end. Resolves to whether it landed. |
| `vera.ui.registerNoticeRenderer(render)` | `client.ui.notice` | Puts a notice your host half raised with facts into one line. See [Word a notice](#word-a-notice). |

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

### Load earlier history

A long conversation loads in parts. The newest part loads first. Each call to
`loadEarlier` adds the next older part in front of the entries already loaded,
so `entries()` grows toward the start of the conversation. The client also loads
older parts as you scroll toward the top, so `entries()` can change between
calls.

`hasEarlier` is `true` while older entries exist that this client can load. It
is `false` once the whole conversation is loaded, and it is always `false` for a
client that cannot load older parts.

`loadEarlier(signal?)` loads the next older part and resolves when it is in. It
resolves at once when nothing is left to load, and for a client that cannot load
older parts. Calls made while a part is loading share that load. Pass an
`AbortSignal` to stop waiting on the call. A conversation change rejects every
waiting call with `AbortError`. A reconnect to the same conversation rejects
them with `History page request failed: unavailable`. Inside a command or
keybinding, once the user has left the conversation it started in, `hasEarlier`
throws `AbortError` and `loadEarlier` rejects with it.

When the host returns an error for a part, `loadEarlier` rejects with
`History page request failed: <reason>`, and the loaded entries stay as they
were. A part that adds no entries and does not move the cursor also rejects, in
the same format, so a loop cannot spin. To load everything, loop until
`hasEarlier` is `false`:

```ts
while (vera.thread.hasEarlier) {
    await vera.thread.loadEarlier(signal);
}
```

### Jump to an entry

Pass an entry's `id` to scroll the transcript to the row it drew, or `end` to
scroll to the bottom:

```ts
await vera.ui.reveal({ entryId: entry.id });
await vera.ui.reveal({ end: true });
```

`reveal` loads earlier parts as needed. It resolves `true` after scrolling, or
`false` when the entry does not exist, the conversation is left, or its client
detaches. A failed page request rejects, including one that makes no progress.
If another reveal starts first, the older call resolves `false` and the newer
call takes over.

The included `/recap` command loads every older part with `loadEarlier` before
it reads `entries()`, and it jumps with `reveal`. See
[Recap a conversation](included-extensions.md#recap-a-conversation).

### Word a notice

A model middleware can raise a notice as plain text, or as a key and a set
of facts for your client half to put into words in each client:

```ts
// host half, inside registerModelMiddleware
context.notice?.({
    key: "crows_spotted",
    facts: { crows: 3, island: "Skull Rock" },
});

// client half, in activateClient
vera.ui.registerNoticeRenderer((notice) =>
    notice.key === "crows_spotted"
        ? `${notice.facts.crows} crows circling ${notice.facts.island}.`
        : undefined,
);
```

Facts are a flat object of strings, finite numbers and booleans: at most 16
entries, keys of lowercase letters, digits and underscores that start with a
letter, and strings of at most 200 characters. Each client hands a notice with
facts only to the client half of the extension that raised it. The renderer
is called once per notice and returns one line of at most 240 characters, or
nothing to drop the notice. The notice is also dropped when the client half
has no renderer, the renderer throws, or it returns anything else. Register
it once, during activation.

## Host services

| API | Capability | What it does |
| --- | --- | --- |
| `vera.model.oneshot(request)` | `model.oneshot` | Asks the `snappy`, `eco`, or `extra` model for one answer. |
| `vera.hooks.registerPreTurn(hook)` | `hooks.pre_turn` | Runs a function before each prompt's work starts. See [Hooks](hooks.md). |
| `vera.hooks.registerTurnEnding(hook)` | `hooks.turn_ending` | Runs a function on a final reply, before the turn ends. See [Hooks](hooks.md). |
| `vera.hooks.registerTurnFinished(hook)` | `hooks.turn_finished` | Runs a function after each finished turn. |
| `vera.hooks.registerPreCompact(hook)` | `hooks.pre_compact` | Runs a function when a compaction starts. See [Hooks](hooks.md). |
| `vera.hooks.registerContextSizeTrigger(hook)` | `hooks.context_size_trigger` | Runs a function when a context size trigger's actions changed the request, or when the context grows past a configured `context_size_events` fraction. See [Hooks](hooks.md). |
| `vera.hooks.registerSessionUpdated(hook)` | `hooks.session_updated` | Runs a function when a session's status, title, context use or model changes. See [Hooks](hooks.md). |
| `vera.hooks.registerSessionEnd(hook)` | `hooks.session_end` | Runs a function when the host closes a session. See [Hooks](hooks.md). |
| `vera.hooks.registerSubagentFinished(hook)` | `hooks.subagent_finished` | Runs a function when a subagent hands its result back. See [Hooks](hooks.md). |
| `vera.sessions.setTitle(sessionId, title)` | `sessions.title` | Names a session that has never had a name. |
| `vera.sessions.ask(request)` | `sessions.ask` | Asks an open session's own model a side question. |
| `vera.sessions.send(sessionId, text)` | `sessions.send` | Puts a message in an open session's inbox. |
| `vera.agents.investigate(request)` | `agents.investigate` | Runs the explorer agent read-only under an open session and returns its answer. |

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
Either can be empty. A turn that a message started, such as one an extension
sent with `sessions.send`, has an empty `prompt` and only that turn's reply.

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

### Send a conversation a message

`sessions.send` puts text in an open conversation's inbox, from your
extension. It resolves `queued` once the message is stored, or `not_found`
when the conversation is not open. The text must not be blank and is capped
at 16 KiB.

```ts
const outcome = await vera.sessions.send(
    sessionId,
    "The lookout spotted a crow carrying a shiny button toward Skull Rock.",
);
```

`queued` means the message is in the conversation's inbox. It starts a turn
without asking the user, because installing an extension that declares
`sessions.send` is the consent. If a turn is running, the new one starts after
it, and the transcript shows your text. A question about another message in
the same inbox that the user has not answered does not delay yours. Your
message is marked read once the messages before it have been read. If Vera
cannot record the turn, it tries again a few times, then shows a notice that
the message is still held in the inbox.

If the host restarts before the message is read, it waits in the inbox and
Vera asks whether to admit its source: the last part of your extension ID, so
`acme.lookout` is `lookout`.

Your text is exactly what the model reads. Say who it is from and what you
want done; Vera adds nothing. An extension whose ID ends in a name Vera uses
for its own messages, such as `peer` or `schedule`, cannot send.

### Investigate a question

`agents.investigate` runs the explorer agent on a question, under an open
conversation, and returns its final answer. Use it to check a claim against
the workspace before you act on it.

```ts
const result = await vera.agents.investigate({
    sessionId,
    question: "Is the treasure map still in maps/skull-rock.md? Quote the line.",
});
if (result.outcome === "answered") {
    console.log(result.text);
}
```

It takes a `sessionId`, a `question`, and optionally `timeoutMs` and a
`signal`. The timeout defaults to 5 minutes and can be at most 15.

What you can rely on:

- The run is explorer, with its read, grep and list tools, on the model
  assigned to `eco` (see [Assign defaults](models.md#assign-defaults)).
- It always runs `readonly`, whatever the conversation's approval mode, and
  it never stops to ask the user anything.
- It is saved as a subagent run of that conversation, named by
  `runSessionId` when the run finished. The conversation's own transcript
  does not change.
- It counts toward the conversation's limit on agents running at once.

The result's `outcome` is `answered` with the reply in `text`, `failed` with
an `error`, `cancelled` when your signal aborted, or `timed_out`. A
conversation that is not open, or a bad request, rejects instead.

## Watch a folder

An extension can ask the host to watch a folder and put a note in the inbox
when its files change. Declare the watch in the manifest. The watch itself
needs no code, but every extension still needs an entrypoint that exports
`activate`, even an empty one:

```json
{
    "id": "acme.hoard",
    "version": "1.0.0",
    "sdk": "1",
    "entrypoint": "./extension.ts",
    "capabilities": [],
    "contributes": {
        "watches": [
            {
                "id": "loot",
                "source_family": "filesystem",
                "config": { "path": "/Users/crow/hoard", "interval_ms": 5000 }
            }
        ]
    }
}
```

```ts
export function activate() {}
```

- `path` is the folder. `interval_ms` is how often it is checked, 1000 by
  default. Set `"recursive": true` to include files in subfolders.
- A link inside the folder is followed only when it points back inside it.
- The first check only notes what is there. Each later change adds one
  `filesystem.changed` entry naming the folder and how many files it holds,
  including changes made while the host was stopped.
- The first time one reaches a conversation, Vera asks whether to admit the
  `filesystem` source.
- Add `"address": "<conversation id>"` to send the entries to one
  conversation. Without it, every open conversation can read them.
- A user can change the config without editing the manifest, under
  `watches.<id>` in the extension's `config.json` entry.

A watch that keeps failing, for example because `path` is a file, stops until
the host restarts. Changing a watch also needs the host restarted: while
still connected, choose **Reconnect host** from Ctrl+P.

## Annex pages

An extension can add a page to the annex, the local web page `/usage` opens.
Declare it in the manifest:

```json
{
    "id": "acme.hoard",
    "version": "1.0.0",
    "sdk": "1",
    "entrypoint": "./extension.ts",
    "capabilities": ["requests.handle"],
    "contributes": {
        "pages": [
            { "id": "loot", "label": "Loot", "server": "page-server.ts", "browser": "page.ts" }
        ]
    }
}
```

The page appears in the annex sidebar under its label, at
`/x/acme.hoard/loot`. Your host code can link to it with
`vera.annex.pageUrl("loot")`, which is `undefined` while the annex is down.
The address stays the same across host restarts, so a link you send out
keeps working.

The `server` module runs in the annex and exports `activatePage(page)`:

```ts
export function activatePage(page) {
    page.route("hoard", () => Response.json({ buttons: 3 }));
    page.route("bury", async (request) => {
        const where = await request.json();
        return Response.json(await page.host.request("bury", where));
    });
}
```

- `page.route(path, handler)` serves `<page>/api/<path>`. A request other than
  GET or HEAD must come from the page itself.
- `page.storage` is the same storage your host code gets as `vera.storage`.
- `page.markdownBlocks(markdown)` splits markdown into blocks with safe HTML.
  An `![alt](https://…)` becomes an image, or an audio or video player for
  those file types.
- `page.host.request(name, payload)` calls a handler your host code
  registered with `vera.requests.handle`. Use it for anything only the host
  can do, such as `vera.sessions.send`.

The `browser` module runs in the page and exports `mount(root, context)`. It
cannot import other files. `context.api` is the prefix for your routes:

```ts
export function mount(root, context) {
    void fetch(`${context.api}hoard`).then(async (response) => {
        const { buttons } = await response.json();
        root.textContent = `The crow has hidden ${buttons} buttons.`;
    });
}
```

A change to the browser module shows when you reload the page. A change to
the server module needs the host restarted.

The included Artifacts extension in `extensions/artifacts` is a full page:
markdown artifacts an agent writes, with comments you leave in the margin.

## Contribute skills

An extension can ship [skills](skills.md). List directories inside the
extension under `contributes.skills`. Each one holds skill directories laid out
like `~/.vera/skills/`:

```json
{
    "id": "acme.charts",
    "version": "1.0.0",
    "sdk": "1",
    "entrypoint": "./extension.ts",
    "capabilities": [],
    "contributes": {
        "skills": ["./skills"]
    }
}
```

```text
acme.charts/
├── vera.extension.json
├── extension.ts
└── skills/
    └── read-map/
        └── SKILL.md
```

Skills need no capability, so `extension.ts` only needs an empty `activate`:

```ts
export function activate() {}
```

- Each entry is a relative path inside the extension. An absolute path, a `..`
  segment, or a duplicate entry stops the manifest from loading, and
  `/extension list` shows the extension as failed.
- A disabled extension contributes no skills.
- A home or project skill with the same name replaces the extension's.
- Vera reads skills from the copy it loads: the installed copy, or the
  checkout named in `VERA_EXTENSIONS`. A change to a skill there shows after
  the next completed turn, without restarting the host. To pick up edits to
  the source of an installed extension, run `/extension remove <id>`, then
  install it again.
