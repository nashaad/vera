---
title: "Run Vera from Python"
description: "Run model requests from Python using your Vera configuration."
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

## Close an instance

The context manager closes the child process and removes its temporary runtime
directory. If you create an instance without `with`, call `vera.close()` when
you finish. The temporary runtime directory is separate from your Vera home.
