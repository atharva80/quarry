"""LLM + embeddings clients for the pipeline (batch work: rule extraction, policy-diff summaries, embeddings).

Providers (configurable, same as the Worker; defaults = Command Code, chosen by the owner):
  LLM_API_STYLE=responses OpenAI Responses API (Command Code provider API), through AI Gateway custom provider
  LLM_API_STYLE=chat      OpenAI chat-completions with tools (e.g. Fireworks), through AI Gateway custom provider
Fallback: Workers AI REST (Free-plan model), then "unavailable".
Spend: every call is priced from token counts and recorded in a daily ledger (D1 `metrics`, k=llm_usd) shared by
the hourly build and the evals, so all one-off LLM work stays under PIPELINE_LLM_USD_CAP per UTC day.

Structured output = a single forced tool call whose parameters are a JSON schema; the caller validates the
arguments with Pydantic and retries once with the validation error fed back.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
from dataclasses import dataclass, field
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parents[3]
ACCOUNT_ID = "c413669eec93af689722b3199813448b"
GATEWAY = "quarry"
API_STYLE = os.environ.get("LLM_API_STYLE", "responses")
GATEWAY_PROVIDER = os.environ.get("LLM_GATEWAY_PROVIDER", "custom-quarry-commandcode")
PRIMARY_MODEL = os.environ.get("LLM_MODEL", "deepseek/deepseek-v4.1-flash")
BASE_URL = os.environ.get("LLM_BASE_URL", "https://api.commandcode.ai/provider/v1")
USE_GATEWAY = os.environ.get("LLM_VIA_GATEWAY", "1" if os.environ.get("CLOUDFLARE_API_TOKEN") else "0") == "1"
FALLBACK_MODEL = "@cf/google/gemma-4-26b-a4b-it"
EMBED_MODEL = "@cf/google/embeddinggemma-2"
# USD per million tokens (input, output), from the providers' pricing pages (verified 2026-11-19)
PRICES = {PRIMARY_MODEL: (0.30, 1.20), FALLBACK_MODEL: (0.10, 0.30), EMBED_MODEL: (0.0017, 0.0)}


def _load_dotenv() -> None:
    p = ROOT / ".env"
    if p.exists():
        for line in p.read_text().splitlines():
            if "=" in line and not line.lstrip().startswith("#"):
                k, v = line.split("=", 1)
                os.environ.setdefault(k.strip(), v.strip())


_load_dotenv()
_cf_token: str | None = None


def cf_token() -> str:
    """CLOUDFLARE_API_TOKEN in CI; locally, wrangler's own OAuth token (never printed)."""
    global _cf_token
    if _cf_token:
        return _cf_token
    tok = os.environ.get("CLOUDFLARE_API_TOKEN")
    if not tok:
        out = subprocess.run(["npx", "--yes", "wrangler", "auth", "token", "--json"], cwd=ROOT / "worker",
                             capture_output=True, text=True, timeout=120).stdout
        tok = json.loads(out[out.find("{"):]).get("token")
    if not tok:
        raise RuntimeError("no Cloudflare token available")
    _cf_token = tok
    return tok


@dataclass
class Usage:
    calls: int = 0
    input_tokens: int = 0
    output_tokens: int = 0
    usd: float = 0.0
    by_model: dict = field(default_factory=dict)

    def add(self, model: str, inp: int, out: int) -> float:
        pi, po = PRICES.get(model, (0.3, 1.2))
        cost = inp / 1e6 * pi + out / 1e6 * po
        self.calls += 1
        self.input_tokens += inp
        self.output_tokens += out
        self.usd += cost
        m = self.by_model.setdefault(model, {"calls": 0, "in": 0, "out": 0, "usd": 0.0})
        m["calls"] += 1
        m["in"] += inp
        m["out"] += out
        m["usd"] += cost
        return cost


class BudgetExceeded(RuntimeError):
    pass


