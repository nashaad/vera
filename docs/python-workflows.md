---
title: "Write your first workflow"
description: "Define steps, choose a journal, and resume completed work with Halcyon."
---

# Write your first workflow

This guide creates a small Halcyon workflow, saves its results, and shows how
to resume and inspect a run. Use Python 3.11 or newer from a Vera checkout.
See [Halcyon workflows](halcyon.md) for how recorded steps work.

## Run the included example

From the Vera checkout root:

```sh
mkdir -p /tmp/wf-demo
PYTHONPATH=python python3 examples/workflows/counter.workflow.py /tmp/wf-demo
```

The example prints a run ID and result, then stores the run under
`/tmp/wf-demo`. The journal directory must exist before the run starts.

## Define steps and a workflow

A step is a function with `@step`. A workflow calls those steps from ordinary
Python code:

```python
from pathlib import Path
from vera.workflow.api import workflow, step

@step
def fetch(name: str) -> dict:
    return {"name": name, "size": 42}

@step
def summarize(doc: dict) -> str:
    return f"{doc['name']} is {doc['size']} bytes"

@workflow
def report(name: str) -> str:
    """Fetch one document and describe it."""
    return summarize(fetch(name))

run = report.run("notes.txt", journal_dir=Path("/tmp/wf-demo"))
print(run.id, run.status, run.result)
```

The step results are recorded. Work between steps is not. Put file writes,
network calls, and other side effects inside steps, and make them safe to
repeat if a run stops before recording the result.

### Choose a journal

Pass exactly one of `journal_dir` or `journal`. For file storage,
`journal_dir` points to an existing directory. For SQLite:

```python
from vera.workflow.api import SqliteJournalStore

run = report.run("notes.txt", journal=SqliteJournalStore("/tmp/wf-demo.sqlite"))
```

Both are explicit storage choices. A journal is not automatically part of the
resident host's runtime or the TUI's `/work` list.

### Use serializable values

Step arguments and results use JSON-compatible values: dictionaries with string
keys, lists, strings, numbers, booleans, and `None`. Unsupported arguments,
such as `bytes` or custom objects, fail serialization before the body runs.

## Resume a run

Call the workflow's `resume` method with its saved run ID and journal:

```python
run = report.resume(run.id, journal_dir=Path("/tmp/wf-demo"))
```

Completed steps return recorded values. A failed, suspended, or interrupted
step is tried again if it has no successful record.

### Resume from another process

For a workflow with a recorded source entry:

```sh
PYTHONPATH=python python3 -m vera.workflow resume /tmp/wf-demo <run-id>
```

The command loads the recorded source file and restores the original working
directory and inputs. Use the database path instead of the directory for a
SQLite journal.

An older journal or a run created through `python -c` may have no source entry.
The command then exits with status 2 and directs you to call the workflow's
`resume` method in its original context.

### Read the outcome

| `run.status` | Meaning |
| --- | --- |
| `ok` | The workflow returned a result. |
| `failed` | A step or hook failed. Read `run.error.kind` and `run.error.message`. |
| `suspended` | The workflow paused for input. |
| `crashed` | The process running it died. A sweep found it and said so. |
| `running` | The run is active. |

A failed step returns a Run result rather than raising out of `run()`.
Steps are retried, not rolled back.

## Inspect recorded progress

```sh
PYTHONPATH=python python3 -m vera.workflow show <run-id> --journal-dir /tmp/wf-demo
```

The output includes the run ID, workflow name, status, and completed step keys
with how long each step took. While a step is running, and after a crash, the
report also names the step in flight. It then lists one line per attempt: the
process that ran the workflow, when it started, and how it ended. An attempt
with no ending is one whose process never came back. A workflow docstring also
appears in the report.

If the ID is missing, the error lists up to ten available run IDs and counts
any remaining ones. In file storage, run IDs are also the directory names.

## Find runs whose process died

A run left `running` by a process that never came back stays `running` until
someone looks. The sweep does the looking:

```sh
PYTHONPATH=python python3 -m vera.workflow sweep --journal-dir /tmp/wf-demo
```

It considers a run only when the last attempt is still open and its `pid` on
this host is gone. Those runs are marked `crashed` with a `reason`, and the open
attempt is left open as the evidence. Nothing is run again.

Passing `--resume` resumes each run it just marked, in this process, one after
the other. A run someone asked to cancel is marked but never resumed.

The sweep reads pids on the machine that recorded them, so it skips runs whose
attempt names another host, and it skips a pid the operating system has since
handed to something else. Run it on the machine the workflows ran on.

### Journal files

```text
/tmp/wf-demo/<run-id>/
  header.json
  journal.ndjson
  blobs/
```

The header stores run metadata and inputs, and while a step is running it also
names that step under `active`. `attempts` holds one entry per run or resume,
each with `started_at`, `pid`, and `host`, and gaining `finished_at`, `status`,
and, on a failure, `error` when that attempt ends. The journal has one record per successful step,
each with the time it finished (`at`) and how many milliseconds it took (`ms`). Values larger than 8192 bytes are stored in `blobs/` with a
hash reference. SQLite stores the same facts in `runs`, `records`, and `blobs`
tables in one database file.

### Read a file journal from TypeScript

```ts
import { readWorkflowRun } from "./src/sdk/workflow-journal.ts";

const run = readWorkflowRun("/tmp/wf-demo/<run-id>");
console.log(run.header.workflow, run.records.length);
```

This reader supports file journals, not SQLite databases.

## Try an interrupted run

The included audit example measures tracked TypeScript and Python files in a
checkout. From the Vera checkout root:

```sh
mkdir -p /tmp/wf-audit
PYTHONPATH=python python3 examples/workflows/audit.workflow.py run /tmp/wf-audit /path/to/vera
```

To stop after a chosen number of files and then resume:

```sh
mkdir -p /tmp/wf-crash
PYTHONPATH=python python3 examples/workflows/audit.workflow.py run /tmp/wf-crash /path/to/vera 400
PYTHONPATH=python python3 examples/workflows/audit.workflow.py resume /tmp/wf-crash <run-id>
```

The example also appends each measurement to `measured.log`. A file measured
just before interruption may appear twice if its journal record was not saved.
This demonstrates why steps with side effects must tolerate retries.

Continue with [step controls](workflow-steps.md) or
[the Python instance API](python-agents.md).
