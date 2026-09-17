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

The summary target must be below the compaction trigger. The limit for one
tool result must not exceed the total tool-result budget.

Vera refuses a conflicting choice before saving it. The value screen shows
**Not set** with the two values involved. Adjust the other limit or choose
a compatible value.

## Reset overrides

Choose **Reset all to defaults** to clear all eleven context overrides. The
confirmation lists the overrides you set. Press 1 to clear them or Escape to
keep them. Other configuration stays unchanged.

The same settings are stored in `config.json`: top-level `context_limit`,
plus the `compaction` and `tool_results` blocks. The settings screen validates
changes to these values.
