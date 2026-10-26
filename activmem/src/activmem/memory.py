"""Public ActivMem handle. The event log is the record; the graph is a projection."""

from __future__ import annotations

import json
import os
import time
from pathlib import Path

from activmem.config import load_config
from activmem.engine import LoopEngine
from activmem.events import (
    ActivMemError,
    ChainBreak,
    BadLinkKindError,
    UnknownItemError,
    check_as_of,
    normalize_true_at,
    require_actor,
    scan,
    utc_now,
    EventLog,
)
from activmem.graph import GraphIndex
from activmem.recall import RecallResult, format_context, run_recall
from activmem.text import content_hash, mint_id
from activmem.vectors import open_vectors


class ActivMem:
    def __init__(self, root: str | Path = ".", *, force: bool = False):
        self.root = Path(root)
        self.home = self.root / ".activmem"
        self.home.mkdir(parents=True, exist_ok=True)
        self.config = load_config(self.home / "config.toml")
        self.log = EventLog(self.home / "events.jsonl", force=force)
        self.engine = LoopEngine(self.config)
        self.index = GraphIndex(self.config)
        self.vectors = open_vectors(self.home / "chroma")
        self.graph_on = os.environ.get("ACTIVMEM_GRAPH", "on") != "off"
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
        source: str | None = None,
        source_line: int | None = None,
    ) -> str:
        actor = require_actor(actor)
        if status not in ("confirmed", "inferred"):
            raise ActivMemError(f"bad status: {status}")
        if not isinstance(text, str) or not text.strip():
            raise ActivMemError("text is empty")
        text = text.strip()
        source_key = _source_key(source, source_line)
        if source_key is not None and source_key in self.index.by_source:
            return self.index.by_source[source_key]
        content = content_hash(actor, text)
        item_id = mint_id(text, actor, self.index.graph, content)
        body = {
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
        if source_key is not None:
            body["source"] = source_key[0]
            body["source_line"] = source_key[1]
        record = self.log.append(body)
        self.index.apply(record)
        self._embed_new(item_id)
        return item_id

    def save_turn(
        self,
        user_text: str,
        reply_text: str,
        session: str,
        learned_at: str | None = None,
    ) -> tuple[str, str]:
        user_id = self.save(user_text, actor="nash", session=session, learned_at=learned_at)
        reply_id = self.save(reply_text, actor="vera", session=session, learned_at=learned_at)
        # The next turn may share no words with this one. Leave what Nash just
        # said warm so leftover heat can show it. The reply stays cold.
        self.engine.poke({user_id: self.config.seed_activation})
        return user_id, reply_id

    def revise(self, new_item: str, old_item: str, actor: str = "vera", session: str | None = None) -> str:
        # A later fact may revise a fact that already revised an older one
        # (Berlin revises Toronto, which revised Lisbon). The tool text tells
        # Vera not to aim at a pure retraction such as "sike, I don't".
        if new_item not in self.index.graph:
            new_item = self.save(new_item, actor=actor, session=session)
        self.annotate(new_item, "revises", old_item, actor=actor)
        return new_item

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

    def forget(self, item_id: str, actor: str = "nash") -> None:
        actor = require_actor(actor)
        graph = self.index.graph
        if item_id not in graph or graph.nodes[item_id].get("kind") != "chunk":
            raise UnknownItemError(item_id)
        content = graph.nodes[item_id].get("content_hash")
        self.vectors.delete(item_id)
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
        seeds: str = "both",
    ) -> RecallResult:
        if seeds not in ("words", "vectors", "both"):
            raise ActivMemError(f"bad seeds: {seeds}")
        if as_of is not None:
            as_of = check_as_of(as_of)
        if true_on is not None:
            true_on = check_as_of(true_on)[:10]
        vector_hits: list[tuple[str, float]] = []
        vector_ms = 0.0
        if seeds != "words" or not self.graph_on:
            started = time.perf_counter()
            raw = self.vectors.query(question, self.config.vector_scan)
            vector_ms = (time.perf_counter() - started) * 1000
            qualified = [
                (item_id, score)
                for item_id, score in raw
                if score >= self.config.vector_min_similarity and item_id in self.index.graph
            ]
            by_id = {item_id: score for item_id, score in qualified}
            seed_hits: list[tuple[str, float]] = []
            revised: list[tuple[str, float]] = []
            for item_id, score in qualified:
                # The next filler line embeds this sentence as context and can
                # outrank it. Drop that neighbor. A separate memory stays.
                neighbor = False
                for kind in ("previous", "next"):
                    other = _neighbor(self.index.graph, item_id, kind)
                    if other is not None and by_id.get(other, -1) > score:
                        neighbor = True
                if neighbor:
                    continue
                if _is_revised(self.index.graph, item_id):
                    revised.append((item_id, score))
                elif len(seed_hits) < self.config.vector_k:
                    seed_hits.append((item_id, score))
            # A revised belief can sit below the top seeds once filler crowds
            # the index. It still has to come back as taken back.
            vector_hits = seed_hits + revised
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
            seeds_mode="vectors" if not self.graph_on else seeds,
            vector_hits=[] if seeds == "words" and self.graph_on else vector_hits,
            vector_ms=vector_ms,
            graph_on=self.graph_on,
        )

    def context_for(self, session: str, next_message: str, k: int | None = None) -> dict:
        result = self.recall(next_message, k=k)
        context = format_context(result)
        with (self.home / "context-log.jsonl").open("a", encoding="utf-8") as handle:
            handle.write(json.dumps({
                "session": session,
                "message": next_message,
                "context": context,
            }) + "\n")
        return {
            "session": session,
            "context": context,
            "recall": result.to_dict(),
        }

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
        for node, data in self.index.graph.nodes(data=True):
            if data.get("kind") == "chunk":
                self._embed(node)

    def _embed_new(self, item_id: str) -> None:
        previous = _neighbor(self.index.graph, item_id, "previous")
        self._embed(item_id)
        if previous:
            self.vectors.delete(previous)
            self._embed(previous)

    def _embed(self, item_id: str) -> None:
        if item_id not in self.index.graph or self.vectors.has(item_id):
            return
        data = self.index.graph.nodes[item_id]
        if data.get("kind") != "chunk":
            return
        self.vectors.add(
            item_id,
            data.get("text") or "",
            _embed_text(self.index.graph, item_id),
            {
                "actor": data.get("actor") or "",
                "session": data.get("session") or "",
                "content_hash": data.get("content_hash") or "",
                "status": data.get("status") or "",
            },
        )


