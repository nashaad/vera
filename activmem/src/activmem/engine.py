"""ActivationEngine protocol and the LoopEngine implementation."""

from __future__ import annotations

from dataclasses import dataclass
from typing import Protocol

import math

import networkx as nx

from activmem.config import Config
from activmem.events import learned_ok


@dataclass(frozen=True, slots=True)
class SettleParams:
    steps: int
    retain: float
    threshold: float
    inferred_factor: float
    clamp_min: float
    clamp_max: float
    squash_gain: float
    min_activation: float
    explain_top: int
    as_of: str | None = None


@dataclass(frozen=True, slots=True)
class StepTrace:
    step: int
    changes: list[tuple[str, float, float, float]]
    inhibitions: list[tuple[str, str, float]]


class ActivationEngine(Protocol):
    """Swappable spreading-activation core. A later Go engine can replace LoopEngine."""

    def load(self, graph: nx.MultiDiGraph) -> None: ...

    def poke(self, seeds: dict[str, float]) -> None: ...

    def settle(self, params: SettleParams) -> dict[str, float]: ...

    def decay_between_turns(self, carry: float) -> None: ...


def _squash(value: float, gain: float, low: float, high: float) -> float:
    """tanh so two strong memories do not both sit on a hard ceiling."""
    squashed = math.tanh(gain * value)
    if squashed > high:
        return high
    if squashed < low:
        return low
    return squashed


class LoopEngine:
    """Synchronous spread over the awake set. Does not walk the whole graph."""

    def __init__(self, config: Config):
        self.config = config
        self.graph: nx.MultiDiGraph | None = None
        self.activation: dict[str, float] = {}
        self.trace: list[StepTrace] = []
        self.touched: set[str] = set()

    def load(self, graph: nx.MultiDiGraph) -> None:
        self.graph = graph

    def poke(self, seeds: dict[str, float]) -> None:
        for node, value in seeds.items():
            self.activation[node] = self.activation.get(node, 0.0) + value

    def decay_between_turns(self, carry: float) -> None:
        if carry == 0:
            self.activation.clear()
            return
        floor = self.config.min_activation
        self.activation = {
            node: value * carry
            for node, value in self.activation.items()
            if abs(value * carry) >= floor
        }

    def settle(self, params: SettleParams) -> dict[str, float]:
        """Spread activation synchronously.

        A node fires when its activation is positive and above the threshold.
        It sends activation × weight × sign to each visible neighbour. Term
        nodes divide by how many of those neighbours they have. Inferred
        targets keep inferred_factor of each delivery. Every awake node then
        keeps its previous activation × retain, then tanh squashes the sum.
        """
        if self.graph is None:
            raise RuntimeError("activation engine has no graph")
        graph = self.graph
        act = self.activation
        self.touched = set()
        self.trace = []
        for step in range(params.steps):
            firing = [
                node
                for node, value in act.items()
                if value > 0 and value > params.threshold and _visible(graph, node, params.as_of)
            ]
            incoming: dict[str, float] = {}
            inhibitions: list[tuple[str, str, float]] = []
            for node in firing:
                self.touched.add(node)
                value = act[node]
                deliveries: list[tuple[str, dict]] = []
                for _src, dest, _key, data in graph.out_edges(node, keys=True, data=True):
                    if not _visible(graph, dest, params.as_of):
                        continue
                    if not learned_ok(data.get("learned_at"), params.as_of):
                        continue
                    deliveries.append((dest, data))
                divisor = len(deliveries) if graph.nodes[node].get("kind") == "term" else 1
                if divisor == 0:
                    continue
                for dest, data in deliveries:
                    delta = value * float(data["weight"]) * int(data["sign"]) / divisor
                    if graph.nodes[dest].get("status") == "inferred":
                        delta *= params.inferred_factor
                    if delta == 0:
                        continue
                    incoming[dest] = incoming.get(dest, 0.0) + delta
                    self.touched.add(dest)
                    if delta < 0:
                        inhibitions.append((node, dest, delta))
            new_act: dict[str, float] = {}
            changes: list[tuple[str, float, float, float]] = []
            for node in set(act) | set(incoming):
                if not _visible(graph, node, params.as_of):
                    kept = act.get(node, 0.0)
                    if abs(kept) >= params.min_activation:
                        new_act[node] = kept
                    continue
                old = act.get(node, 0.0)
                updated = _squash(
                    old * params.retain + incoming.get(node, 0.0),
                    params.squash_gain,
                    params.clamp_min,
                    params.clamp_max,
                )
                if abs(updated) >= params.min_activation:
                    new_act[node] = updated
                delta = updated - old
                if abs(delta) >= params.min_activation:
                    changes.append((node, old, updated, delta))
            act = new_act
            changes.sort(key=lambda item: abs(item[3]), reverse=True)
            self.trace.append(
                StepTrace(
                    step=step + 1,
                    changes=changes[: params.explain_top],
                    inhibitions=inhibitions,
                )
            )
        self.activation = act
        return act


def _visible(graph: nx.MultiDiGraph, node: str, as_of: str | None) -> bool:
    if node not in graph:
        return False
    return learned_ok(graph.nodes[node].get("learned_at"), as_of)
