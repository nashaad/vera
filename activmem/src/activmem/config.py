"""Defaults and optional .activmem/config.toml overrides."""

from __future__ import annotations

import tomllib
from dataclasses import dataclass, field
from pathlib import Path

# Signed weights. Negative means the edge inhibits.
DEFAULT_WEIGHTS: dict[str, float] = {
    "mentions": 1.0,
    "mentioned_by": 0.5,
    "next": 0.15,
    "previous": 0.15,
    "revises": -1.5,
    "revised_by": 0.6,
}


@dataclass
class Config:
    steps: int = 4
    retain: float = 0.8
    carry: float = 0.5
    threshold: float = 0.01
    k: int = 5
    seed_activation: float = 1.0
    inferred_factor: float = 0.5
    clamp_min: float = -1.0
    clamp_max: float = 1.0
    squash_gain: float = 1.0
    min_activation: float = 1e-8
    explain_top: int = 8
    rrf_k: int = 60
    vector_k: int = 8
    vector_scan: int = 32
    vector_min_similarity: float = 0.2
    weights: dict[str, float] = field(default_factory=lambda: dict(DEFAULT_WEIGHTS))

    def weight(self, kind: str) -> tuple[float, int]:
        """Return (magnitude, sign) for an edge kind."""
        if kind not in self.weights:
            raise KeyError(kind)
        raw = float(self.weights[kind])
        if raw < 0:
            return -raw, -1
        return raw, 1


def load_config(path: Path) -> Config:
    cfg = Config()
    if not path.exists():
        return cfg
    data = tomllib.loads(path.read_text(encoding="utf-8"))
    numeric = (
        "steps",
        "retain",
        "carry",
        "threshold",
        "k",
        "seed_activation",
        "inferred_factor",
        "clamp_min",
        "clamp_max",
        "squash_gain",
        "min_activation",
        "explain_top",
        "rrf_k",
        "vector_k",
        "vector_scan",
        "vector_min_similarity",
    )
    for key in numeric:
        if key in data:
            setattr(cfg, key, data[key])
    if "weights" in data:
        merged = dict(cfg.weights)
        merged.update({key: float(value) for key, value in data["weights"].items()})
        cfg.weights = merged
    return cfg
