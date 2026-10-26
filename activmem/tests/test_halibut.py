import pytest

from corpus import seed_halibut


def _dump(result) -> str:
    results = [(round(hit.activation, 3), hit.text) for hit in result.results]
    suppressed = [(round(hit.activation, 3), hit.text, hit.revising_text) for hit in result.suppressed]
    return f"results={results} suppressed={suppressed} missing={result.no_record_of}"


def assert_halibut(mem):
    result = mem.recall("What fish do I like?", explain=True)
    assert result.results, _dump(result)
    assert "halibut" in result.results[0].text.lower(), _dump(result)
    assert all("pollock" not in hit.text.lower() for hit in result.results), _dump(result)
    assert any("pollock" in hit.text.lower() for hit in result.suppressed), _dump(result)
    assert any("psych" in hit.revising_text.lower() for hit in result.suppressed), _dump(result)
    assert result.explain is not None
    assert result.ms >= 0
    assert result.nodes_touched > 0
    return result


def test_halibut_two_thousand(tmp_path):
    mem = seed_halibut(tmp_path, 2000, annotate=True)
    result = assert_halibut(mem)
    assert result.nodes_touched < 2000
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
    psych = mem.save("psych, I don't", actor="nash", learned_at="2024-06-01T00:00:00Z")
    mem.annotate(psych, "revises", pollock, actor="nash", learned_at="2024-06-01T00:00:00Z")
    before = mem.recall("What do I like?", as_of="2024-03-01")
    assert any("pollock" in hit.text.lower() for hit in before.results), _dump(before)
    assert before.suppressed == []
    after = mem.recall("What do I like?")
    assert all("pollock" not in hit.text.lower() for hit in after.results), _dump(after)
    assert any("pollock" in hit.text.lower() for hit in after.suppressed), _dump(after)
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
