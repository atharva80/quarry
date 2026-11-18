"""Program embeddings: embed only programs whose embedding text changed, cache in D1, emit the int8 matrix."""

from __future__ import annotations

import base64
import hashlib
import json
import struct
from pathlib import Path

import numpy as np

from . import d1
from .llm import EMBED_MODEL, Embedder
from .normalize import embed_text

DIMS = 256


def text_hash(t: str) -> str:
    return hashlib.sha256(f"{EMBED_MODEL}:{DIMS}:{t}".encode()).hexdigest()[:16]


def encode(vec: np.ndarray) -> str:
    return base64.b64encode(vec.astype("<f2").tobytes()).decode()


def decode(s: str) -> np.ndarray:
    return np.frombuffer(base64.b64decode(s), dtype="<f2").astype(np.float32)


def load_cache(db: str) -> dict[str, tuple[str, str]]:
    rows = d1.query(db, "SELECT program_id, text_hash, vec FROM embeddings")
    return {r["program_id"]: (r["text_hash"], r["vec"]) for r in rows}


def update(db: str, programs: list[dict], rules_text: dict[str, str] | None = None, cache: dict | None = None,
           write: bool = True) -> tuple[list[str], np.ndarray, dict]:
    """Returns (ids, float32 matrix [N, DIMS], stats). Embeds only new/changed texts."""
    cache = load_cache(db) if cache is None else cache
    texts = {p["id"]: embed_text(p, (rules_text or {}).get(p["id"], "")) for p in programs}
    todo = [pid for pid, t in texts.items() if cache.get(pid, ("",))[0] != text_hash(t)]
    emb = Embedder(DIMS)
    fresh: dict[str, np.ndarray] = {}
    if todo:
        vecs = emb.embed([texts[pid] for pid in todo], "document")
        for pid, v in zip(todo, vecs, strict=True):
            fresh[pid] = np.asarray(v, dtype=np.float32)
        if write:
            stmts = [d1.insert("embeddings", {"program_id": pid, "model": EMBED_MODEL, "text_hash": text_hash(texts[pid]),
                                              "vec": encode(fresh[pid])}, upsert_key="pk") for pid in todo]
            d1.execute(db, stmts, chunk=500)
    ids = [p["id"] for p in programs]
    mat = np.zeros((len(ids), DIMS), dtype=np.float32)
    for i, pid in enumerate(ids):
        mat[i] = fresh[pid] if pid in fresh else decode(cache[pid][1])
    stats = {"embedded": len(todo), "cached": len(ids) - len(todo), "tokens": emb.usage.input_tokens,
             "usd": emb.usage.usd}
    return ids, mat, stats


def quantise(mat: np.ndarray) -> tuple[np.ndarray, np.ndarray]:
    """L2-normalise rows, then symmetric int8 per row. Returns (int8 [N,D], scales float32 [N])."""
    x = mat / np.maximum(np.linalg.norm(mat, axis=1, keepdims=True), 1e-12)
    mx = np.maximum(np.abs(x).max(axis=1), 1e-12)
    q = np.round(x / mx[:, None] * 127).astype(np.int8)
    return q, (mx / 127).astype(np.float32)


def write_matrix(out_dir: Path, ids: list[str], mat: np.ndarray) -> int:
    q, scales = quantise(mat)
    n, d = q.shape
    blob = b"QVEC" + struct.pack("<II", n, d) + scales.astype("<f4").tobytes() + q.tobytes()
    (out_dir / "data").mkdir(parents=True, exist_ok=True)
    (out_dir / "data/vectors.bin").write_bytes(blob)
    (out_dir / "data/vectors.ids.json").write_text(json.dumps(ids, separators=(",", ":")))
    return len(blob)
