"""Rule extraction: untrusted policy text -> validated, quote-grounded RulesCard.

Security: the extraction call has no tools except the output schema, policy text is delimited as data, and the
output must pass Pydantic validation *and* the automatic quote check. A field whose quote is not found in the
policy is downgraded to "unclear" (scanning) or its quote dropped; this is what keeps wrong "scanning allowed"
answers at zero.
"""

from __future__ import annotations

import re
import time
import unicodedata
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, Field, ValidationError, field_validator

from .llm import LLM, BudgetExceeded
from .policies import sections

ROOT = Path(__file__).resolve().parents[3]
PROMPT = (ROOT / "prompts" / "extract_rules.md").read_text()
FIELDS = ["scanning", "rate_limit", "required_header", "test_accounts", "excluded_classes", "safe_harbour",
          "bounty_table", "disclosure"]


class Field_(BaseModel):
    value: str = Field(max_length=400)
    quote: str = Field(default="", max_length=600)
    section: str = Field(default="", max_length=200)


class ScanField(Field_):
    value: Literal["yes", "no", "limited", "unclear"]


class SafeHarbourField(Field_):
    value: Literal["yes", "no", "unclear"]


class ListField(BaseModel):
    value: list[str] = Field(default_factory=list, max_length=20)
    quote: str = Field(default="", max_length=600)
    section: str = Field(default="", max_length=200)

    @field_validator("value")
    @classmethod
    def short(cls, v: list[str]) -> list[str]:
        return [s.strip()[:80] for s in v if s and s.strip()][:15]


class RulesCard(BaseModel):
    scanning: ScanField
    rate_limit: Field_
    required_header: Field_
    test_accounts: Field_
    excluded_classes: ListField
    safe_harbour: SafeHarbourField
    bounty_table: Field_
    disclosure: Field_


def _f(desc: str, enum: list[str] | None = None) -> dict:
    v = {"type": "string", "description": desc}
    if enum:
        v["enum"] = enum
    return {"type": "object", "required": ["value", "quote", "section"], "additionalProperties": False,
            "properties": {"value": v, "quote": {"type": "string", "description": "verbatim from the policy"},
                           "section": {"type": "string"}}}


TOOL = {
    "name": "rules_card",
    "description": "Record the program's testing rules, each with a verbatim supporting quote.",
    "parameters": {
        "type": "object", "additionalProperties": False, "required": FIELDS,
        "properties": {
            "scanning": _f("automated scanning allowed?", ["yes", "no", "limited", "unclear"]),
            "rate_limit": _f("explicit rate limit or 'none stated'"),
            "required_header": _f("required header/User-Agent or 'none stated'"),
            "test_accounts": _f("test-account rules or 'none stated'"),
            "excluded_classes": {"type": "object", "required": ["value", "quote", "section"], "additionalProperties": False,
                                 "properties": {"value": {"type": "array", "items": {"type": "string"}},
                                                "quote": {"type": "string"}, "section": {"type": "string"}}},
            "safe_harbour": _f("safe harbour commitment?", ["yes", "no", "unclear"]),
            "bounty_table": _f("one-line reward summary, 'no bounty (VDP)' or 'unclear'"),
            "disclosure": _f("disclosure rule or 'unclear'"),
        },
    },
}


# ---------- quote check ----------

_TRANS = str.maketrans({"‘": "'", "’": "'", "“": '"', "”": '"', "–": "-", "—": "-",
                        " ": " ", "*": "", "_": "", "`": "", "\\": ""})


def norm(s: str) -> str:
    s = unicodedata.normalize("NFKC", s or "").translate(_TRANS)
    s = re.sub(r"\[([^\]]*)\]\([^)]*\)", r"\1", s)  # markdown links -> text
    s = re.sub(r"^\s*(?:[-+]|\d+\.)\s+", "", s, flags=re.M)  # list markers
    s = re.sub(r"#+\s*", "", s)
    return re.sub(r"\s+", " ", s).strip().lower()


