"""Chroma projection. Embeddings are a cache; the event log stays the record."""

from __future__ import annotations

import hashlib
import os
from pathlib import Path


class VectorStore:
    """add, query, delete, has. The embedding function can be swapped."""

    def __init__(self, path: Path, embedding=None):
        self.path = Path(path)
        self.path.mkdir(parents=True, exist_ok=True)
        self._embedding = embedding
        self._collection = None
        self.embed_calls = 0
        self._known: set[str] | None = None

    def _open(self):
        if self._collection is not None:
            return self._collection
        import chromadb

        embedding = self._embedding if self._embedding is not None else _default_embedding()
        self._embedding = _CountingEmbedding(embedding, self)
        client = chromadb.PersistentClient(path=str(self.path))
        self._collection = client.get_or_create_collection(
            name="chunks",
            embedding_function=self._embedding,
            metadata={"hnsw:space": "cosine"},
        )
        return self._collection

    def known(self) -> set[str]:
        if self._known is None:
            got = self._open().get(include=[])
            self._known = set(got.get("ids") or [])
        return self._known

    def has(self, item_id: str) -> bool:
        return item_id in self.known()

    def add(self, item_id: str, document: str, embed_text: str, metadata: dict) -> None:
        if item_id in self.known():
            return
        clean = {key: value for key, value in metadata.items() if value is not None}
        self._open().upsert(
            ids=[item_id],
            documents=[document],
            embeddings=self._embedding([embed_text]),
            metadatas=[clean or {"item_id": item_id}],
        )
        self.known().add(item_id)

    def add_many(self, rows: list[tuple[str, str, str, dict]], batch: int = 128) -> None:
        """rows are (item_id, document, embed_text, metadata). Skips ids already stored."""
        pending = [row for row in rows if row[0] not in self.known()]
        for start in range(0, len(pending), batch):
            chunk = pending[start:start + batch]
            embedded = self._embedding.embed_documents([row[2] for row in chunk])
            ids = [row[0] for row in chunk]
            documents = [row[1] for row in chunk]
            metadatas = []
            for row in chunk:
                clean = {key: value for key, value in row[3].items() if value is not None}
                metadatas.append(clean or {"item_id": row[0]})
            self._open().upsert(ids=ids, documents=documents, embeddings=embedded, metadatas=metadatas)
            self.known().update(ids)

    def query(self, text: str, k: int) -> list[tuple[str, float]]:
        if k <= 0 or not self.known():
            return []
        found = self._open().query(query_texts=[text], n_results=min(k, len(self.known())))
        ids = (found.get("ids") or [[]])[0]
        distances = (found.get("distances") or [[]])[0]
        hits = []
        for item_id, distance in zip(ids, distances):
            similarity = 1.0 - float(distance)
            hits.append((item_id, similarity))
        return hits

    def delete(self, item_id: str) -> None:
        if item_id not in self.known():
            return
        self._open().delete(ids=[item_id])
        self.known().discard(item_id)


class NullVectors:
    """Used when embeddings are switched off. Recall then seeds from words only."""

    embed_calls = 0

    def known(self) -> set[str]:
        return set()

    def has(self, item_id: str) -> bool:
        return False

    def add(self, item_id: str, document: str, embed_text: str, metadata: dict) -> None:
        return None

    def query(self, text: str, k: int) -> list[tuple[str, float]]:
        return []

    def delete(self, item_id: str) -> None:
        return None


class HashEmbedding:
    """Deterministic stand-in so tests can cache vectors without downloading a model."""

    def __call__(self, input: list[str]) -> list[list[float]]:
        vectors = []
        for text in input:
            digest = hashlib.sha256(text.encode("utf-8")).digest()
            vectors.append([((digest[index % len(digest)] / 127.5) - 1.0) for index in range(32)])
        return vectors

    def embed_query(self, input: list[str]) -> list[list[float]]:
        return self.__call__(input)

    def embed_documents(self, input: list[str]) -> list[list[float]]:
        return self.__call__(input)

    def name(self) -> str:
        return "hash"

    @staticmethod
    def is_legacy() -> bool:
        return False


class _CountingEmbedding:
    def __init__(self, inner, store: VectorStore):
        self._inner = inner
        self._store = store

    def _rows(self, value) -> list:
        return list(value)

    def __call__(self, input):
        rows = self._rows(input)
        self._store.embed_calls += len(rows)
        return self._inner(rows)

    def embed_documents(self, input):
        rows = self._rows(input)
        self._store.embed_calls += len(rows)
        embed = getattr(self._inner, "embed_documents", None)
        return embed(rows) if callable(embed) else self._inner(rows)

    def embed_query(self, input):
        rows = self._rows(input)
        self._store.embed_calls += len(rows)
        embed = getattr(self._inner, "embed_query", None)
        return embed(rows) if callable(embed) else self._inner(rows)

    def name(self) -> str:
        named = getattr(self._inner, "name", None)
        return named() if callable(named) else "activmem"

    def is_legacy(self) -> bool:
        return False


def _default_embedding():
    from chromadb.utils.embedding_functions import DefaultEmbeddingFunction

    return DefaultEmbeddingFunction()


def open_vectors(path: Path):
    mode = os.environ.get("ACTIVMEM_EMBED", "1")
    if mode == "0":
        return NullVectors()
    if mode == "fake":
        return VectorStore(path, embedding=HashEmbedding())
    return VectorStore(path)
