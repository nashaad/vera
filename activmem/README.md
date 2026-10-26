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

Early on, Nash says he likes pollock. Much later he says "sike, I don't", and Vera, which understood that at the time, calls `memory_revises`. Later still he says halibut is his favourite fish. "What fish do I like?" returns the halibut line first. Pollock is suppressed, with the sike line attached.

```sh
uv run activmem save "I really like pollock." --actor nash --session life
# note the printed id, called POLLOCK below
uv run activmem save "sike, I don't" --actor nash --session life
# note that id, called PSYCH below
uv run activmem annotate PSYCH revises POLLOCK --actor nash
uv run activmem save "Halibut is my favourite fish." --actor nash --session life
uv run activmem recall "What fish do I like?" --explain
```

Without the `revises` annotation, pollock comes back as a current like. The engine does not guess that "sike, I don't" cancels the earlier sentence. Exact words do not turn "seafood" into "fish". Chroma's local embedder does that, and the graph still decides which of those hits is current.

## With Vera

Vera's extension host is TypeScript, so it cannot import this package. Run `uv run activmem serve --dir <workspace>` and enable `extensions/activmem`. Before each turn the extension injects `context_for`. After the turn it calls `save_turn`. The `memory_revises` tool is how Vera records a correction. If the socket is missing or slower than 300 ms, the turn continues without memory.

## Tests

```sh
uv run pytest -m "not slow"
uv run pytest -m slow
```

The slow test is the same halibut case at 50,000 turns. It prints the recall time.