def quote_found(quote: str, policy_norm: str) -> bool:
    q = norm(quote).strip(" .\"'…")
    if len(q) < 8:
        return False
    if q in policy_norm:
        return True
    # tolerate an ellipsis joining two verbatim pieces
    parts = [p.strip(" .") for p in re.split(r"\.\.\.|…", q) if len(p.strip(" .")) >= 8]
    return len(parts) > 1 and all(p in policy_norm for p in parts)


def section_of(quote: str, text: str) -> str:
    qn = norm(quote)[:120]
    for head, body in sections(text):
        if qn and qn[:60] in norm(body):
            return head
    return ""


NEUTRAL = {"unclear", "none stated", ""}


def ground(card: dict, policy_text: str) -> tuple[dict, dict]:
    """Check every quote against the policy. Returns (grounded card, report)."""
    pn = norm(policy_text)
    report = {}
    out = {}
    for f in FIELDS:
        fld = dict(card[f])
        val = fld.get("value")
        neutral = (not val) if isinstance(val, list) else (val in NEUTRAL)
        ok = quote_found(fld.get("quote", ""), pn) if fld.get("quote") else False
        report[f] = "ok" if ok else ("neutral" if neutral and not fld.get("quote") else "quote_not_found")
        if not ok:
            if f in ("scanning", "safe_harbour"):
                if val != "unclear":
                    fld["value"] = "unclear"  # never assert an unquoted yes/no/limited
            elif not neutral:
                fld["value"] = "unclear" if f != "excluded_classes" else fld["value"]
            fld["quote"] = ""
        else:
            real = section_of(fld["quote"], policy_text)
            if real:
                fld["section"] = real
        out[f] = fld
    return out, report


# ---------- extraction ----------

def _user_message(program_name: str, platform: str, text: str) -> str:
    return (f"Program: {program_name} ({platform}).\n\n<policy>\n{text}\n</policy>\n\n"
            "Call rules_card once. Quotes must be copied verbatim from inside <policy>.")


def extract(llm: LLM, program_name: str, platform: str, policy_text: str) -> tuple[dict | None, dict]:
    """Returns (grounded card or None, meta). Retries once with the validation error, then the fallback model."""
    meta = {"attempts": [], "grounding": None}
    user = _user_message(program_name, platform, policy_text)
    attempts = [(llm, None)]
    for i, (client, extra) in enumerate(attempts):
        try:
            args, m = client.tool_call(PROMPT, user, TOOL, effort="low", extra_messages=extra)
        except BudgetExceeded:
            raise
        except Exception as e:  # provider error -> fall back
            meta["attempts"].append({"model": client.model, "error": str(e)[:200]})
            if client.primary and i == len(attempts) - 1:
                attempts.append((LLM(cap_usd=client.cap, primary=False), None))
            continue
        meta["attempts"].append({k: m[k] for k in ("model", "latency_s", "usd", "input_tokens", "output_tokens")})
        try:
            card = RulesCard.model_validate(args or {}).model_dump()
        except ValidationError as e:
            err = str(e)[:1500]
            meta["attempts"][-1]["validation_error"] = err[:300]
            if extra is None:  # one retry with the error fed back
                fix = [{"role": "assistant", "content": "", "tool_calls": [{"id": m.get("call_id") or "call_0", "type": "function",
                        "function": {"name": "rules_card", "arguments": m.get("raw") or "{}"}}]},
                       {"role": "tool", "tool_call_id": m.get("call_id") or "call_0",
                        "content": f"Validation failed:\n{err}\nCall rules_card again with valid arguments."}]
                attempts.append((client, fix))
            elif client.primary:
                attempts.append((LLM(cap_usd=client.cap, primary=False), None))
            continue
        grounded, report = ground(card, policy_text)
        meta["grounding"] = report
        meta["model"] = client.model
        grounded["model"] = client.model
        grounded["extracted_at"] = int(time.time())
        return grounded, meta
    return None, meta
