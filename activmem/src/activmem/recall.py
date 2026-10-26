"""Seed, spread, settle, and explain a recall."""

from __future__ import annotations

import time
from dataclasses import asdict, dataclass

import networkx as nx

from activmem.config import Config
from activmem.engine import LoopEngine, SettleParams, StepTrace
from activmem.events import covers, learned_ok
from activmem.graph import GraphIndex
from activmem.text import term_tokens


@dataclass(slots=True)
class RecallHit:
    item_id: str
    text: str
    activation: float
    actor: str | None
    status: str | None
    learned_at: str | None
    true_at: dict | None
    session: str | None
    flag: str = "current"


@dataclass(slots=True)
class SuppressedHit:
    item_id: str
    text: str
    activation: float
    actor: str | None
    status: str | None
    learned_at: str | None
    true_at: dict | None
    session: str | None
    revised_by: str
    revising_text: str
    flag: str = "revised"


@dataclass(slots=True)
class Explain:
    seeds: list[tuple[str, float]]
    steps: list[StepTrace]


@dataclass(slots=True)
class RecallResult:
    results: list[RecallHit]
    suppressed: list[SuppressedHit]
    no_record_of: list[str]
    ms: float
    nodes_touched: int
    explain: Explain | None = None
    vector_ms: float = 0.0

    def to_dict(self) -> dict:
        return asdict(self)


def run_recall(
    index: GraphIndex,
    engine: LoopEngine,
    config: Config,
    question: str,
    *,
    k: int,
    steps: int,
    retain: float,
    carry: float,
    as_of: str | None,
    true_on: str | None,
    explain: bool,
    seeds_mode: str = "both",
    vector_hits: list[tuple[str, float]] | None = None,
    vector_ms: float = 0.0,
    graph_on: bool = True,
) -> RecallResult:
    started = time.perf_counter()
    graph = index.graph
    if not graph_on:
        return _vectors_only(graph, question, vector_hits or [], k, started, vector_ms)
    term_seeds, missing = _seeds(question, graph, as_of, 1.0)
    seeds = _fuse(term_seeds, vector_hits or [], seeds_mode, config)
    saved: dict[str, float] | None = None
    if as_of is not None:
        saved = dict(engine.activation)
        engine.activation = {}
    else:
        engine.decay_between_turns(carry)
    engine.poke(seeds)
    activation = engine.settle(
        SettleParams(
            steps=steps,
            retain=retain,
            threshold=config.threshold,
            inferred_factor=config.inferred_factor,
            clamp_min=config.clamp_min,
            clamp_max=config.clamp_max,
            squash_gain=config.squash_gain,
            min_activation=config.min_activation,
            explain_top=config.explain_top,
            as_of=as_of,
        )
    )
    touched = set(seeds) | set(engine.touched)
    trace = list(engine.trace)
    if saved is not None:
        engine.activation = saved
    results, suppressed = _shape(
        graph,
        activation,
        touched,
        as_of,
        true_on,
        k,
        set(term_tokens(question)),
    )
    elapsed_ms = (time.perf_counter() - started) * 1000 + vector_ms
    explained = Explain(seeds=sorted(seeds.items()), steps=trace) if explain else None
    return RecallResult(
        results=results,
        suppressed=suppressed,
        no_record_of=missing,
        ms=elapsed_ms,
        nodes_touched=len(touched),
        explain=explained,
        vector_ms=vector_ms,
    )


def _fuse(
    term_seeds: dict[str, float],
    vector_hits: list[tuple[str, float]],
    mode: str,
    config: Config,
) -> dict[str, float]:
    """Reciprocal rank fusion of word terms and Chroma hits, scaled to seed_activation."""
    lists: list[list[str]] = []
    if mode in ("words", "both"):
        lists.append(list(term_seeds))
    if mode in ("vectors", "both"):
        lists.append([item_id for item_id, _score in vector_hits])
    fused: dict[str, float] = {}
    for ranked in lists:
        for rank, item_id in enumerate(ranked, start=1):
            fused[item_id] = fused.get(item_id, 0.0) + 1.0 / (config.rrf_k + rank)
    if not fused:
        return {}
    top = max(fused.values())
    scale = config.seed_activation / top
    return {item_id: score * scale for item_id, score in fused.items()}


