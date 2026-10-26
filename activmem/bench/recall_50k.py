"""Build a real 50,000-chunk Chroma index and time recall. No answering model."""

from __future__ import annotations

import os
import statistics
import sys
import tempfile
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

os.environ["ACTIVMEM_EMBED"] = "0"
os.environ["ACTIVMEM_GRAPH"] = "on"

from activmem.memory import ActivMem, _embed_text
from activmem.recall import format_context
from activmem.vectors import VectorStore
from corpus import filler


def main() -> int:
    root = Path(tempfile.mkdtemp(prefix="activmem50k-"))
    print(f"root {root}", flush=True)
    mem = ActivMem(root)
    pollock = sike = None
    started = time.perf_counter()
    for i in range(50_000):
        if i == 1_000:
            pollock = mem.save("I really like pollock.", actor="nash", session="life")
        elif i == 25_000:
            sike = mem.save("sike, I don't", actor="nash", session="life")
            mem.revise(sike, pollock)
        elif i == 40_000:
            mem.save("Halibut is my favourite fish.", actor="nash", session="life")
        else:
            mem.save(filler(i), actor="nash", session="life")
        if i and i % 10_000 == 0:
            print(f"saved {i}", flush=True)
    print(f"graph {time.perf_counter() - started:.1f}s chunks {mem.stats()['chunks']}", flush=True)

    store = VectorStore(root / ".activmem" / "chroma")
    rows = []
    for node, data in mem.index.graph.nodes(data=True):
        if data.get("kind") != "chunk":
            continue
        rows.append((
            node,
            data.get("text") or "",
            _embed_text(mem.index.graph, node),
            {
                "actor": data.get("actor") or "",
                "session": data.get("session") or "",
                "content_hash": data.get("content_hash") or "",
                "status": data.get("status") or "",
            },
        ))
    embed_started = time.perf_counter()
    store.add_many(rows, batch=128)
    print(f"embedded {len(rows)} in {time.perf_counter() - embed_started:.1f}s calls {store.embed_calls}", flush=True)
    mem.vectors = store

    mem.recall("What seafood do I like?", seeds="both", carry=0)
    samples = []
    for _ in range(20):
        result = mem.recall("What seafood do I like?", seeds="both", carry=0)
        samples.append(result.ms)
    result = mem.recall("What seafood do I like?", seeds="both", carry=0, explain=True)
    graph_chars = len(format_context(result))
    mem.graph_on = False
    plain = mem.recall("What seafood do I like?", seeds="vectors", carry=0)
    plain_chars = len(format_context(plain))
    print(
        "median_ms", round(statistics.median(samples), 1),
        "min", round(min(samples), 1),
        "max", round(max(samples), 1),
        "vector_ms", round(result.vector_ms, 1),
        "nodes", result.nodes_touched,
        flush=True,
    )
    top = result.results[0].text if result.results else ""
    print("top", top, flush=True)
    if "halibut" not in top.lower():
        print("FAIL seafood top is not halibut", flush=True)
        return 1
    if any("sike" in hit.text.lower() for hit in result.results):
        print("FAIL sike ranked as a result", flush=True)
        return 1
    print("suppressed", [hit.text for hit in result.suppressed], flush=True)
    print("context_chars", graph_chars, "plain_chars", plain_chars, flush=True)
    mem.close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
