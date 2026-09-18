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

### A workflow that calls a model and asks you

`examples/workflows/writer.workflow.py` researches a topic, outlines it,
waits for your notes on the outline, then writes a draft. Each step makes one
call to `openai/gpt-5.6-luna` through OpenRouter.

```sh
export OPENROUTER_API_KEY=...
PYTHONPATH=python python3 examples/workflows/writer.workflow.py "sea otters"
```

The run stops after the outline and prints its ID. Answer it:

```sh
PYTHONPATH=python python3 -m vera.workflow answer <run-id>
```

The command prints a local page address. The page shows the outline and takes
your notes, then the run carries on and prints the draft. Pass the notes as a
second argument to skip the page.

The run is stored under the Vera home, so `/runs` in the annex lists it with
its steps, the model calls under them, and the charge OpenRouter reported for
each call. Stop the script during a step and run
`python3 -m vera.workflow resume <run-id>`: finished steps return their
recorded replies and are not sent again.

`--offline` replaces the model with canned replies and needs no key. Offline
calls record tokens but no cost.

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
| `suspended` | The workflow paused for input, such as an `ask`. |
| `crashed` | The process running it died. A sweep found it and said so. |
| `running` | The run is active. |

A failed step returns a Run result rather than raising out of `run()`.
Steps are retried, not rolled back.

## Ask for an answer

`ask` stops the run until someone answers a question, then returns the answer
as a string:

```python
from vera.workflow import ask, step, workflow

@workflow
def publish(topic: str) -> str:
    text = draft(topic)
    verdict = ask(f"Ship this?\n\n{text}")
    return f"{verdict}: {text}"
```

The first run ends `suspended`, with the question in the header's `asking`
field. `show` prints it. To answer:

```sh
PYTHONPATH=python python3 -m vera.workflow answer <run-id> "ship it" --journal-dir /tmp/wf-demo
```

The answer is stored in the run's inbox and the run resumes. Completed steps
return their recorded values, so `draft` does not run again.

Without the text, `answer` prints a page address on `127.0.0.1` and waits.
The page shows the question and takes one answer, then closes, and the run
resumes in the terminal. The address carries a random path, and any other
path returns 404. Ctrl-C leaves the run waiting.

Each `ask` gets a key: `ask#0`, `ask#1`, and so on in the workflow body, or
`<step key>/ask#0` inside a step. A resumed run asks the same questions in
the same order, so each one reads its own answer. A step retried after a
failure asks its questions again and reads the same answers.

`ask` outside a running workflow raises `WorkflowError`.

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

### Spans

Under each attempt the report lists its spans. A span is one try of one step,
with the step name, how long the try took, and how it ended (`ok`, `failed`,
`suspended`, or `cancelled`). A failure carries its message.

Spans and journal records answer different questions. The journal records a
step once, when it succeeds, because that is the value a resume replays. Spans
record every try, so a step that failed twice before succeeding is three spans
and one record. A span with no ending is the try whose process died in it.

Field names follow OpenTelemetry, and the span kind follows OpenInference, so
an exporter maps ids rather than shapes. What Halcyon knows that OpenTelemetry
has no word for rides in `attributes` under a `halcyon.` prefix.

```python
for span in store.load(run_id, None).spans():
    attributes = span["attributes"]
    print(
        attributes["halcyon.attempt"],
        span["name"],
        attributes.get("halcyon.outcome"),
    )
```

A start line and an end line share a `span_id`:

```json
{"trace_id": "wf_1a2b3c4d5e6f7a8b", "span_id": "a1.0", "parent_id": "a1",
 "name": "fetch", "start_time": "2026-09-17T12:00:00+00:00",
 "attributes": {"openinference.span.kind": "CHAIN", "halcyon.attempt": 1,
                "halcyon.step.key": "demo/fetch#0:97fcdad9"}}
{"span_id": "a1.0", "end_time": "2026-09-17T12:00:00.151+00:00",
 "status_code": "OK",
 "attributes": {"halcyon.outcome": "ok", "halcyon.duration_ms": 151}}
```

The trace is the run and the parent is the attempt, so `a1` is the first
`.run()` and `a2` the resume after it.

### Record what a model call used

A step that calls a model wraps the call, and the tokens it reports become a
span of their own under the step:

```python
from vera.workflow.api import model_call, step

@step
def ask(prompt: str) -> str:
    with model_call("claude-opus-5", provider="anthropic") as call:
        answer = client.messages.create(...)
        call.usage(
            input_tokens=answer.usage.input_tokens,
            output_tokens=answer.usage.output_tokens,
            cost=0.0123,
        )
    return answer.content[0].text
```

`cost` is optional. Halcyon records the number it is given and adds nothing of
its own, so a run with no reported cost shows tokens and no money. The report
prints the total:

```text
cost   $0.0127
attempts
  1  2026-09-17T12:00:00+00:00  host pid 4120  ok
       ask  1ms  ok
         claude-opus-5  0ms  ok  1510 tokens  $0.0123
```

The counts ride in `attributes` under OpenInference names
(`llm.model_name`, `llm.token_count.prompt`, `llm.token_count.completion`,
`llm.token_count.total`, `llm.token_count.prompt_details.cache_read`, and
`llm.cost.total`), on a span whose kind is `LLM`.

Calling `model_call` outside a step runs the block and records nothing, so a
helper that uses it works whether or not a workflow called it. A second
`usage()` on the same call replaces the first.

## Find runs whose process died

A run left `running` by a process that never came back stays `running` until
someone looks. The sweep does the looking:

```sh
PYTHONPATH=python python3 -m vera.workflow sweep --journal-dir /tmp/wf-demo
```

It considers a run only when the last attempt is still open and its `pid` on
this host is gone. Those runs are marked `crashed` with a `reason`, and the open
attempt is left open as the evidence. Nothing is run again.

Passing `--resume` resumes every crashed run in the store, in this process, one
after the other, whether this sweep marked it or an earlier one did. A run
someone asked to cancel is reported and left alone.

The sweep reads pids on the machine that recorded them, so it skips runs whose
attempt names another host, and it skips a pid the operating system has since
handed to something else. Run it on the machine the workflows ran on.

### Journal files

```text
/tmp/wf-demo/<run-id>/
  header.json
  journal.ndjson
  spans.ndjson
  blobs/
```

The header stores run metadata and inputs, and while a step is running it also
names that step under `active`. `attempts` holds one entry per run or resume,
each with `started_at`, `pid`, and `host`, and gaining `finished_at`, `status`,
and, on a failure, `error` when that attempt ends. The journal has one record per successful step,
each with the time it finished (`at`) and how many milliseconds it took (`ms`). Values larger than 8192 bytes are stored in `blobs/` with a
hash reference. `spans.ndjson` has two lines per span, one opening it and one
settling it, folded together when read. SQLite stores the same facts in `runs`,
`records`, `spans`, and `blobs` tables in one database file.

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