def _vectors_only(graph, question, hits, k, started, vector_ms) -> RecallResult:
    results = []
    for item_id, score in hits:
        if item_id not in graph or graph.nodes[item_id].get("kind") != "chunk":
            continue
        data = graph.nodes[item_id]
        results.append(
            RecallHit(
                item_id=item_id,
                text=data.get("text") or "",
                activation=score,
                actor=data.get("actor"),
                status=data.get("status"),
                learned_at=data.get("learned_at"),
                true_at=data.get("true_at"),
                session=data.get("session"),
                flag="inferred" if data.get("status") == "inferred" else "current",
            )
        )
    results.sort(key=lambda hit: hit.activation, reverse=True)
    missing = [term for term in term_tokens(question) if f"t:{term}" not in graph]
    return RecallResult(
        results=results[:k],
        suppressed=[],
        no_record_of=missing,
        ms=(time.perf_counter() - started) * 1000 + vector_ms,
        nodes_touched=len(hits),
        vector_ms=vector_ms,
    )


def _seeds(
    question: str,
    graph: nx.MultiDiGraph,
    as_of: str | None,
    amount: float,
) -> tuple[dict[str, float], list[str]]:
    seeds: dict[str, float] = {}
    missing: list[str] = []
    for term in term_tokens(question):
        node = f"t:{term}"
        if node in graph and learned_ok(graph.nodes[node].get("learned_at"), as_of):
            seeds[node] = amount
        else:
            missing.append(term)
    return seeds, missing


def _shape(
    graph: nx.MultiDiGraph,
    activation: dict[str, float],
    touched: set[str],
    as_of: str | None,
    true_on: str | None,
    k: int,
    question_terms: set[str],
) -> tuple[list[RecallHit], list[SuppressedHit]]:
    results: list[RecallHit] = []
    suppressed: list[SuppressedHit] = []
    # Positive chunks are results even when leftover heat is below the firing
    # threshold. Revised chunks are suppressed when this turn reached them
    # or they still hold activation.
    for node in set(activation) | set(touched):
        if node not in graph:
            continue
        value = activation.get(node, 0.0)
        data = graph.nodes[node]
        if data.get("kind") != "chunk":
            continue
        if not learned_ok(data.get("learned_at"), as_of):
            continue
        if not covers(data.get("true_at"), true_on):
            continue
        revision = _revision(graph, node, as_of)
        if revision is not None and (node in touched or value != 0):
            revised_by, revising_text = revision
            suppressed.append(
                SuppressedHit(
                    item_id=node,
                    text=data.get("text") or "",
                    activation=value,
                    actor=data.get("actor"),
                    status=data.get("status"),
                    learned_at=data.get("learned_at"),
                    true_at=data.get("true_at"),
                    session=data.get("session"),
                    revised_by=revised_by,
                    revising_text=revising_text,
                    flag="revised",
                )
            )
            continue
        if value > 0:
            results.append(
                RecallHit(
                    item_id=node,
                    text=data.get("text") or "",
                    activation=value,
                    actor=data.get("actor"),
                    status=data.get("status"),
                    learned_at=data.get("learned_at"),
                    true_at=data.get("true_at"),
                    session=data.get("session"),
                    flag="inferred" if data.get("status") == "inferred" else "current",
                    )
            )
    # Activation is the rank. A tie (both clamped at the ceiling) prefers the
    # chunk that actually contains more of the question's terms.
    results.sort(
        key=lambda hit: (
            hit.activation,
            _overlap(hit.text, question_terms),
            hit.learned_at or "",
            hit.item_id,
        ),
        reverse=True,
    )
    suppressed.sort(key=lambda hit: (hit.activation, hit.learned_at or "", hit.item_id), reverse=True)
    return results[:k], suppressed


def _overlap(text: str, question_terms: set[str]) -> int:
    if not question_terms:
        return 0
    return sum(1 for term in term_tokens(text) if term in question_terms)


def _revision(graph: nx.MultiDiGraph, node: str, as_of: str | None) -> tuple[str, str] | None:
    best: tuple[str, str, str] | None = None
    for src, _dst, _key, data in graph.in_edges(node, keys=True, data=True):
        if data.get("kind") != "revises":
            continue
        if not learned_ok(data.get("learned_at"), as_of):
            continue
        if src not in graph or not learned_ok(graph.nodes[src].get("learned_at"), as_of):
            continue
        learned = str(data.get("learned_at") or "")
        text = graph.nodes[src].get("text") or ""
        if best is None or learned >= best[0]:
            best = (learned, src, text)
    if best is None:
        return None
    return best[1], best[2]


