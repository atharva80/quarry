import time

from quarry_pipeline import d1
from quarry_pipeline.normalize import is_placeholder, normalise, type_cat, usd
from quarry_pipeline.rules import ground, norm, quote_found
from quarry_pipeline.site import program_path

NOW = 1_795_000_000.0


def test_type_cat_and_usd():
    assert type_cat("url", "*.example.com") == "wildcard"
    assert type_cat("url", "https://etherscan.io/address/0xabc") == "contract"
    assert type_cat("other", "https://github.com/org/repo") == "code"
    assert type_cat("google_play_app_id", "com.x") == "android"
    assert usd("$55,000 USDC (plus 10k)") == 55000
    assert usd("€1,000") == 1080
    assert usd("¥300,000") == 1980
    assert is_placeholder("https://r2-p1.invalid") and not is_placeholder("api.example.com")


def _state():
    return {"sources": {"h1": {"programs": {
        "acme": {"name": "Acme", "state": "open", "bounty": True, "max": "$5,000", "url": "https://hackerone.com/acme",
                 "assets": {"wildcard|*.acme.com": [True, True, None], "url|old.acme.com": [False, False, None]},
                 "added": {"wildcard|*.acme.com": "2026-11-15T00:00:00Z"}},
        "fixture": {"name": "Fix", "state": "open", "assets": {"url|https://x.invalid": [True, True, None]}},
    }}, "issuehunt": {"programs": {"t": {"name": "[TEST-R2] HIJACK", "state": "open"}}}}}


def test_normalise_filters_fixtures_and_counts_fresh_scope():
    progs = normalise(_state(), None, NOW)
    assert [p["id"] for p in progs] == ["h1:acme"]
    p = progs[0]
    assert p["live"] and p["n_in_scope"] == 1 and p["n_out"] == 1 and p["max_usd"] == 5000
    assert p["new_7d"] == 1 and p["wild_new_30d"] == 1 and p["categories"] == ["wildcard"]


def test_planner_is_idempotent_and_deletes_gone_programs():
    progs = normalise(_state(), None, NOW)
    plan = d1.plan_program_upserts(progs, {}, NOW)
    assert plan.upserted == ["h1:acme"] and plan.fts_changed == 1
    cur = {p["id"]: (p["hash"], d1.diff_key(p)) for p in progs}
    assert d1.plan_program_upserts(progs, cur, NOW).statements == []
    cur["h1:gone"] = ("x", "x")
    plan3 = d1.plan_program_upserts(progs, cur, NOW)
    assert plan3.deleted == ["h1:gone"] and len(plan3.statements) == 3


def test_sql_quoting():
    assert d1.q("it's") == "'it''s'"
    assert d1.q(None) == "NULL" and d1.q(True) == "1" and d1.q(3) == "3"


POLICY = """## Policy

Please do **not** use automated scanners against our production systems.
Limit your testing to 5 requests per second.

## Safe harbor

We will not pursue legal action against researchers acting in good faith."""


def _card(scan_value, scan_quote):
    f = {"value": "none stated", "quote": "", "section": ""}
    return {"scanning": {"value": scan_value, "quote": scan_quote, "section": "Policy"},
            "rate_limit": {"value": "5 requests per second", "quote": "Limit your testing to 5 requests per second.", "section": "x"},
            "required_header": f, "test_accounts": f,
            "excluded_classes": {"value": [], "quote": "", "section": ""},
            "safe_harbour": {"value": "yes", "quote": "We will not pursue legal action against researchers", "section": "Policy"},
            "bounty_table": {"value": "unclear", "quote": "", "section": ""}, "disclosure": {"value": "unclear", "quote": "", "section": ""}}


def test_quote_check_ignores_markdown_and_downgrades_unquoted_claims():
    pn = norm(POLICY)
    assert quote_found("Please do not use automated scanners against our production systems.", pn)
    assert not quote_found("Automated scanners are allowed.", pn)
    card, rep = ground(_card("no", "do not use automated scanners"), POLICY)
    assert card["scanning"]["value"] == "no" and rep["scanning"] == "ok"
    assert card["safe_harbour"]["section"] == "Safe harbor"  # section fixed from the text
    # a fabricated permissive quote must not survive
    card, rep = ground(_card("yes", "Automated scanning is welcome."), POLICY)
    assert card["scanning"]["value"] == "unclear" and rep["scanning"] == "quote_not_found"


def test_program_paths_are_filesystem_safe():
    assert program_path("h1:gitlab") == ("/p/h1/gitlab/", "/data/p/h1/gitlab.json")
    page, js = program_path("cantina:Weird Handle/../x")
    assert ".." not in page and " " not in page and page.startswith("/p/cantina/")


def test_now_is_sane():
    assert NOW < time.time() + 10 * 365 * 86400
