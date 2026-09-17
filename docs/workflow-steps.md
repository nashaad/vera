---
title: "Control workflow steps"
description: "Pause for input, set deadlines, choose stable keys, and run hooks before a step."
---

# Control workflow steps

Halcyon records each successful step so a resumed workflow can reuse its
result. These controls apply when a step has no successful record. Start with
[your first workflow](python-workflows.md) for the decorators and journal setup.

## Pause for input

Raise `Suspend` inside a step when the workflow needs a person's decision:

```python
from vera.workflow.api import Suspend, current, step

@step
def approve(summary: str) -> bool:
    if not current.run.inbox.get("approved"):
        raise Suspend("waiting on sign-off")
    return True
```

The run returns with `status` set to `suspended`. Earlier successful steps stay
recorded. For a file journal, set `approved` to `true` in the `inbox` object in
that run's `header.json`, then resume the workflow. With SQLite, update the
inbox through the journal store instead.

The inbox is read at the start of each run or resume. Changing it during a
run does not change that run's snapshot.

## Process a list

Inside a workflow, use `.map` to call a step once for each item:

```python
docs = fetch.map(["a.txt", "b.txt", "c.txt"])
```

Each item becomes a separate recorded step. After an interruption, resume
reuses completed results and executes items without a record.

For a step with several arguments, use `.submit`:

```python
tickets = [combine.submit(name, size) for name, size in pairs]
values = [ticket.result() for ticket in tickets]
```

Both methods run serially on one thread. `.submit` executes immediately and
returns a ticket containing the result. Neither method starts concurrent work.

## Set a deadline

Declare a timeout in seconds on the step:

```python
@step(timeout=30)
def fetch(name: str) -> dict:
    return {"name": name, "size": 42}
```

The workflow waits up to 30 seconds. If the step has not returned, the run
fails with `run.error.kind` set to `timeout`. Its result is not recorded.
Resuming tries that step again with a fresh deadline.

### Stop work after a timeout

A timeout stops waiting for the result. It does not stop the worker thread,
which can continue until it returns or the process exits. Long-running steps
can check `current.deadline` and stop cooperatively:

```python
import time
from vera.workflow.api import current

@step(timeout=30)
def poll(url: str) -> dict:
    while True:
        if current.deadline is not None and time.monotonic() > current.deadline:
            raise TimeoutError("gave up polling")
        ...
```

`current.deadline` is an absolute monotonic time, or `None` when no timeout
was declared. A timeout must be positive. It limits one attempt; it does not
limit the number of retries across resumes.

## Choose stable keys

By default, repeated calls to the same step are numbered in call order.
Inserting another call to that step can shift later keys and cause saved work
to run again. Calls to a different step do not affect that counter.

Use `current.step` with an explicit key when items have a stable identity:

```python
from vera.workflow.api import current, workflow

def fetch_one(name: str) -> dict:
    return {"name": name, "size": 42}

@workflow
def batch(names: list[str]) -> list[dict]:
    return [current.step("fetch_one", fetch_one, name, key=name) for name in names]
```

`fetch_one` is a plain function, without `@step`. The key identifies the item
independently of its position in the list. Choose unique keys: two calls with
the same key and arguments reuse the first recorded result.

An empty key or a decorated step is refused. `current.step` also accepts
`timeout`. Outside a workflow it calls the function directly.

## Run a hook before a step

Pass `prepare_step` to inspect or change a step before it runs. Recorded
successes skip both the hook and the step body.

Using the `approve` step above:

```python
from pathlib import Path
from vera.workflow.api import workflow

def notify(payload: dict) -> dict:
    print(payload["key"])
    return {"power": "observe"}

@workflow
def sign_off(summary: str) -> bool:
    return approve(summary)

path = Path("/tmp/wf-demo")
run = sign_off.run("looks good", journal_dir=path, prepare_step=notify)
```

After adding approval to the inbox, pass the hook again when resuming:

```python
run = sign_off.resume(run.id, journal_dir=path, prepare_step=notify)
```

The hook chain is not saved in the journal. Pass one callable or a list of
hooks. Omitting `prepare_step`, or passing an empty list, runs steps normally.

### Hook responses

| Response | Effect |
| --- | --- |
| `{"power": "observe"}` | Run the step with its original arguments. |
| `{"power": "mutate", "args": [...], "kwargs": {...}}` | Replace the supplied arguments, retaining the original journal key. Omitted arguments stay unchanged. |
| `{"power": "block", "reason": "waiting for approval"}` | Fail the run with error kind `hook`, without recording a result. |
| `{"power": "replace", "result": true}` | Skip the body and record the supplied result. `null` is also a valid result. |

Use `replace` for an answer supplied within the same process. Editing the
stored inbox affects the next resume, not the current snapshot in
`payload["inbox"]`.

### Executable hooks

A chain can include `CommandHook(["notify.py"])`, imported from
`vera.workflow.api`. It sends and receives JSON through standard input and
output without a shell.

A thrown error, invalid response, or timeout fails the run before the step
body. The command is killed if its standard output exceeds 64 KiB. No result
is recorded, so resuming retries the step and its hooks.
