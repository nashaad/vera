---
title: "Run Vera from Python"
description: "Create an isolated Python instance and run its echo-only entry point."
---

# Run Vera from Python

The Python SDK provides `Agent`, `Vera.create()`, and `Vera.run()`. The current
`run()` implementation echoes the prompt back. It does not call a model.
It runs from a Vera checkout and starts a Bun child process.

## Create and close an instance

```python
from vera.agent import Agent
from vera.instance import Vera

vera = Vera.create(workspace="/path/to/project")
try:
    reply = vera.run(Agent(name="summarizer", instructions="Be brief."), "Hello")
    print(reply)
finally:
    vera.close()
```

This prints `Hello`. The instructions do not change the echoed response.
`Agent` accepts `name`, `instructions`, `tools`, and `posture`.

Each instance uses a private temporary home and removes it on close. It does
not write your daily home or change the Python process's environment.
