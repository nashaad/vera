from activmem.memory import ActivMem
from corpus import filler


def test_cod_is_no_record(tmp_path):
    mem = ActivMem(tmp_path)
    for i in range(30):
        mem.save(filler(i), actor="nash", session="s")
    mem.save("Halibut is my favourite fish.", actor="nash", session="s")
    result = mem.recall("Why do I love cod?")
    assert "cod" in result.no_record_of
    assert "love" not in result.no_record_of
    assert all("cod" not in hit.text.lower() for hit in result.results)
    assert all("cod" not in hit.text.lower() for hit in result.suppressed)
    mem.close()
