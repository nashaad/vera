from activmem.memory import ActivMem
from activmem.ingest import ingest_chat, ingest_text


def test_ingest_chat_and_text_are_idempotent(tmp_path):
    root = tmp_path / "mem"
    chat = tmp_path / "history.jsonl"
    chat.write_text(
        "\n".join(
            [
                '{"role":"user","text":"I keep a spare key under the jar.","ts":"2024-05-01T00:00:00Z","session":"s1"}',
                '{"role":"assistant","text":"I will remember the jar."}',
                "",
            ]
        ),
        encoding="utf-8",
    )
    notes = tmp_path / "notes.txt"
    notes.write_text("Alpha paragraph about quartz.\n\nBeta paragraph about linen.\n", encoding="utf-8")

    mem = ActivMem(root)
    first = ingest_chat(mem, chat)
    second = ingest_chat(mem, chat)
    assert first.added == 2
    assert second.added == 0
    assert second.skipped == 2
    prose = ingest_text(mem, notes)
    again = ingest_text(mem, notes)
    assert prose.added == 2
    assert again.added == 0
    assert again.skipped == 2

    stats = mem.stats()
    assert stats["events"] == 4
    assert stats["chunks"] == 4
    kinds = {data["kind"] for _s, _d, _k, data in mem.index.graph.edges(keys=True, data=True)}
    assert "next" in kinds
    assert "previous" in kinds
    actors = {
        data["actor"]
        for _node, data in mem.index.graph.nodes(data=True)
        if data.get("kind") == "chunk"
    }
    assert actors == {"nash", "assistant"}
    mem.close()

    reopened = ActivMem(root)
    assert reopened.stats()["events"] == stats["events"]
    assert reopened.stats()["chunks"] == stats["chunks"]
    assert reopened.stats()["edges"] == stats["edges"]
    reopened.close()
