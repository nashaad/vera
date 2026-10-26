"""Shared filler. Every turn uses fresh words so common terms do not fan out."""

from activmem.memory import ActivMem


def filler(i: int) -> str:
    return f"Filler{i} alpha{i} beta{i} gamma{i}."


def seed_halibut(root, n: int, *, annotate: bool) -> ActivMem:
    mem = ActivMem(root)
    pollock = None
    early = max(n // 10, 1)
    mid = n // 2
    late = (3 * n) // 4
    if len({early, mid, late}) < 3:
        raise RuntimeError(f"n={n} does not separate the three halibut turns")
    for i in range(n):
        if i == early:
            pollock = mem.save("I really like pollock.", actor="nash", session="life")
        elif i == mid:
            correction = mem.save("sike, I don't", actor="nash", session="life")
            if annotate and pollock is not None:
                mem.annotate(correction, "revises", pollock, actor="nash")
        elif i == late:
            mem.save("Halibut is my favourite fish.", actor="nash", session="life")
        else:
            mem.save(filler(i), actor="nash", session="life")
    return mem
