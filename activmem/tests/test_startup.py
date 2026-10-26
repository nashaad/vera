import os
import time

import pytest

from activmem.memory import ActivMem
from corpus import filler


def test_reopen_does_not_reembed(tmp_path, monkeypatch):
    monkeypatch.setenv("ACTIVMEM_EMBED", "fake")
    mem = ActivMem(tmp_path)
    for i in range(25):
        mem.save(filler(i), actor="nash", session="s")
    assert mem.vectors.embed_calls > 0
    mem.close()
    again = ActivMem(tmp_path)
    assert again.vectors.embed_calls == 0
    again.close()


@pytest.mark.slow
def test_reopen_fifty_thousand_cached(tmp_path, monkeypatch):
    monkeypatch.setenv("ACTIVMEM_EMBED", "fake")
    mem = ActivMem(tmp_path)
    for i in range(50_000):
        mem.save(filler(i), actor="nash", session="s")
    mem.close()
    started = time.perf_counter()
    again = ActivMem(tmp_path)
    elapsed = time.perf_counter() - started
    assert again.vectors.embed_calls == 0
    assert again.stats()["chunks"] == 50_000
    print(f"50k cached replay {elapsed:.2f}s, embeds {again.vectors.embed_calls}", flush=True)
    again.close()
