---
title: "Run Vera from Python"
description: "Run model requests from Python using your Vera configuration."
early_access: true
---

# Run Vera from Python

The Python SDK runs Vera through a Bun child process. It uses your selected
Vera home's configuration and credentials. [Connect a provider](/models/)
before running a request with the configured default model.

## Run a request

Run this from an environment where the checkout's `python` directory is on
`PYTHONPATH` and Bun is available:

```python
from vera.agent import Agent
from vera.instance import Vera

with Vera.create(workspace="/path/to/project") as vera:
    reply = vera.run(
        Agent(name="summarizer", instructions="Be brief.", tools=[]),
        "Explain what a Python context manager does.",
    )
    print(reply)
```

`Agent` accepts `name`, `instructions`, `tools`, and `posture`. Set `provider`
and `model` together to choose a connected provider and model for that request.
One without the other is refused. Leave both unset and `run()` returns the
prompt unchanged, without calling a model.

## Continue a conversation

Pass the same `session` name to successive `run()` calls on an instance to
continue a conversation. Without a session name, each call starts fresh.
The optional `timeout` argument sets the request timeout in seconds.

## Shape a turn

`run()` takes two optional functions. `prepare_turn` runs before the first
model call and can add context or narrow the turn. `before_turn_ends` runs
when the agent would stop and can send it back once with more context. Each
gets the turn as a dict and returns a dict, or `None` to leave the turn alone:

```python
def spot(turn):
    return {"power": "mutate", "context": "The crow buried it under the third palm."}

def lookout(turn):
    if "map" in turn["reply"] or turn["continuations"] > 0:
        return None
    return {"power": "continue", "context": "You found it. Now draw the map.",
            "display": "Lookout: no map yet"}

reply = vera.run(crow, "find the treasure", prepare_turn=spot, before_turn_ends=lookout)
```

The keys are the ones in [Hooks](/hooks/), in snake_case: `session_id`,
`arrived_during_turn`, `reasoning_effort`. If `prepare_turn` raises or
returns something Vera cannot use, `run()` raises `RuntimeError`. If
`before_turn_ends` does, the turn ends with the reply it has.

## Close an instance

The context manager closes the child process and removes its temporary runtime
directory. If you create an instance without `with`, call `vera.close()` when
you finish. The temporary runtime directory is separate from your Vera home.
