# Dials

A dial is a model and the reasoning effort it runs at. Shift+Tab opens the
strip:

```
  dials   [1 sol·low]  2 luna·high   3 opus·high   4 haiku·medium   …
          ←/→ pair · ↑/↓ effort · 1-9 jump · ⏎ set · esc cancel
```

Nothing changes until you press Enter, and nothing reaches the provider until
your next message: the request carries whichever pair is active when you send.

- `←` `→` move between pairs. An uncommitted effort edit on the pair you leave
  is discarded — an edit that followed you along the strip would be a second,
  invisible dial.
- `↑` `↓` move the effort on the highlighted pair, by ordinal, without
  wrapping. A model that publishes no levels says "no effort dial" and the
  arrows do nothing.
- `1`–`9` jump to a position.
- `⏎` commits. `esc` puts back the pair the strip opened with.
- **Any other key you type exits to the composer and the keystroke lands
  there.** This is the primary exit, and it is why the strip has no letter
  navigation. Rebinding letters onto movement in `tui.json` is allowed and
  costs you type-to-commit for those letters.

Position 1 is always the pair this session is committed to, so "the pair I am
on is not in the list" cannot happen. After it come your favourites in order,
then pairs this session has used, newest first, with repeats dropped. Six are
shown; the rest are a trailing `…`, and the full list of models lives in
`/model`.

## Session-scoped, not global

Dialling writes this session's pair and nothing else. Your host defaults are
untouched, and other sessions do not move. That is what the `*` in the status
line means:

```
sol/gpt-5.6-sol · LOW          the pair the session inherited
sol/gpt-5.6-sol · HIGH *       a pair you dialled yourself
```

The marker reads off a recorded origin, not a comparison — so dialling back to
the default clears it, whichever way you got there.

A host that does not support session-scoped state hides the strip and says so,
rather than quietly rewriting your defaults instead.

## Favourites

Favourites live in `tui.json` as pairs. Starring a model in `/model`
(`ctrl+s`) adds one, using the effort you are running at when the starred model
is the one in force, and the model's own default level otherwise. You can also
write them by hand:

```jsonc
"favorite_pairs": [
  { "name": "sol",  "provider": "openai-codex", "model_id": "gpt-5.6-sol", "effort": "low" },
  { "name": "luna", "provider": "zai",          "model_id": "glm-5",       "effort": "high" },
  {                 "provider": "ollama",       "model_id": "qwen3:32b" }
]
```

An entry needs a `name` or a `(provider, model_id)`; both is best. The name is
the identity a rename follows; the id is what finds the entry again when a
rename happened while Vera was not running — in which case the name is
rewritten in place rather than going stale. A favourite that resolves to
nothing renders dimmed and unselectable. It is never deleted for you.

## Fallback

When a provider fails mid-turn, the turn finishes on something else and the
status line says so:

```
sol/gpt-5.6-sol→haiku · LOW
```

The committed pair is unchanged and is retried on the next turn, so the arrow
clears when the turn ends. A subagent falling back to another model is the
subagent's business: it shows in the transcript and never in the status line.

## Quickslots

Quickslots are gone. Saved slots were migrated into `favorite_pairs` once, the
first time this version ran, and the old blocks are left on disk for a release
in case you want them back. `/quickslot` and the numbered cycle are removed:
the strip shows you what you are about to take before you take it.
