import pytest

from activmem.recall import format_context
from corpus import seed_halibut


def _dump(result) -> str:
    results = [(round(hit.activation, 3), hit.text) for hit in result.results]
    suppressed = [(round(hit.activation, 3), hit.text, hit.revising_text) for hit in result.suppressed]
    return f"results={results} suppressed={suppressed} missing={result.no_record_of}"


def assert_halibut(mem):
    result = mem.recall("What fish do I like?", explain=True)
    assert result.results, _dump(result)
    assert "halibut" in result.results[0].text.lower(), _dump(result)
    assert all("sike" not in hit.text.lower() for hit in result.results), _dump(result)
    assert all("pollock" not in hit.text.lower() for hit in result.results), _dump(result)
    assert any("pollock" in hit.text.lower() for hit in result.suppressed), _dump(result)
    assert any("sike" in hit.revising_text.lower() for hit in result.suppressed), _dump(result)
    assert result.explain is not None
    assert result.ms >= 0
    assert result.nodes_touched > 0
    block = format_context(result)
    assert block.startswith('Items under "Taken back" are no longer true')
    assert "Current: Halibut is my favourite fish." in block
    assert "Taken back: I really like pollock." in block
    assert "sike, I don't" in block
    return result


def test_halibut_two_thousand(tmp_path):
    mem = seed_halibut(tmp_path, 2000, annotate=True)
    result = assert_halibut(mem)
    assert result.nodes_touched < 2000
    mem.close()


def test_new_fact_that_revises_the_old_one_stays_current(tmp_path):
    from activmem.memory import ActivMem

    mem = ActivMem(tmp_path)
    lisbon = mem.save("I live in Lisbon", actor="nash")
    toronto = mem.save("I live in Toronto", actor="nash")
    mem.revise(toronto, lisbon)
    berlin = mem.save("I live in Berlin", actor="nash")
    mem.revise(berlin, toronto)
    result = mem.recall("Where do I live?")
    assert result.results, _dump(result)
    assert result.results[0].text == "I live in Berlin", _dump(result)
    assert any("Lisbon" in hit.text for hit in result.suppressed), _dump(result)
    assert any("Toronto" in hit.text for hit in result.suppressed), _dump(result)
    mem.close()


def test_without_annotation_pollock_stays_current(tmp_path):
    mem = seed_halibut(tmp_path, 40, annotate=False)
    result = mem.recall("What fish do I like?")
    assert any("pollock" in hit.text.lower() for hit in result.results), _dump(result)
    assert result.suppressed == []
    mem.close()


def test_revision_is_invisible_before_it_was_learned(tmp_path):
    from activmem.memory import ActivMem

    mem = ActivMem(tmp_path)
    pollock = mem.save("I really like pollock.", actor="nash", learned_at="2024-01-01T00:00:00Z")
    correction = mem.save("sike, I don't", actor="nash", learned_at="2024-06-01T00:00:00Z")
    mem.annotate(correction, "revises", pollock, actor="nash", learned_at="2024-06-01T00:00:00Z")
    before = mem.recall("What do I like?", as_of="2024-03-01")
    assert any("pollock" in hit.text.lower() for hit in before.results), _dump(before)
    assert before.suppressed == []
    after = mem.recall("What do I like?")
    assert all("pollock" not in hit.text.lower() for hit in after.results), _dump(after)
    assert any("pollock" in hit.text.lower() for hit in after.suppressed), _dump(after)
    mem.close()


def test_saying_a_new_fact_does_not_report_it_missing(tmp_path):
    from activmem.memory import ActivMem

    mem = ActivMem(tmp_path)
    result = mem.recall("Halibut is my favourite fish.")
    assert "halibut" not in result.no_record_of
    mem.close()


def test_saying_it_again_after_taking_it_back_is_current(tmp_path):
    from activmem.memory import ActivMem

    mem = ActivMem(tmp_path)
    first = mem.save("I really like pollock.", actor="nash")
    correction = mem.save("sike, I don't", actor="nash")
    mem.revise(correction, first)
    second = mem.save("I really like pollock.", actor="nash")
    assert second != first
    result = mem.recall("What do I like?")
    assert any(hit.item_id == second for hit in result.results), _dump(result)
    assert all(hit.item_id != first for hit in result.results), _dump(result)
    assert any(hit.item_id == first for hit in result.suppressed), _dump(result)
    mem.close()


class _LateVectors:
    def __init__(self, hits):
        self.hits = hits
        self.embed_calls = 0

    def query(self, text, k):
        return self.hits[:k]

    def known(self):
        return set()

    def has(self, item_id):
        return False

    def add(self, *args, **kwargs):
        return None

    def add_many(self, *args, **kwargs):
        return None

    def delete(self, item_id):
        return None


def test_late_vector_hit_on_a_revised_line_is_still_taken_back(tmp_path):
    """Run 4 called memory_revises, then the seafood injection said taken back: none.

    Filler crowded the top vector hits, so the old line was never reached.
    """
    from activmem.memory import ActivMem
    from corpus import filler

    mem = ActivMem(tmp_path)
    pollock = mem.save("I really like pollock.", actor="nash", session="life")
    correction = mem.save("sike, I don't", actor="nash", session="life")
    mem.revise(correction, pollock)
    halibut = mem.save("Halibut is my favourite fish.", actor="nash", session="now")
    fillers = [mem.save(filler(i), actor="nash", session=f"f{i}") for i in range(10)]
    ranked = [(halibut, 0.61)]
    ranked.extend((item, 0.45 - index * 0.01) for index, item in enumerate(fillers))
    ranked.append((pollock, 0.22))
    mem.vectors = _LateVectors(ranked)
    mem.config.vector_k = 8
    mem.config.vector_scan = 32
    result = mem.recall("What seafood should I order tonight?", k=12, seeds="vectors", carry=0)
    assert any("halibut" in hit.text.lower() for hit in result.results), _dump(result)
    assert any("pollock" in hit.text.lower() for hit in result.suppressed), _dump(result)
    assert "sike" in result.suppressed[0].revising_text or any(
        "sike" in hit.revising_text for hit in result.suppressed
    )
    assert "seafood" not in result.no_record_of
    assert "order" not in result.no_record_of
    assert "tonight" not in result.no_record_of
    mem.close()


@pytest.mark.slow
def test_halibut_fifty_thousand(tmp_path):
    mem = seed_halibut(tmp_path, 50_000, annotate=True)
    result = assert_halibut(mem)
    print(
        f"50k recall {result.ms:.1f} ms, nodes {result.nodes_touched}, "
        f"chunks {mem.stats()['chunks']}, events {mem.stats()['events']}",
        flush=True,
    )
    mem.close()