def _session(session: str | None) -> str | None:
    if session is None:
        return None
    cleaned = str(session).strip()
    return cleaned or None


def _learned(learned_at: str | None) -> str:
    if learned_at is None:
        return utc_now()
    return check_as_of(learned_at)


def _source_key(source: str | None, source_line: int | None) -> tuple[str, int] | None:
    if not source or source_line is None:
        return None
    return str(Path(source).resolve()), int(source_line)


def _is_revised(graph, item_id: str) -> bool:
    for _src, _dst, _key, edge in graph.in_edges(item_id, keys=True, data=True):
        if edge.get("kind") == "revises":
            return True
    return False


def _neighbor(graph, item_id: str, kind: str) -> str | None:
    for _src, dest, _key, edge in graph.out_edges(item_id, keys=True, data=True):
        if edge.get("kind") == kind:
            return dest
    return None


def _embed_text(graph, item_id: str) -> str:
    data = graph.nodes[item_id]
    # The chunk's own sentence comes first. Neighbors before it made the
    # following filler line outrank the sentence they were only context for.
    parts = [f"speaker: {data.get('actor') or ''}", data.get("text") or ""]
    previous = _neighbor(graph, item_id, "previous")
    nxt = _neighbor(graph, item_id, "next")
    if previous and previous in graph:
        parts.append(graph.nodes[previous].get("text") or "")
    if nxt and nxt in graph:
        parts.append(graph.nodes[nxt].get("text") or "")
    return "\n".join(parts)


def _edge_view(other: str, edge: dict) -> dict:
    return {
        "kind": edge["kind"],
        "other": other,
        "weight": edge["weight"],
        "sign": edge["sign"],
        "learned_at": edge.get("learned_at"),
    }