def format_true_at(value: dict | None) -> str:
    if not value:
        return "none"
    start = value.get("from")
    end = value.get("to")
    if start and end and start != end:
        return f"{start} .. {end}"
    if start and end == start:
        return str(start)
    if start and not end:
        return f"{start} .."
    if end and not start:
        return f".. {end}"
    return "none"


def format_recall(result: RecallResult) -> str:
    lines = [
        f"{len(result.results)} results in {result.ms:.1f} ms, {result.nodes_touched} nodes touched"
    ]
    if not result.results:
        lines.append("(no results)")
    for index, hit in enumerate(result.results, start=1):
        lines.append(f"{index}. {hit.item_id}  {hit.activation:.3f}  {hit.status}  {hit.actor}")
        lines.append(f"   {hit.text}")
        lines.append(f"   true_at: {format_true_at(hit.true_at)}")
    lines.append("suppressed:")
    if not result.suppressed:
        lines.append("  (none)")
    for hit in result.suppressed:
        lines.append(f"  {hit.item_id}  {hit.activation:.3f}  revised by {hit.revised_by}")
        lines.append(f"    {hit.text}")
        lines.append(f"    revising: {hit.revising_text}")
    if result.no_record_of:
        lines.append("no record of: " + ", ".join(result.no_record_of))
    else:
        lines.append("no record of: (none)")
    return "\n".join(lines)


def format_explain(result: RecallResult, graph: nx.MultiDiGraph) -> str:
    if result.explain is None:
        return format_recall(result)
    lines = ["seeds"]
    if result.explain.seeds:
        for node, value in result.explain.seeds:
            lines.append(f"  {_label(graph, node)}  {value:.3f}")
    else:
        lines.append("  (none)")
    lines.append("no record of")
    if result.no_record_of:
        for term in result.no_record_of:
            lines.append(f"  {term}")
    else:
        lines.append("  (none)")
    for step in result.explain.steps:
        lines.append(f"step {step.step}")
        if not step.changes:
            lines.append("  (no change)")
        for node, old, new, delta in step.changes:
            lines.append(f"  {_label(graph, node)}  {old:.3f} -> {new:.3f}  ({delta:+.3f})")
        lines.append("  inhibitions")
        if not step.inhibitions:
            lines.append("    (none)")
        for src, dst, delta in step.inhibitions:
            lines.append(f"    {_label(graph, src)}  {delta:+.3f}  ->  {_label(graph, dst)}")
    lines.append("final ranking")
    if not result.results:
        lines.append("  (none)")
    for index, hit in enumerate(result.results, start=1):
        lines.append(
            f"  {index}. {hit.item_id}  {hit.activation:.3f}  {hit.status}  {hit.actor}  {hit.text}"
        )
    lines.append("suppressed")
    if not result.suppressed:
        lines.append("  (none)")
    for hit in result.suppressed:
        lines.append(f"  {hit.item_id}  {hit.activation:.3f}  revised by {hit.revised_by}")
        lines.append(f"    {hit.text}")
        lines.append(f"    revising: {hit.revising_text}")
    lines.append(f"{result.ms:.1f} ms, {result.nodes_touched} nodes touched")
    return "\n".join(lines)


def format_context(result: RecallResult) -> str:
    """Excerpts injected into a Vera turn. Empty when there is nothing to say."""
    lines: list[str] = []
    for hit in result.results:
        lines.append(f"[{hit.flag}] {hit.item_id} ({hit.actor}): {hit.text}")
    for hit in result.suppressed:
        lines.append(f"[revised] {hit.item_id} ({hit.actor}): {hit.text}")
        lines.append(f"  taken back by {hit.revised_by}: {hit.revising_text}")
    if result.no_record_of:
        lines.append("no record of: " + ", ".join(result.no_record_of))
    if not lines:
        return ""
    lines.append(
        "If Nash retracts or replaces one of these, call memory_revises "
        "with the new wording and that item's id."
    )
    return "\n".join(lines)


def _label(graph: nx.MultiDiGraph, node: str) -> str:
    if node not in graph:
        return node
    data = graph.nodes[node]
    if data.get("kind") != "chunk":
        return node
    text = " ".join(str(data.get("text") or "").split())
    if len(text) > 72:
        text = text[:69] + "..."
    return f'{node}  "{text}"'
