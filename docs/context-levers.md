---
title: "Context limits and compaction"
description: "Control how much conversation Vera retains and when it summarizes older material."
---

# Context limits and compaction

As a conversation grows, Vera summarizes older material to make room for new
work. This is compaction. The default settings control when it happens, how
large the summary is, and how tool results use the remaining space.

Use `/context` to inspect usage before changing these settings. If the
conversation is working well, leave the defaults in place.

## What the model keeps

Every message, tool call and file the model reads takes up tokens in the
context. The context has a fixed size, so a long session fills it. Once it is
full, the next model call does not fit.

Vera makes room in two ways. Once the context passes a threshold (60% on a
typical model window), tool results from a few turns back are trimmed: a large
one to a short note that says where the full output is saved, a small one to a
stub that names it. When a new turn starts, the tool result budget can also
trim older results. During a long turn, when context reaches 75% of the window,
eligible earlier tool results become stubs in one pass, keeping the newest
step intact. Full output remains in the session and spill files when available.
Another pass waits until context has fallen to 35% of the window or less.
Each trim changes the part of the conversation the provider has cached, so the
provider re-reads everything after it at the full input price. If the context
still passes 82%, older messages become one summary in one go. Your last two
messages stay as they were. When the current turn alone is too big to keep,
its work is summarized too, but your latest message stays word for word next
to the summary. Images in it are not kept.

A single tool result is also capped on arrival, so one large read cannot fill
the context by itself. The cap is a share of the model's window, which means a
small window gets a smaller cap. What was cut is saved to a file the result
points at.

The tool results kept in one request are also capped in total. That total is
about a quarter of the model's window, with a floor of 32 KiB and a ceiling
of 1 MiB. A model whose window is unknown gets 128 KiB. If a configured
one-result ceiling is higher than the current total, Vera uses the total as
the ceiling and marks both settings with a caution.

A subagent's conversation compacts the same way, with the same settings.

Here is the same raid twice, first without compaction, then with it. Sizes
are in made-up crow words, and the model fits 100 of them. Real models count
tokens and fit hundreds of thousands.

<div data-widget="screen-steps" data-steps="context-no-compaction"></div>

<div data-widget="screen-steps" data-steps="context-compaction"></div>

## Announce a context size

`context_size_events` in `config.json` is a list of fractions of the context
window. When the measured context grows past one, Vera fires the
`context_size_trigger` hook with `reason: "level"` and `level` set to that
fraction. Use it to report or record how full a session is.

```json
{
  "context_size_events": [0.5, 0.7, 0.9]
}
```

A level fires once per crossing. Several levels crossed at once fire in
ascending order. The context dropping below a level arms it again; this can
happen through compaction, rewind, or a larger window. A level added while the
context is already above it waits for the context to drop below it and grow
past it again. A new session starts at 0, and a resumed session starts from its
last stored measurement, so a restart does not report a level twice.

The list takes numbers above 0 and at most 1. Vera sorts it and removes exact
duplicates. An empty list means no level events. The key is read on the next
measurement, so a change applies to an open session without a restart. An
ephemeral session fires nothing, and a level runs no action, so the model
request is unchanged. [Hooks](hooks.md#register-from-an-extension) shows how to
receive it.

A command hook can keep a log of each crossing. With this in `config.json`:

```json
{
  "context_size_events": [0.5, 0.7, 0.9],
  "hooks": [{ "phase": "context_size_trigger", "argv": ["crows-nest"] }]
}
```

and this executable at `hooks/crows-nest` in the Vera home:

```sh
#!/bin/sh
cat >> /tmp/crows-nest.log
echo >> /tmp/crows-nest.log
```

each crossing appends one JSON line with the session ID, `reason`, `level`,
`tokens` and `capacity`. The same hook also hears trims, stubs and automatic
compactions, with `reason: "pressure"`. Restart the resident host after adding
the hook, as [Add a hook](hooks.md#add-a-hook) explains.

## When compaction cannot run

Vera retries retryable summary model failures before reporting that the summary
could not be made. An idle timeout moves to the next model without retrying the
same model. Stopping the turn also stops any retry wait.

If a summary cannot be made, the transcript shows a notice starting
`Could not summarize`, and the conversation carries on unchanged. The reason
says what to do:

- `There is not enough finished history to compact yet.` Keep working; there
  is nothing older to summarize.
- A reason that names the instructions and tool definitions, or the latest
  messages, means they leave no room for a summary under the trigger. It ends
  with what to raise: the context limit (or a model with a larger window), or
  `compaction.trigger_tokens` when the model's window is unknown.
- `Could not summarize the earlier messages: <reason>` means the summarizing
  model failed. The reason comes from the provider.

Asking to compact while a turn is running shows `Compaction runs between
turns. Try again once this one finishes.` Stopping a compaction leaves the
earlier messages as they were.

Every `Could not summarize` is also recorded for `/failure-report` (see
[Troubleshooting](troubleshooting.md#capture-a-model-failure)).

## Change a setting

Open `/settings` and choose **Overrides**. The screen contains controls for
the context limit, compaction trigger and target, retained material, and tool
result limits. Highlight a setting to read its explanation, then choose a value.

Each change saves only that setting. Choose **Default** in its value screen
to remove your override.

### Read the status columns

```text
Context limit             8k        set      live
Compaction trigger        0.82      default  live
Compaction trigger tokens none      default  inert
```

| Label | Meaning |
| --- | --- |
| set | You supplied an override. |
| default | Vera is using its default value. |
| live | The setting applies in this conversation. |
| inert | The setting does not apply with the current context-window configuration. |
| caution | The one-result ceiling is held to the total tool-result budget. |

The explanation beside an inert setting says why it is unused.

### Fraction or token limits

When a context window is known, Vera can use fractions of that window for
compaction. If the model has no known window and you have not set a limit,
fixed token settings take their place. Setting a context limit makes the
fraction settings active instead.

Both sets stay visible so you can tell which values currently apply.

## Resolve conflicting values

An explicitly set total tool-result budget must cover the configured
one-result ceiling, or the default 64 KiB ceiling when none is configured.
Vera refuses a conflicting choice before saving it. The value screen shows
**Not set** with the two values involved. A one-result ceiling can be set
without setting a total budget.

A summary target at or above the compaction trigger is allowed, which helps
when you want compaction to happen early, for example while testing it.
Vera asks first and shows both values. Press 1 to save anyway or Escape to
go back to the list. While the target is not under the trigger, compaction
aims for about a third of the trigger instead, so one compaction does not
set off the next.

## Reset overrides

Choose **Reset all to defaults** to clear all eleven context overrides. The
confirmation lists the overrides you set. Press 1 to clear them or Escape to
keep them. Other configuration stays unchanged.

The same settings are stored in `config.json`: top-level `context_limit` and
`context_size_events`, plus the `compaction` and `tool_results` blocks. The
settings screen validates changes to the values it controls.
