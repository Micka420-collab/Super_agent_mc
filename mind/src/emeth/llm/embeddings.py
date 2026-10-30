"""Embeddings with a dependable fallback.

Provider embeddings when available; otherwise a deterministic hashed character-n-gram embedding
(works offline, good enough for near-duplicate detection and coarse skill retrieval). All vectors are
L2-normalised so cosine similarity is a dot product.
"""

from __future__ import annotations

import hashlib
import re

import numpy as np

EMBED_DIM = 384
_TOKEN = re.compile(r"[a-z0-9_]+")


def hashed_embedding(text: str, dim: int = EMBED_DIM) -> list[float]:
    vec = np.zeros(dim, dtype=np.float32)
    words = _TOKEN.findall(text.lower())
    if not words:
        return vec.tolist()
    grams: list[str] = []
    for w in words:
        grams.append(f"w:{w}")
        padded = f"#{w}#"
        for n in (3, 4):
            grams.extend(f"g{n}:{padded[i : i + n]}" for i in range(max(0, len(padded) - n + 1)))
    for i in range(len(words) - 1):
        grams.append(f"b:{words[i]}_{words[i + 1]}")
    for g in grams:
        h = hashlib.blake2b(g.encode("utf-8"), digest_size=8).digest()
        idx = int.from_bytes(h[:4], "little") % dim
        sign = 1.0 if h[4] & 1 else -1.0
        vec[idx] += sign
    norm = float(np.linalg.norm(vec))
    if norm > 0:
        vec /= norm
    return vec.tolist()


def normalize(vec: list[float]) -> list[float]:
    arr = np.asarray(vec, dtype=np.float32)
    norm = float(np.linalg.norm(arr))
    return (arr / norm).tolist() if norm > 0 else arr.tolist()


def cosine(a: list[float], b: list[float]) -> float:
    if not a or not b or len(a) != len(b):
        return 0.0
    return float(np.dot(np.asarray(a, dtype=np.float32), np.asarray(b, dtype=np.float32)))


class Embedder:
    """Embeds through the router's `embed` tier, falling back to the hashed embedding."""

    def __init__(self, router=None):  # type: ignore[no-untyped-def]
        self.router = router
        self.provider_dim: int | None = None

    async def embed(self, texts: list[str]) -> list[list[float]]:
        if self.router is not None:
            try:
                vectors = await self.router.embed(texts)
                if vectors and all(vectors):
                    self.provider_dim = len(vectors[0])
                    return [normalize(v) for v in vectors]
            except Exception:  # noqa: BLE001 — any failure falls back to the local embedding
                pass
        return [hashed_embedding(t) for t in texts]

    async def embed_one(self, text: str) -> list[float]:
        return (await self.embed([text]))[0]
