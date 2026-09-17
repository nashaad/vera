---
title: "Python model calls"
description: "Draft documentation for live model calls through the Python SDK."
draft: true
---

# Python model calls

This archived draft predates live Python SDK support. See [Run Vera from Python](/python-agents/) for current usage. The credential, reasoning-effort, and timeout details below have not been validated against the current implementation.

## Make a model request


Name a supported provider ID and a model available on that provider. Replace
`your-model-id` below with the connected model's ID:

```python
reply = vera.run(
    Agent(
        name="summarizer",
        instructions="Be brief.",
        tools=[],
        posture="readonly",
        provider="openrouter",
        model="your-model-id",
    ),
    "Hello",
)
```

The child reads that provider's credential from
`~/.vera/machine/auth.json`. It does not load home extensions or the model pool,
and does not inherit the rest of the parent environment.

An empty tool list offers no tools. A live child uses low reasoning effort and
a 180-second timeout.

## Record a call in Halcyon

Place `vera.run(...)` inside a function decorated with `@step`. Once the step
result is journaled, resuming the workflow reuses that response.

An interruption before the journal record is saved can repeat the call and
its provider charge. The same retry rule applies to other step side effects.
See [How a run works](halcyon.md#how-a-run-works).

## Earlier manual text

The earlier manual described the same unimplemented path as follows:

> Name both to call a real model. `provider` must be a shipped Vera id such as
> `openrouter`. The child reads that provider's credential from
> `~/.vera/machine/auth.json`, does not inherit the rest of the parent
> environment, and does not load your home extensions or pool:
>
> ```python
> reply = vera.run(
>     Agent(
>         name="summarizer",
>         instructions="Be brief.",
>         tools=[],
>         posture="readonly",
>         provider="openrouter",
>         model="upstage/solar-pro4",
>     ),
>     "Hello",
> )
> ```
>
> A live child uses `reasoning_effort` `low` and times out after 180 seconds.
> Empty `tools` offers none, so the turn is one model call.
>
> Put `vera.run` inside a `@step` and the reply is journaled. Resume will not
> pay for that call again.
>
> The incubating example that uses this is in Vera HQ,
> `examples/workflows/review.workflow.py`, until it is mature enough to copy
> into Vera's `examples/workflows/`.
>
