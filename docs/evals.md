# Evals

All results are files in `evals/results/`, written by the scripts below, with the commit and date inside.
Regressions stay in the results (e.g. the first search config, extraction prompt v1/v2). Hold-out sets were never
used for tuning.

## Who labelled what
| Dataset | Size | Labelled by | Review |
|---|---|---|---|
| Rule extraction (`evals/data/extraction/labels/`) | 150 policies, 30 per platform (10 dev + 20 test each) | **agent-labelled**: 5 Claude Sonnet 5.5 subagents, first pass + a second careful pass (12 labels changed in pass 2) | Owner reviews 20 (list below) |
| Search queries (`evals/data/search/queries.json`) | 100 queries (30 dev, 70 test) | agent-written | — |
| Search judgments (`evals/data/search/judgments.json`) | 2,333 (query, program) pairs, pooled top-10 of 6 systems, graded 0–3 by `RUBRIC.md` | **agent-labelled** (5 Sonnet subagents) | Owner may spot-check |
| Agent conversations + adversarial policies (`evals/data/agent/`) | 50 + 15 | agent-written | — |

Policy texts are third-party content and aren't committed; `manifest.json` pins each by content hash and the
texts live in the pipeline cache / D1.

**For the owner to review (20 extraction labels, 4 per platform, chosen at random with seed 20261119):** see
`evals/data/extraction/REVIEW.md`.

## 1. Rule extraction — `python -m quarry_evals.extraction_eval --split test --tag v3`
- Metrics: per-field accuracy (enum fields exact; free-text fields judged as stated-vs-not / same number / header
  name present; excluded classes = recall ≥ 0.5 of the labelled classes by token overlap), **quote faithfulness**
  (raw model quotes found verbatim in the policy, before grounding), **wrong "scanning allowed"** (final card says
  yes/limited while the label says no/unclear), cost and latency.
- Tuning history on dev (50 policies): v1 mean 95.3%, 2 wrong-allowed (DoS ban and a required header read as
  "limited") → v2 (stricter prompt + code guard) 0 wrong-allowed but scanning accuracy 70% (over-corrected:
  "no high-traffic tools" read as unclear) → v3 (convention stated) 96.0%, 1 wrong-allowed. Stopped there.
- **Hold-out (100), v3, DeepSeek V4.1 Flash:** mean 96.1%; scanning 89%, rate limit 98%, required header 99%,
  test accounts 96%, excluded classes 96%, safe harbour 93%, bounty table 99%, disclosure 99%; quote faithfulness
  99.6% (533 quotes); **wrong "scanning allowed": 2** (target 0, missed — both "limited", never "yes"); $0.0025
  and 8.1 s p50 per policy. Files: `extraction_{dev,test}_primary_v*.json`, per-item rows in `items/`.

## 2. Search — `python -m quarry_evals.search_eval pool|score`, `python -m quarry_evals.search_tune`
- Systems re-implemented offline exactly as the Worker runs them (same FTS query builder and BM25 weights, same
  int8 scheme, same RRF and rerank blend). Corpus: 1,559 open programs.
- Pooling: top 10 of each of 6 systems → 2,333 judged pairs. Unjudged = 0, so recall@20 (grade ≥ 2) is a lower
  bound for every system.
- Fusion tuned on the 30 dev queries only (grid over RRF weights), test scored once. See README table and
  `search.json` (`tuning` block).

## 3. Recommendations (offline) — cut
Cut (cut order #3) to stay within the time budget: building a hunter → program history from public H1 disclosed
reports needs thousands of polite requests and a few hours of 1 req/s crawling. The ranking stays a transparent,
hand-weighted score (`ranking/weights.json`); feedback is logged in D1 (`feedback`) so a learning-to-rank model can be
trained once there are real users.

## 4. Agent — `python -m quarry_evals.agent_eval --tier primary|fallback`
End to end against the deployed Worker (`/api/chat`), with adversarial programs injected as admin-only fixtures (never stored or shown to users). Their rules cards come from the real extraction pipeline.

| Run | Conversations + adversarial | Correct tool calls | Grounding violations (final) | Hard-constraint violations | Injection success | Shortlist reached (mean turns) | Latency p50 | Errors |
|---|---|---|---|---|---|---|---|---|
| Primary v1 ([agent_primary_v1.json](evals/results/agent_primary_v1.json)) | 50+15 | 96.9% | 0 | 1 | 0 | 22/23 (1.05) | 18.5 s | 0 |
| **Primary v2, shipped** ([agent_primary.json](evals/results/agent_primary.json)) | 50+15 | 98.5% | 0 | 0 | 0 | 20/23 (1.1) | 18.5 s | 0 |
| Fallback Gemma 4 26B, subset ([agent_fallback.json](evals/results/agent_fallback.json)) | 10+10 | 91.7% | 0 | 0 | 0 | 9/10 (1.22) | 33.9 s | 0 |

Targets were 0 for grounding, hard-constraint and injection: all three are 0 for v2. The model's *first* drafts broke grounding 38 times; code caught them, regenerating 21 answers and trimming 11 (grounding.ts). v1 → v2 added the hard-constraint check to grounding and kept program ids in memory, after a v1 follow-up turn mixed up two programs with the same name. That fixed v1's one hard-constraint violation, but the stricter check trims more and shortlists dropped from 22/23 to 20/23. v2 re-ran the same conversations, not a hold-out set. Hard constraints are scored on each conversation's final turn, once the user has stated all of them; the first scoring checked every turn and counted 11 for v1, mostly turns that came before the constraint was stated (see agent_rescore.py). The fallback run is a 10-conversation subset: Workers AI neurons and its multi-minute turns ruled out the full set.

## 5. Operations
- Published by every build on `/status/` (`/data/status.json`): bbwatch lag at build time, pipeline success over the
  last 48 runs, rows written per day, pipeline LLM spend per day. Live LLM spend: `/api/status`.
- Quota drills (M6): `python -m quarry_evals.drills` → `drills.json`.

## 6. CI
- `evals-pr.yml`: PRs touching `prompts/`, `ranking/` or `rules.py` run a 20-item extraction subset and the agent
  smoke tests, and comment the before/after table.
- `evals-full.yml`: weekly full run, committed to `evals/results/`.
