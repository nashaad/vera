import pytest

from activmem.events import BadLinkKindError, MissingActorError, UnknownItemError
from activmem.graph import graph_signature
from activmem.memory import ActivMem


def test_reopen_rebuilds_the_same_graph(tmp_path):
    mem = ActivMem(tmp_path)
    first = mem.save("Kestrel is the new routing engine.", actor="nash", session="proj")
    second = mem.save("Priya leads Kestrel.", actor="nash", session="proj")
    third = mem.save("The deploy window moved.", actor="nash", session="proj")
    mem.annotate(second, "revises", first, actor="nash")
    signature = graph_signature(mem.index.graph)
    mem.close()

    again = ActivMem(tmp_path)
    assert graph_signature(again.index.graph) == signature
    stats = again.rebuild()
    assert stats["replayed"] == 4
    assert stats["chunks"] == 3
    assert graph_signature(again.index.graph) == signature
    shown = again.show(third)
    assert shown["text"] == "The deploy window moved."
    assert any(edge["kind"] == "previous" for edge in shown["out"])
    again.close()


def test_unknown_item_bad_kind_and_missing_actor(tmp_path):
    mem = ActivMem(tmp_path)
    item = mem.save("A single confirmed note.", actor="nash")
    with pytest.raises(UnknownItemError):
        mem.annotate(item, "revises", "missing-item", actor="nash")
    with pytest.raises(BadLinkKindError):
        mem.annotate(item, "causes", item, actor="nash")
    with pytest.raises(MissingActorError):
        mem.save("No actor here.", actor="  ")
    with pytest.raises(UnknownItemError):
        mem.show("missing-item")
    mem.close()
