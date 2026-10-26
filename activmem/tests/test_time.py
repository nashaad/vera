from activmem.memory import ActivMem


def test_true_on_and_as_of(tmp_path):
    mem = ActivMem(tmp_path)
    mem.save(
        "I worked at Acme",
        actor="nash",
        true_at=("2019-01-01", "2022-12-31"),
        learned_at="2024-01-15T00:00:00Z",
        session="jobs",
    )
    mem.save(
        "I work at Corvine",
        actor="nash",
        true_at=("2023-01-01", None),
        learned_at="2024-06-01T00:00:00Z",
        session="jobs",
    )

    now = mem.recall("Where do I work?", true_on="2026-10-25")
    assert now.results, now
    assert "Corvine" in now.results[0].text
    assert all("Acme" not in hit.text for hit in now.results)
    assert now.results[0].true_at == {"from": "2023-01-01", "to": None}

    back_then = mem.recall("Where do I work?", true_on="2020-06-01")
    assert back_then.results
    assert "Acme" in back_then.results[0].text
    assert all("Corvine" not in hit.text for hit in back_then.results)
    assert back_then.results[0].true_at["from"] == "2019-01-01"
    assert back_then.results[0].true_at["to"] == "2022-12-31"

    before_corvine = mem.recall("Where do I work?", as_of="2024-03-01", true_on="2020-06-01")
    assert before_corvine.results
    assert "Acme" in before_corvine.results[0].text
    assert all("Corvine" not in hit.text for hit in before_corvine.results)

    not_yet = mem.recall("Where do I work?", as_of="2024-03-01", true_on="2026-10-25")
    assert all("Corvine" not in hit.text for hit in not_yet.results)
    assert all("Acme" not in hit.text for hit in not_yet.results)
    mem.close()