def _responses_input(messages: list[dict]) -> list[dict]:
    items: list[dict] = []
    for m in messages:
        if m["role"] == "tool":
            items.append({"type": "function_call_output", "call_id": m["tool_call_id"], "output": m["content"]})
        elif m.get("tool_calls"):
            for t in m["tool_calls"]:
                items.append({"type": "function_call", "call_id": t["id"], "name": t["function"]["name"],
                              "arguments": t["function"]["arguments"]})
        else:
            items.append({"role": "developer" if m["role"] == "system" else m["role"], "content": m["content"]})
    return items


def _from_responses(data: dict) -> dict:
    """Responses API result -> the chat-completions shape the rest of the code reads."""
    out = data.get("output") or []
    calls = [{"id": o.get("call_id"), "type": "function", "function": {"name": o.get("name"), "arguments": o.get("arguments")}}
             for o in out if o.get("type") == "function_call"]
    text = "".join(c.get("text", "") for o in out if o.get("type") == "message" for c in (o.get("content") or []))
    u = data.get("usage") or {}
    return {"choices": [{"message": {"content": text, "tool_calls": calls}}],
            "usage": {"prompt_tokens": u.get("input_tokens", 0), "completion_tokens": u.get("output_tokens", 0)}}


class Ledger:
    """Today's one-off LLM spend (UTC), shared by the build and the evals through D1 `metrics` (k = llm_usd)."""

    def __init__(self, db: str | None = "quarry-db"):
        self.db = db
        self.day = time.strftime("%Y-%m-%d", time.gmtime())
        self.base = 0.0
        if db:
            from . import d1
            rows = d1.query(db, f"SELECT v FROM metrics WHERE day = {d1.q(self.day)} AND k = 'llm_usd'")
            self.base = float(rows[0]["v"]) if rows else 0.0

    def flush(self, usd: float) -> None:
        if self.db and usd > 0:
            from . import d1
            d1.execute(self.db, [f"INSERT INTO metrics (day, k, v) VALUES ({d1.q(self.day)}, 'llm_usd', {usd}) "
                                 f"ON CONFLICT(day, k) DO UPDATE SET v = v + excluded.v;"])


