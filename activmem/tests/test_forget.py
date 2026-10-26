import pytest

from activmem.events import ForgottenError
from activmem.memory import ActivMem


def test_forget_drops_the_item_on_replay(tmp_path):
    mem = ActivMem(tmp_path)
    item = mem.save("The spare key is under the jar.", actor="nash")
    found = mem.recall("Where is the spare key?")
    assert any(hit.item_id == item for hit in found.results)
    mem.forget(item, actor="nash")
    assert mem.verify() is None
    types = [event["type"] for event in mem.log.events]
    assert types == ["forget"]
    assert all("jar" not in event.get("text", "") for event in mem.log.events)
    mem.close()

    again = ActivMem(tmp_path)
    assert item not in again.index.graph
    missed = again.recall("Where is the spare key?")
    assert all(hit.item_id != item for hit in missed.results)
    assert all("jar" not in hit.text.lower() for hit in missed.results)
    assert "jar" in missed.no_record_of or "spare" in missed.no_record_of
    with pytest.raises(ForgottenError):
        again.save("The spare key is under the jar.", actor="nash")
    again.close()
