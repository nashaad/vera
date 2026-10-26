"""Public ActivMem handle. The event log is the record; the graph is a projection."""

from __future__ import annotations

from pathlib import Path

from activmem.config import load_config
from activmem.engine import LoopEngine
from activmem.events import (
    ActivMemError,
    ChainBreak,
    BadLinkKindError,
    ForgottenError,
    UnknownItemError,
    check_as_of,
    normalize_true_at,
    require_actor,
    scan,
    utc_now,
    EventLog,
)
from activmem.graph import GraphIndex
from activmem.recall import RecallResult, run_recall
from activmem.text import content_hash, mint_id


class ActivMem:
    def __init__(self, root: str | Path = ".", *, force: bool = False):
        self.root = Path(root)
        self.home = self.root / ".activmem"
        self.home.mkdir(parents=True, exist_ok=True)
        self.config = load_config(self.home / "config.toml")
        self.log = EventLog(self.home / "events.jsonl", force=force)
        self.engine = LoopEngine(self.config)
        self.index = GraphIndex(self.config)
        self._replay()

    def close(self) -> None:
        self.log.close()

    def __enter__(self) -> ActivMem:
        return self

    def __exit__(self, *args: object) -> None:
        self.close()

    def __del__(self) -> None:
        try:
            self.close()
        except Exception:
            pass

    def save(
        self,
        text: str,
        actor: str,
        session: str | None = None,
        true_at: object = None,
        status: str = "confirmed",
        learned_at: str | None = None,
    ) -> str:
        actor = require_actor(actor)
        if status not in ("confirmed", "inferred"):
            raise ActivMemError(f"bad status: {status}")
        if not isinstance(text, str) or not text.strip():
            raise ActivMemError("text is empty")
        text = text.strip()
        content = content_hash(actor, text)
        if content in self.index.forgotten_hashes:
            raise ForgottenError(text)
        existing = self.index.by_hash.get(content)
        if existing is not None:
            return existing
        item_id = mint_id(text, actor, self.index.graph, content)
        record = self.log.append(
            {
                "type": "save",
                "actor": actor,
                "text": text,
                "session": _session(session),
                "true_at": normalize_true_at(true_at),
                "status": status,
                "learned_at": _learned(learned_at),
                "item_id": item_id,
                "content_hash": content,
            }
        )
        self.index.apply(record)
        return item_id

    def annotate(
        self,
        from_id: str,
        kind: str,
        to_id: str,
        actor: str,
        learned_at: str | None = None,
    ) -> None:
        actor = require_actor(actor)
        if kind != "revises":
            raise BadLinkKindError(kind)
        graph = self.index.graph
        if from_id not in graph or graph.nodes[from_id].get("kind") != "chunk":
            raise UnknownItemError(from_id)
        if to_id not in graph or graph.nodes[to_id].get("kind") != "chunk":
            raise UnknownItemError(to_id)
        if graph.has_edge(from_id, to_id, key="revises"):
            return
        record = self.log.append(
            {
                "type": "link",
                "kind": kind,
                "from": from_id,
                "to": to_id,
                "actor": actor,
                "status": "confirmed",
                "learned_at": _learned(learned_at),
            }
        )
        self.index.apply(record)

    def forget(self, item_id: str, actor: str) -> None:
        actor = require_actor(actor)
        graph = self.index.graph
        if item_id not in graph or graph.nodes[item_id].get("kind") != "chunk":
            raise UnknownItemError(item_id)
        content = graph.nodes[item_id].get("content_hash")
        kept = []
        for event in self.log.events:
            if event.get("type") == "save" and event.get("item_id") == item_id:
                continue
            if event.get("type") == "link" and (event.get("from") == item_id or event.get("to") == item_id):
                continue
            kept.append(event)
        kept.append(
            {
                "type": "forget",
                "actor": actor,
                "learned_at": utc_now(),
                "item_id": item_id,
                "content_hash": content,
            }
        )
        self.log.replace_all(kept)
        self._replay()

    def recall(
        self,
        question: str,
        k: int | None = None,
        steps: int | None = None,
        retain: float | None = None,
        carry: float | None = None,
        as_of: str | None = None,
        true_on: str | None = None,
        explain: bool = False,
    ) -> RecallResult:
        if as_of is not None:
            as_of = check_as_of(as_of)
        if true_on is not None:
            true_on = check_as_of(true_on)[:10]
        return run_recall(
            self.index,
            self.engine,
            self.config,
            question,
            k=self.config.k if k is None else k,
            steps=self.config.steps if steps is None else steps,
            retain=self.config.retain if retain is None else retain,
            carry=self.config.carry if carry is None else carry,
            as_of=as_of,
            true_on=true_on,
            explain=explain,
        )

    def show(self, item_id: str) -> dict:
        graph = self.index.graph
        if item_id not in graph:
            raise UnknownItemError(item_id)
        data = graph.nodes[item_id]
        outgoing = []
        for _src, dst, _key, edge in graph.out_edges(item_id, keys=True, data=True):
            outgoing.append(_edge_view(dst, edge))
        incoming = []
        for src, _dst, _key, edge in graph.in_edges(item_id, keys=True, data=True):
            incoming.append(_edge_view(src, edge))
        outgoing.sort(key=lambda row: (row["kind"], row["other"]))
        incoming.sort(key=lambda row: (row["kind"], row["other"]))
        return {
            "id": item_id,
            "kind": data.get("kind"),
            "text": data.get("text"),
            "actor": data.get("actor"),
            "status": data.get("status"),
            "learned_at": data.get("learned_at"),
            "true_at": data.get("true_at"),
            "session": data.get("session"),
            "revised_by": data.get("revised_by"),
            "revising_text": data.get("revising_text"),
            "out": outgoing,
            "in": incoming,
        }

    def stats(self) -> dict:
        chunks = 0
        terms = 0
        for _node, data in self.index.graph.nodes(data=True):
            if data.get("kind") == "chunk":
                chunks += 1
            elif data.get("kind") == "term":
                terms += 1
        return {
            "events": len(self.log.events),
            "chunks": chunks,
            "terms": terms,
            "edges": self.index.graph.number_of_edges(),
            "log_bytes": self.log.path.stat().st_size if self.log.path.exists() else 0,
        }

    def rebuild(self) -> dict:
        self.log.reload()
        self._replay()
        stats = self.stats()
        stats["replayed"] = stats["events"]
        return stats

    def verify(self) -> ChainBreak | None:
        _events, info = scan(self.log.path)
        return info

    def _replay(self) -> None:
        self.index = GraphIndex(self.config)
        for event in self.log.events:
            self.index.apply(event)
        self.engine.load(self.index.graph)
        self.engine.decay_between_turns(0)


def _session(session: str | None) -> str | None:
    if session is None:
        return None
    cleaned = str(session).strip()
    return cleaned or None


def _learned(learned_at: str | None) -> str:
    if learned_at is None:
        return utc_now()
    return check_as_of(learned_at)


def _edge_view(other: str, edge: dict) -> dict:
    return {
        "kind": edge["kind"],
        "other": other,
        "weight": edge["weight"],
        "sign": edge["sign"],
        "learned_at": edge.get("learned_at"),
    }
