# ActivMem

A throwaway memory engine. Prose is stored as an append-only event log. Recall pokes words in a small graph and spreads activation, so a later correction can suppress an earlier belief. This pass is the Python baseline: the standard library plus [networkx](https://networkx.org/). No vectors, database, or model.

## Install

Requires Python 3.12 and [uv](https://docs.astral.sh/uv/).

```sh
cd activmem
uv sync --extra dev
```

The `activmem` command is installed in the project's virtualenv. Data is written to `.activmem/` inside `--dir` (default: the current directory).

## Quickstart

```sh
uv run activmem save "Halibut is my favourite fish." --actor nash
uv run activmem recall "What fish do I like?"
uv run activmem stats
```

Every save names an actor. `ingest chat` maps `user` lines to `nash` and `assistant` lines to `assistant`. `ingest text` defaults the actor to `nash`.

```sh
uv run activmem ingest chat history.jsonl
uv run activmem ingest text notes.txt --actor nash
uv run activmem recall "What fish do I like?" --explain
uv run activmem show like-pollock-3f9a
uv run activmem forget like-pollock-3f9a --actor nash
uv run activmem rebuild
uv run activmem verify
```

Chat JSONL is one object per line: `{"role", "text", "ts"?, "session"?}`. Text files split on blank lines, one session per file. Importing the same file again does not duplicate.

Add `.activmem/config.toml` to retune the engine. Omitted recall arguments use this file, whose defaults are 4 steps, retain 0.8, and carry 0.5.

```toml
steps = 4
retain = 0.8
carry = 0.5
threshold = 0.01

[weights]
mentions = 1.0
mentioned_by = 0.5
next = 0.3
previous = 0.3
revises = -1.5
revised_by = 1.0
```

`--json` prints the same records as JSON. `--explain` prints the seeds, the largest change at each step, every inhibition, and the final ranking.

## Halibut

Early on, Nash says he likes pollock. Much later he says "psych, I don't", and the caller, who understood that at the time, records that the new line revises the pollock line. Later still he says halibut is his favourite fish. "What fish do I like?" should return the halibut line first. Pollock is not a current result. It is listed as suppressed, with the psych line attached, because the revision was stored when it was said.

```sh
uv run activmem save "I really like pollock." --actor nash --session life
# note the printed id, called POLLOCK below
uv run activmem save "psych, I don't" --actor nash --session life
# note that id, called PSYCH below
uv run activmem annotate PSYCH revises POLLOCK --actor nash
uv run activmem save "Halibut is my favourite fish." --actor nash --session life
uv run activmem recall "What fish do I like?" --explain
```

Without the `revises` annotation, pollock comes back as a current like. The engine does not guess that "psych, I don't" cancels the earlier sentence. Exact words only: a question about seafood does not find fish. That needs the vector phase, which is not in this pass.

## Tests

```sh
uv run pytest -m "not slow"
uv run pytest -m slow
```

The slow test is the same halibut case at 50,000 turns. It prints the recall time.
