"""Build a networkx graph by replaying events. The graph is never saved."""

from __future__ import annotations

from dataclasses import dataclass, field

import networkx as nx

from activmem.config import Config
from activmem.events import ActivMemError
from activmem.text import term_tokens


def graph_signature(graph: nx.MultiDiGraph) -> tuple:
    nodes = []
    for node, data in graph.nodes(data=True):
        true_at = data.get("true_at")
        if isinstance(true_at, dict):
            true_at = (true_at.get("from"), true_at.get("to"))
        nodes.append(
            (
                node,
                data.get("kind"),
                data.get("text"),
                data.get("actor"),
                data.get("status"),
                data.get("learned_at"),
                true_at,
                data.get("session"),
                data.get("revised_by"),
            )
        )
    edges = []
    for src, dst, _key, data in graph.edges(keys=True, data=True):
        edges.append((src, dst, data["kind"], data["weight"], data["sign"], data.get("learned_at")))
    return tuple(sorted(nodes)), tuple(sorted(edges))


@dataclass
class GraphIndex:
    config: Config
    graph: nx.MultiDiGraph = field(default_factory=nx.MultiDiGraph)
    last_in_session: dict[str, str] = field(default_factory=dict)
    by_hash: dict[str, str] = field(default_factory=dict)
    by_source: dict[tuple[str, int], str] = field(default_factory=dict)
    forgotten_hashes: set[str] = field(default_factory=set)

    def apply(self, event: dict) -> None:
        kind = event.get("type")
        if kind == "save":
            self._apply_save(event)
        elif kind == "link":
            self._apply_link(event)
        elif kind == "forget":
            self._apply_forget(event)
        else:
            raise ActivMemError(f"bad event type: {kind}")

    def _edge(self, src: str, dst: str, kind: str, learned_at: str) -> None:
        if self.graph.has_edge(src, dst, key=kind):
            return
        weight, sign = self.config.weight(kind)
        self.graph.add_edge(
            src,
            dst,
            key=kind,
            kind=kind,
            weight=weight,
            sign=sign,
            learned_at=learned_at,
        )

    def _apply_save(self, event: dict) -> None:
        content = event["content_hash"]
        item_id = event["item_id"]
        if item_id in self.graph:
            return
        learned = event["learned_at"]
        self.graph.add_node(
            item_id,
            kind="chunk",
            text=event["text"],
            actor=event["actor"],
            status=event["status"],
            learned_at=learned,
            true_at=event.get("true_at"),
            session=event.get("session"),
            content_hash=content,
            revised_by=None,
            revising_text=None,
            revised_at=None,
        )
        self.by_hash[content] = item_id
        source = event.get("source")
        source_line = event.get("source_line")
        if source and source_line is not None:
            self.by_source[(str(source), int(source_line))] = item_id
        for term in term_tokens(event["text"]):
            term_id = f"t:{term}"
            if term_id not in self.graph:
                self.graph.add_node(
                    term_id,
                    kind="term",
                    text=term,
                    actor=None,
                    status=None,
                    learned_at=learned,
                    true_at=None,
                    session=None,
                    content_hash=None,
                    revised_by=None,
                    revising_text=None,
                    revised_at=None,
                )
            self._edge(item_id, term_id, "mentions", learned)
            self._edge(term_id, item_id, "mentioned_by", learned)
        session = event.get("session")
        if session:
            previous = self.last_in_session.get(session)
            if previous and previous in self.graph:
                self._edge(previous, item_id, "next", learned)
                self._edge(item_id, previous, "previous", learned)
            self.last_in_session[session] = item_id

    def _apply_link(self, event: dict) -> None:
        if event.get("kind") != "revises":
            raise ActivMemError(f"bad link kind: {event.get('kind')}")
        src = event["from"]
        dst = event["to"]
        if src not in self.graph or dst not in self.graph:
            return
        if self.graph.nodes[src].get("kind") != "chunk" or self.graph.nodes[dst].get("kind") != "chunk":
            return
        learned = event["learned_at"]
        self._edge(src, dst, "revises", learned)
        self._edge(dst, src, "revised_by", learned)
        node = self.graph.nodes[dst]
        revised_at = node.get("revised_at")
        if revised_at is None or learned >= revised_at:
            node["revised_by"] = src
            node["revising_text"] = self.graph.nodes[src].get("text")
            node["revised_at"] = learned

    def _apply_forget(self, event: dict) -> None:
        content = event.get("content_hash")
        if content:
            self.forgotten_hashes.add(content)
            self.by_hash.pop(content, None)
        item_id = event.get("item_id")
        if item_id and item_id in self.graph:
            self._drop_chunk(item_id)

    def _drop_chunk(self, item_id: str) -> None:
        neighbors = set(self.graph.predecessors(item_id)) | set(self.graph.successors(item_id))
        self.graph.remove_node(item_id)
        for node in neighbors:
            if node in self.graph and self.graph.nodes[node].get("kind") == "term" and self.graph.degree(node) == 0:
                self.graph.remove_node(node)
        for session, last in list(self.last_in_session.items()):
            if last == item_id:
                self.last_in_session.pop(session, None)
