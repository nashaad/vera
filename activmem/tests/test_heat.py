from activmem.memory import ActivMem
from corpus import filler


def _seed(root) -> ActivMem:
    mem = ActivMem(root)
    for i in range(40):
        if i == 12:
            mem.save("Kestrel is the new routing engine.", actor="nash", session="life")
        elif i == 18:
            mem.save("Priya leads Kestrel.", actor="nash", session="life")
        else:
            mem.save(filler(i), actor="nash", session="life")
    return mem


def _has_priya(result) -> bool:
    return any("priya" in hit.text.lower() for hit in result.results)


def test_leftover_heat_finds_priya_on_the_next_turn(tmp_path):
    mem = _seed(tmp_path)
    first = mem.recall("How is the routing engine going?")
    second = mem.recall("Who should I ask?")
    assert _has_priya(second), (
        [(hit.activation, hit.text) for hit in first.results],
        [(hit.activation, hit.text) for hit in second.results],
    )
    mem.close()


def test_carry_zero_does_not_find_priya(tmp_path):
    mem = _seed(tmp_path)
    mem.recall("How is the routing engine going?", carry=0)
    second = mem.recall("Who should I ask?", carry=0)
    assert not _has_priya(second), [(hit.activation, hit.text) for hit in second.results]
    mem.close()
