import pytest

from activmem.events import BrokenChainError, EventLog, scan
from activmem.memory import ActivMem


def _body(text: str) -> dict:
    return {
        "type": "save",
        "actor": "nash",
        "text": text,
        "session": None,
        "true_at": None,
        "status": "confirmed",
        "learned_at": "2024-01-01T00:00:00Z",
        "item_id": "item",
        "content_hash": text,
    }


def test_chain_verifies_and_tamper_names_the_line(tmp_path):
    path = tmp_path / "events.jsonl"
    log = EventLog(path)
    log.append(_body("Hello chain."))
    log.append(_body("Second line stays."))
    log.close()

    events, info = scan(path)
    assert info is None
    assert len(events) == 2
    assert events[1]["prev_hash"] == events[0]["id"]

    lines = path.read_text(encoding="utf-8").splitlines()
    lines[1] = lines[1].replace("Second", "Sec0nd", 1)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    events, info = scan(path)
    assert info is not None
    assert info.line == 2
    assert "hash mismatch" in info.message
    with pytest.raises(BrokenChainError) as raised:
        EventLog(path)
    assert raised.value.info.line == 2


def test_activmem_refuses_a_broken_log_unless_forced(tmp_path):
    mem = ActivMem(tmp_path)
    mem.save("Hello chain.", actor="nash")
    mem.save("Second line stays.", actor="nash")
    path = tmp_path / ".activmem" / "events.jsonl"
    mem.close()
    lines = path.read_text(encoding="utf-8").splitlines()
    lines[1] = lines[1].replace("Second", "Sec0nd", 1)
    path.write_text("\n".join(lines) + "\n", encoding="utf-8")

    with pytest.raises(BrokenChainError) as raised:
        ActivMem(tmp_path)
    assert raised.value.info.line == 2

    repaired = ActivMem(tmp_path, force=True)
    assert repaired.log.repaired_from is not None
    assert repaired.stats()["chunks"] == 1
    repaired.save("A repair save.", actor="nash")
    repaired.close()
    reopened = ActivMem(tmp_path)
    assert reopened.verify() is None
    assert reopened.stats()["chunks"] == 2
    reopened.close()
