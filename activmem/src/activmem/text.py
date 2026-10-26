"""Tokenising, stopwords, and readable item ids."""

from __future__ import annotations

import hashlib
import re

import networkx as nx

MIN_TOKEN_LEN = 2
ID_WORDS = 3
ID_SUFFIX = 4

# Small function-word list. "really" is included so "I really like pollock."
# mints an id shaped like like-pollock-3f9a. "like" is not a stopword.
STOPWORDS = frozenset(
    """
    a an the i me my we our you your he she it its they them their
    is am are was were be been being do does did doing
    of to in on at for from with by as and or but if so
    not no nor dont don
    what why how who whom whose where when which
    this that these those there here
    have has had having
    just really very also too
    can could should would will
    about into over after before than then
    """.split()
)

# One alias so "Where do I work?" meets "I worked at Acme". Not a stemmer.
ALIASES = {"worked": "work"}

_TOKEN = re.compile(r"[a-z0-9]+")


def tokens(text: str) -> list[str]:
    cleaned = text.lower().replace("'", " ").replace("\u2019", " ").replace("\u2018", " ")
    return _TOKEN.findall(cleaned)


def term_tokens(text: str) -> list[str]:
    """Content terms in first-seen order, with the worked/work alias applied."""
    seen: set[str] = set()
    terms: list[str] = []
    for tok in tokens(text):
        if len(tok) < MIN_TOKEN_LEN or tok in STOPWORDS:
            continue
        term = ALIASES.get(tok, tok)
        if len(term) < MIN_TOKEN_LEN or term in STOPWORDS or term in seen:
            continue
        seen.add(term)
        terms.append(term)
    return terms


def id_words(text: str) -> list[str]:
    """Surface content words used in readable ids. No aliasing."""
    return [tok for tok in tokens(text) if len(tok) >= MIN_TOKEN_LEN and tok not in STOPWORDS]


def content_hash(actor: str, text: str) -> str:
    return hashlib.sha256(f"{actor}\n{text}".encode("utf-8")).hexdigest()


def readable_id(text: str) -> str:
    words = id_words(text)[:ID_WORDS]
    slug = "-".join(words) if words else "note"
    suffix = hashlib.sha256(text.encode("utf-8")).hexdigest()[:ID_SUFFIX]
    return f"{slug}-{suffix}"


def mint_id(text: str, actor: str, graph: nx.MultiDiGraph, content: str) -> str:
    """Mint a readable id. Extend the suffix if another chunk already holds it."""
    words = id_words(text)[:ID_WORDS]
    slug = "-".join(words) if words else "note"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()
    base = f"{slug}-{digest[:ID_SUFFIX]}"
    if base not in graph:
        return base
    existing = graph.nodes[base]
    if existing.get("content_hash") == content and existing.get("text") == text:
        return base
    mixed = hashlib.sha256(f"{actor}\n{text}".encode("utf-8")).hexdigest()
    for length in range(ID_SUFFIX + 1, 17):
        candidate = f"{slug}-{mixed[:length]}"
        if candidate not in graph:
            return candidate
    raise RuntimeError(f"could not mint an id for {text!r}")
