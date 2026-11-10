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

`Agent` accepts `name`, `instructions`, `tools`, `posture`, `provider`, and
`model`. `tools` names Vera's built-in tools, such as `"read"`, and can also
hold your own Python functions. An empty list gives the agent no tools.
`provider` and `model` each override the route your Vera home is configured
with; leave them unset to use that route.

## Give the agent your functions

Put a Python function in `tools` and the model can call it:

```python
from vera.agent import Agent
from vera.instance import Vera


def count_parrots(deck: str, include_chicks: bool = False) -> str:
    """Count the parrots on one deck of the ship.

    Args:
        deck: Which deck to search, such as "poop" or "gun".
        include_chicks: Whether the chicks in the rigging count.
    """
    return f"{deck}: {5 if include_chicks else 3} parrots"


lookout = Agent(
    name="lookout",
    instructions="Answer the captain with a parrot count.",
    tools=[count_parrots],
)

with Vera.create(workspace="/path/to/ship") as vera:
    print(vera.run(lookout, "How many parrots on the poop deck, chicks too?"))
```

The model learns what the function does from its docstring, and which
arguments it takes from its type hints. Arguments without a default are
required. Each `Args:` line describes that argument.

The function runs in your process when the model calls it, in every built-in
permission mode, without asking you. Putting it in `tools` is the consent. A
string it returns goes to the model as is, and a dataclass or any other value
goes as JSON. If it raises, the model reads the error and the run carries on.

`tools` can mix names and functions, such as `["read", count_parrots]`. To
change the name or description the model sees, wrap the function with `tool`:

```python
from vera.tools import tool

census = tool(count_parrots, name="parrot_census", description="Count parrots aboard.")
```

A function must be a plain `def`, not `async def`. Its name must be lowercase
snake_case and must not be a built-in tool's name. Like a hook, a function
cannot call `run()` or `tool()` on the instance running it.

## Continue a conversation

Pass the same `session` name to successive `run()` calls on an instance to
continue a conversation. Without a session name, each call starts fresh.
The optional `timeout` argument sets the request timeout in seconds.

## Read a named session's history

Read pages from newest to oldest. Entries within each page are oldest first.
The session belongs to this `Vera` instance and remains available until it closes.

```python
from vera.agent import Agent
from vera.instance import Vera

with Vera.create(workspace="/path/to/ship") as vera:
    crow = Agent(name="lookout", instructions="Watch the horizon.", tools=[])
    vera.run(crow, "Chart the island.", session="voyage")
    for page in vera.history("voyage"):
        for entry in page:
            print(entry)
```

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
`arrived_during_turn`, `reasoning_effort`. A key set to `None` counts as not
set. If `prepare_turn` raises or returns something Vera cannot use, `run()`
raises `RuntimeError`. If `before_turn_ends` does, the turn ends with the
reply it has.

A hook cannot call `run()` or `tool()` on the instance that is running it.
That call raises `RuntimeError`, and so does the outer `run()` once its turn
ends. To have another agent judge the reply, give the hook its own `Vera`.

## Close an instance

The context manager closes the child process and removes its temporary runtime
directory. If you create an instance without `with`, call `vera.close()` when
you finish. The temporary runtime directory is separate from your Vera home.
