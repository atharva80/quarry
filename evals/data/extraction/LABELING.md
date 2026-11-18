# Rule-extraction labels: guide

Labels are **agent-labelled** (Claude Sonnet 5.5 subagents, first pass + a second careful pass by the same
labeller re-reading the policy), and a human (the repo owner) reviews a random sample of 20. Labels are made
from the policy text alone, never from model outputs.

One label per policy, for these fields. Read the WHOLE policy text (all `## ` sections).

| Field | Label values | Rule |
|---|---|---|
| `scanning` | `yes` / `no` / `limited` / `unclear` | `yes` = explicitly allows automated scanners/tools with no meaningful limit. `limited` = allowed with restrictions (rate cap, specific tools only, "keep to a minimum", only with a header, only on some assets). `no` = prohibits automated scanning/scanners/tools (a ban on "automated testing" or "mass scanning" counts). `unclear` = not addressed, ambiguous, or contradictory. A rate limit alone without saying tools are allowed → `limited`. A ban on DoS/brute force alone (no word on scanners) → `unclear`. |
| `rate_limit` | e.g. `5/s`, `10/min`, or `none` | An explicit numeric request-rate cap. Normalise to `<n>/s` or `<n>/min` or `<n>/h`. `none` if no number is given. |
| `required_header` | header name lowercased, e.g. `x-hackerone`, `user-agent`, or `none` | An HTTP header or User-Agent the researcher must send while testing. Use the header *name* only. If both a UA and a header are required, give the custom header. |
| `test_accounts` | `stated` / `none` | `stated` if the policy says anything about how to get/create/use test accounts (email alias, "only use your own accounts", "request test accounts", provided credentials). |
| `excluded_classes` | list of short class names | Vulnerability classes the program says are out of scope / not accepted / non-qualifying. Up to 15, short canonical names (e.g. `self-xss`, `clickjacking`, `missing security headers`, `rate limiting`, `csrf on logout`, `dos`, `social engineering`, `spf/dmarc`, `open redirect`, `tabnabbing`, `version disclosure`). `[]` if none listed. |
| `safe_harbour` | `yes` / `no` / `unclear` | `yes` if the policy text contains a safe-harbour / legal-protection / "we won't pursue legal action" commitment for good-faith research (including "Gold Standard Safe Harbor" or "Safe harbor: Status: …" lines that indicate it applies). `no` if it explicitly refuses one or says partial/none. Otherwise `unclear`. |
| `bounty_table` | `stated` / `vdp` / `unclear` | `stated` if reward amounts by severity/priority are given. `vdp` if the program says it pays no bounty. Else `unclear`. |
| `disclosure` | `stated` / `unclear` | `stated` if the policy says anything about public disclosure (forbidden, allowed after fix, coordinated, needs permission). |

Also record `notes` (≤ 1 sentence) for anything ambiguous, and `confidence` per policy: `high` or `low`.

Output: a JSON list, one object per policy:
`{"program_id", "hash", "labels": {scanning, rate_limit, required_header, test_accounts, excluded_classes, safe_harbour, bounty_table, disclosure}, "evidence": {"scanning": "<verbatim quote or ''>"}, "confidence", "notes", "second_pass_changed": [field names changed in pass 2]}`
