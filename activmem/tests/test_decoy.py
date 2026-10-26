from corpus import seed_halibut


def test_inferred_decoy_loses_to_halibut(tmp_path):
    mem = seed_halibut(tmp_path, 40, annotate=True)
    mem.save(
        "Nash's favourite fish is tuna.",
        actor="random_web_page",
        status="inferred",
        session="web",
    )
    result = mem.recall("What fish do I like?", k=12)
    texts = [(hit.activation, hit.text, hit.status, hit.actor) for hit in result.results]
    assert result.results, texts
    assert "halibut" in result.results[0].text.lower(), texts
    tuna = next((hit for hit in result.results if "tuna" in hit.text.lower()), None)
    assert tuna is not None, texts
    assert tuna.status == "inferred"
    assert tuna.actor == "random_web_page"
    assert result.results[0].activation > tuna.activation
    mem.close()