class LLM:
    def __init__(self, cap_usd: float | None = None, primary: bool = True, timeout: float = 120,
                 ledger: Ledger | None = None):
        self.usage = Usage()
        self.ledger = ledger
        cap = cap_usd if cap_usd is not None else float(os.environ.get("PIPELINE_LLM_USD_CAP", "0.50"))
        self.cap = max(0.0, cap - (ledger.base if ledger else 0.0))  # what's left of today's shared cap
        self.key = os.environ.get("LLM_API_KEY")
        self.primary = primary and bool(self.key)
        self.http = httpx.Client(timeout=timeout)

    @property
    def model(self) -> str:
        return PRIMARY_MODEL if self.primary else FALLBACK_MODEL

    def _post(self, url: str, headers: dict, body: dict, tries: int = 4) -> dict:
        for attempt in range(tries):
            try:
                r = self.http.post(url, headers=headers, json=body)
            except httpx.HTTPError:
                time.sleep(2 ** attempt)
                continue
            if r.status_code in (429, 500, 502, 503, 504):
                ra = r.headers.get("retry-after", "")
                time.sleep(float(ra) if ra.replace(".", "").isdigit() else 2 ** (attempt + 1))
                continue
            if r.status_code >= 400:
                raise RuntimeError(f"LLM HTTP {r.status_code}: {r.text[:300]}")
            return r.json()
        raise RuntimeError("LLM: retries exhausted")

    def tool_call(self, system: str, user: str, tool: dict, *, effort: str = "low", max_tokens: int = 4000,
                  extra_messages: list | None = None) -> tuple[dict | None, dict]:
        """Force one call of `tool`; returns (arguments or None, meta)."""
        if self.usage.usd >= self.cap:
            raise BudgetExceeded(f"pipeline LLM cap ${self.cap:.2f} reached")
        messages = [{"role": "system", "content": system}, {"role": "user", "content": user}, *(extra_messages or [])]
        body = {"messages": messages, "tools": [{"type": "function", "function": tool}],
                "tool_choice": {"type": "function", "function": {"name": tool["name"]}},
                "max_tokens": max_tokens, "temperature": 0}
        t0 = time.time()
        if self.primary and API_STYLE == "responses":
            rbody = {"model": PRIMARY_MODEL, "input": _responses_input(messages),
                     "tools": [{"type": "function", **tool}],
                     "tool_choice": {"type": "function", "name": tool["name"]},
                     "reasoning": {"effort": "low" if effort in ("none", "low") else effort},
                     "max_output_tokens": max_tokens}
            headers = {"Authorization": f"Bearer {self.key}", "Content-Type": "application/json"}
            if USE_GATEWAY:  # CI: the scoped API token can authenticate to the gateway
                url = f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY}/{GATEWAY_PROVIDER}/responses"
                headers["cf-aig-authorization"] = f"Bearer {cf_token()}"
            else:  # local: wrangler's OAuth token can't, so call the provider directly (same retries/backoff)
                url = f"{BASE_URL}/responses"
            data = _from_responses(self._post(url, headers, rbody))
        elif self.primary:
            body["model"] = PRIMARY_MODEL
            body["reasoning_effort"] = effort
            url = f"https://gateway.ai.cloudflare.com/v1/{ACCOUNT_ID}/{GATEWAY}/{GATEWAY_PROVIDER}/chat/completions"
            headers = {"Authorization": f"Bearer {self.key}", "cf-aig-authorization": f"Bearer {cf_token()}",
                       "Content-Type": "application/json"}
            data = self._post(url, headers, body)
        else:
            body.pop("max_tokens")
            body["max_completion_tokens"] = max_tokens
            url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{FALLBACK_MODEL}"
            headers = {"Authorization": f"Bearer {cf_token()}", "cf-aig-gateway-id": GATEWAY}
            data = self._post(url, headers, body).get("result") or {}
        usage = data.get("usage") or {}
        cost = self.usage.add(self.model, int(usage.get("prompt_tokens") or 0), int(usage.get("completion_tokens") or 0))
        msg = ((data.get("choices") or [{}])[0]).get("message") or {}
        calls = msg.get("tool_calls") or []
        args = None
        raw = None
        if calls:
            raw = calls[0].get("function", {}).get("arguments")
            try:
                args = json.loads(raw) if isinstance(raw, str) else raw
            except json.JSONDecodeError:
                args = None
        meta = {"model": self.model, "latency_s": round(time.time() - t0, 2), "usd": cost, "raw": raw,
                "call_id": calls[0].get("id") if calls else None,
                "input_tokens": usage.get("prompt_tokens"), "output_tokens": usage.get("completion_tokens")}
        return args, meta


class Embedder:
    def __init__(self, dims: int = 256):
        self.dims = dims
        self.http = httpx.Client(timeout=120)
        self.usage = Usage()

    def embed(self, texts: list[str], kind: str = "document") -> list[list[float]]:
        """EmbeddingGemma-2 with its task prefixes; batches of 32."""
        pre = "title: none | text: " if kind == "document" else "task: search result | query: "
        out: list[list[float]] = []
        url = f"https://api.cloudflare.com/client/v4/accounts/{ACCOUNT_ID}/ai/run/{EMBED_MODEL}"
        for i in range(0, len(texts), 32):
            batch = [pre + t[:6000] for t in texts[i:i + 32]]
            for attempt in range(5):
                r = self.http.post(url, headers={"Authorization": f"Bearer {cf_token()}"},
                                   json={"input": batch, "dimensions": self.dims})
                if r.status_code == 200:
                    break
                time.sleep(2 ** attempt)
            r.raise_for_status()
            res = r.json()["result"]
            data = sorted(res["data"], key=lambda d: d["index"])
            out.extend(d["embedding"] for d in data)
            u = res.get("usage") or {}
            self.usage.add(EMBED_MODEL, int(u.get("prompt_tokens") or 0), 0)
        return out
