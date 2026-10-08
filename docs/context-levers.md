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
typical model window), big tool results from a few turns back are trimmed to a
short note that says where the full output is saved. If the context still
passes 82%, older messages become one summary in one go. Your last two
messages stay as they were. When the current turn alone is too big to keep,
its work is summarized too, but your latest message stays word for word next
to the summary. Images in it are not kept.

A single tool result is also capped on arrival, so one large read cannot fill
the context by itself. The cap is a share of the model's window, which means a
small window gets a smaller cap. What was cut is saved to a file the result
points at.

Here is the same raid twice, first without compaction, then with it. Sizes
are in made-up crow words, and the model fits 100 of them. Real models count
tokens and fit hundreds of thousands.

<div data-widget="screen-steps" data-steps="context-no-compaction"></div>

<div data-widget="screen-steps" data-steps="context-compaction"></div>

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

The explanation beside an inert setting says why it is unused.

### Fraction or token limits

When a context window is known, Vera can use fractions of that window for
compaction. If the model has no known window and you have not set a limit,
fixed token settings take their place. Setting a context limit makes the
fraction settings active instead.

Both sets stay visible so you can tell which values currently apply.

## Resolve conflicting values

The limit for one tool result must not exceed the total tool-result budget.
Vera refuses a conflicting choice before saving it. The value screen shows
**Not set** with the two values involved. Adjust the other limit or choose
a compatible value.

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

The same settings are stored in `config.json`: top-level `context_limit`,
plus the `compaction` and `tool_results` blocks. The settings screen validates
changes to these values.
