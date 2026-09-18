# Example workflows

Python workflows built on `vera.workflow`. Run them from the repository root
with `PYTHONPATH=python`. [Python workflows](../../docs/python-workflows.md)
covers the API.

- `writer.workflow.py` researches a topic, outlines it, waits for your notes,
  and writes a draft with `openai/gpt-5.6-luna` through OpenRouter.
- `review.workflow.py` summarises each file in a directory with an agent and
  merges the summaries into a report.
- `counter.workflow.py` shows a step that runs again when the process dies
  before its result is recorded.

## Stop the writer and resume it

Start a run. It stops after the outline and waits for notes.

```sh
export OPENROUTER_API_KEY=...
PYTHONPATH=python python3 examples/workflows/writer.workflow.py "why cats knock things off tables"
```

```text
wf_a6e35df6a28f4537 is waiting for your notes on the outline.
answer with: python3 -m vera.workflow answer wf_a6e35df6a28f4537
```

Answer it. The run carries on into the draft. Stop it with Ctrl-C, or kill
the process, while the draft is being written.

```sh
PYTHONPATH=python python3 -m vera.workflow answer wf_a6e35df6a28f4537 "make it funny"
```

`show` lists what finished and what did not:

```text
status running
steps
  writer/research#0:0d48c3e4  2938ms
  writer/outline#0:0734d74b  5792ms
active draft  since 2026-09-18T03:51:58.071036+00:00
cost   $0.0010
```

Resume it from any shell:

```sh
PYTHONPATH=python python3 -m vera.workflow resume wf_a6e35df6a28f4537
PYTHONPATH=python python3 -m vera.workflow show wf_a6e35df6a28f4537
```

```text
status ok
cost   $0.0020
attempts
  1  ...  suspended
       research  2938ms  ok
         openai/gpt-5.6-luna  2936ms  ok  253 tokens  $0.0003
       outline  5791ms  ok
         openai/gpt-5.6-luna  5790ms  ok  828 tokens  $0.0008
  2  ...  did not finish
       draft  did not finish
         openai/gpt-5.6-luna  did not finish
  3  ...  ok
       draft  6967ms  ok
         openai/gpt-5.6-luna  6966ms  ok  1247 tokens  $0.0009
```

The resume sent one request, for the draft. Research and outline returned
their recorded replies, and the answer "make it funny" was read from the run.
The call that was cut off has no usage recorded, so any charge OpenRouter made
for it is not in the total.

The same run appears on `/runs` in the annex, and its calls count toward the
totals on `/usage`.

`--offline` replaces the model with canned replies and needs no key.
