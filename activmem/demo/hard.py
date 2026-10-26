"""Nine hard memories. Exit 0 when every one comes back right.

Word scenarios run with embeddings off. Paraphrase and the city chain need
Chroma's default embedder, so they run only when ACTIVMEM_RUN_VECTORS=1.
"""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "tests"))

from activmem.memory import ActivMem
from activmem.recall import format_explain


def main() -> int:
    failures = []
    checks = [
        ("1 revision under noise", revision_under_noise),
        ("4 time", time_question),
        ("5 false premise", false_premise),
        ("6 abstention", abstention),
        ("7 decoy", decoy),
        ("8 multi-hop", multi_hop),
        ("9 last turn", last_turn),
    ]
    if os.environ.get("ACTIVMEM_RUN_VECTORS") == "1":
        checks[1:1] = [
            ("2 paraphrase", paraphrase),
            ("3 chain of updates", city_chain),
        ]
    else:
        print("skipping paraphrase and city chain (set ACTIVMEM_RUN_VECTORS=1)")
    for name, check in checks:
        root = Path(tempfile.mkdtemp())
        os.environ["ACTIVMEM_EMBED"] = "1" if check in (paraphrase, city_chain) else "0"
        os.environ["ACTIVMEM_GRAPH"] = "on"
        mem = ActivMem(root)
        try:
            result = check(mem)
            print(f"\n## {name}")
            print(format_explain(result, mem.index.graph) if result.explain else _brief(result))
            if not check.ok(result):
                failures.append(name)
                print("FAIL")
            else:
                print("PASS")
        finally:
            mem.close()
    print(f"\n{len(checks) - len(failures)} / {len(checks)} passed")
    return 1 if failures else 0


def _brief(result) -> str:
    lines = ["current:"]
    lines += [f"  {hit.flag} {hit.text}" for hit in result.results] or ["  (none)"]
    lines.append("suppressed:")
    lines += [f"  {hit.text} <- {hit.revising_text}" for hit in result.suppressed] or ["  (none)"]
    lines.append("no record of: " + (", ".join(result.no_record_of) or "(none)"))
    return "\n".join(lines)


def revision_under_noise(mem):
    from corpus import filler
    pollock = None
    for i in range(400):
        if i == 20:
            pollock = mem.save("I really like pollock.", actor="nash", session="life")
        elif i == 200:
            correction = mem.save("sike, I don't", actor="nash", session="life")
            mem.revise(correction, pollock)
        elif i == 300:
            mem.save("Halibut is my favourite fish.", actor="nash", session="life")
        else:
            mem.save(filler(i), actor="nash", session="life")
    result = mem.recall("What fish do I like?", explain=True, seeds="words")
    revision_under_noise.ok = lambda result: (
        result.results and "halibut" in result.results[0].text.lower()
        and all("pollock" not in hit.text.lower() for hit in result.results)
        and any("sike" in hit.revising_text.lower() for hit in result.suppressed)
    )
    return result


def paraphrase(mem):
    pollock = mem.save("I really like pollock.", actor="nash", session="life")
    correction = mem.save("sike, I don't", actor="nash", session="life")
    mem.revise(correction, pollock)
    mem.save("Halibut is my favourite fish.", actor="nash", session="life")
    result = mem.recall("What seafood do I like?", explain=True, seeds="both")
    paraphrase.ok = lambda result: (
        any("halibut" in hit.text.lower() for hit in result.results)
        and all("pollock" not in hit.text.lower() for hit in result.results)
        and any("pollock" in hit.text.lower() for hit in result.suppressed)
    )
    return result


def city_chain(mem):
    lisbon = mem.save("I moved to Lisbon", actor="nash", session="life")
    toronto = mem.save("I'm back in Toronto", actor="nash", session="life")
    mem.revise(toronto, lisbon)
    berlin = mem.save("Berlin now", actor="nash", session="life")
    mem.revise(berlin, toronto)
    result = mem.recall("Where do I live?", explain=True, seeds="both")
    city_chain.ok = lambda result: (
        result.results and "Berlin" in result.results[0].text
        and any("Lisbon" in hit.text for hit in result.suppressed)
        and any("Toronto" in hit.text for hit in result.suppressed)
    )
    return result


def time_question(mem):
    mem.save("I worked at Acme", actor="nash", true_at=("2019-01-01", "2022-12-31"), learned_at="2024-01-15T00:00:00Z")
    mem.save("I work at Corvine", actor="nash", true_at=("2023-01-01", None), learned_at="2024-06-01T00:00:00Z")
    now = mem.recall("Where do I work?", true_on="2026-10-25", seeds="words", explain=True)
    then = mem.recall("Where did I work in 2020?", true_on="2020-06-01", seeds="words")
    time_question.then = then
    time_question.ok = lambda result: (
        result.results and "Corvine" in result.results[0].text
        and time_question.then.results and "Acme" in time_question.then.results[0].text
    )
    return now


def false_premise(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    result = mem.recall("Why do I love cod?", seeds="words", explain=True)
    false_premise.ok = lambda result: "cod" in result.no_record_of and all("cod" not in hit.text.lower() for hit in result.results)
    return result


def abstention(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    result = mem.recall("What's my dog's name?", seeds="words", explain=True)
    abstention.ok = lambda result: result.results == [] and "dog" in result.no_record_of
    return result


def decoy(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    mem.save("Nash's favourite fish is tuna.", actor="random_web_page", status="inferred")
    result = mem.recall("What fish do I like?", k=8, seeds="words", explain=True)
    decoy.ok = lambda result: (
        result.results and "halibut" in result.results[0].text.lower()
        and any(hit.status == "inferred" and "tuna" in hit.text.lower() for hit in result.results)
    )
    return result


def multi_hop(mem):
    mem.save("Maya's partner is Sam.", actor="nash", session="people")
    mem.save("Sam works at the bakery on Dundas.", actor="nash", session="people")
    result = mem.recall("Where does Maya's partner work?", k=5, seeds="words", explain=True)
    multi_hop.ok = lambda result: any("bakery" in hit.text.lower() for hit in result.results)
    return result


def last_turn(mem):
    from corpus import filler
    for i in range(15):
        mem.save(filler(i), actor="nash", session="life")
    mem.save("Kestrel is the new routing engine.", actor="nash", session="life")
    mem.save("Priya leads Kestrel.", actor="nash", session="life")
    mem.recall("How is the routing engine going?", seeds="words")
    result = mem.recall("Who should I ask?", seeds="words", explain=True)
    last_turn.ok = lambda result: any("Priya" in hit.text for hit in result.results)
    return result


if __name__ == "__main__":
    raise SystemExit(main())
