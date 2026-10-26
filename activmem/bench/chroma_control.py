"""How many of the nine hard questions plain Chroma answers without the graph."""

from __future__ import annotations

import os
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1] / "src"))

os.environ["ACTIVMEM_EMBED"] = "1"
os.environ["ACTIVMEM_GRAPH"] = "off"

from activmem.memory import ActivMem


def main() -> int:
    passed = []
    checks = [
        ("1 fish under noise", fish, lambda r: r.results and "halibut" in r.results[0].text.lower() and any("pollock" in h.text.lower() for h in r.suppressed)),
        ("2 seafood", seafood, lambda r: any("halibut" in h.text.lower() for h in r.results) and any("pollock" in h.text.lower() for h in r.suppressed)),
        ("3 cities", cities, lambda r: r.results and "Berlin" in r.results[0].text and any("Lisbon" in h.text for h in r.suppressed) and any("Toronto" in h.text for h in r.suppressed)),
        ("4 time", times, lambda r: r.results and "Corvine" in r.results[0].text and r.side and "Acme" in r.side.results[0].text),
        ("5 cod", cod, lambda r: "cod" in r.no_record_of and all("cod" not in h.text.lower() for h in r.results)),
        ("6 dog", dog, lambda r: r.results == []),
        ("7 decoy", decoy, lambda r: r.results and "halibut" in r.results[0].text.lower() and any(h.status == "inferred" and "tuna" in h.text.lower() for h in r.results)),
        ("8 maya", maya, lambda r: any("bakery" in h.text.lower() for h in r.results)),
        ("9 priya", priya, lambda r: any("Priya" in h.text for h in r.results)),
    ]
    for name, build, ok in checks:
        mem = ActivMem(tempfile.mkdtemp())
        try:
            result = build(mem)
            good = bool(ok(result))
        finally:
            mem.close()
        passed.append(good)
        print(f"{'PASS' if good else 'FAIL'} {name}", flush=True)
    print(f"plain chroma {sum(passed)} / {len(passed)}", flush=True)
    return 0


def fish(mem):
    pollock = mem.save("I really like pollock.", actor="nash", session="life")
    sike = mem.save("sike, I don't", actor="nash", session="life")
    mem.revise(sike, pollock)
    mem.save("Halibut is my favourite fish.", actor="nash", session="life")
    return mem.recall("What fish do I like?", carry=0)


def seafood(mem):
    fish(mem)
    return mem.recall("What seafood do I like?", carry=0)


def cities(mem):
    lisbon = mem.save("I moved to Lisbon", actor="nash")
    toronto = mem.save("I'm back in Toronto", actor="nash")
    mem.revise(toronto, lisbon)
    berlin = mem.save("Berlin now", actor="nash")
    mem.revise(berlin, toronto)
    return mem.recall("Where do I live?", carry=0)


def times(mem):
    mem.save("I worked at Acme", actor="nash", true_at=("2019-01-01", "2022-12-31"), learned_at="2024-01-15T00:00:00Z")
    mem.save("I work at Corvine", actor="nash", true_at=("2023-01-01", None), learned_at="2024-06-01T00:00:00Z")
    now = mem.recall("Where do I work?", true_on="2026-10-25", carry=0)
    then = mem.recall("Where did I work in 2020?", true_on="2020-06-01", carry=0)
    return type("Pair", (), {"results": now.results, "side": then})()


def cod(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    return mem.recall("Why do I love cod?", carry=0)


def dog(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    return mem.recall("What's my dog's name?", carry=0)


def decoy(mem):
    mem.save("Halibut is my favourite fish.", actor="nash")
    mem.save("Nash's favourite fish is tuna.", actor="random_web_page", status="inferred")
    return mem.recall("What fish do I like?", k=8, carry=0)


def maya(mem):
    mem.save("Maya's partner is Sam.", actor="nash")
    mem.save("Sam works at the bakery on Dundas.", actor="nash")
    return mem.recall("Where does Maya's partner work?", carry=0)


def priya(mem):
    mem.save("Kestrel is the new routing engine.", actor="nash", session="life")
    mem.save("Priya leads Kestrel.", actor="nash", session="life")
    mem.recall("How is the routing engine going?", carry=0)
    return mem.recall("Who should I ask?", carry=0)


if __name__ == "__main__":
    raise SystemExit(main())
