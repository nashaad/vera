from activmem.text import readable_id, term_tokens


def test_pollock_id_shape():
    item_id = readable_id("I really like pollock.")
    slug, suffix = item_id.rsplit("-", 1)
    assert slug == "like-pollock"
    assert len(suffix) == 4


def test_question_terms():
    assert term_tokens("What fish do I like?") == ["fish", "like"]
    assert term_tokens("I really like pollock.") == ["like", "pollock"]
    assert term_tokens("Halibut is my favourite fish.") == ["halibut", "favourite", "fish"]
    assert term_tokens("psych, I don't") == ["psych"]
    assert term_tokens("Why do I love cod?") == ["love", "cod"]
    assert term_tokens("Who should I ask?") == ["ask"]
    assert term_tokens("How is the routing engine going?") == ["routing", "engine", "going"]
    assert term_tokens("Nash's favourite fish is tuna.") == ["nash", "favourite", "fish", "tuna"]


def test_worked_aliases_to_work_and_id_keeps_the_surface_word():
    assert term_tokens("I worked at Acme") == ["work", "acme"]
    assert term_tokens("I work at Corvine") == ["work", "corvine"]
    assert term_tokens("Where do I work?") == ["work"]
    assert readable_id("I worked at Acme").startswith("worked-acme-")
