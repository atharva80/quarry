# Search relevance rubric (0–3)

Judge each (query, program) pair from the program card only (name, platform, reward, categories, tags, scope sample).
Imagine a bug-bounty hunter typed the query into Quarry's search box looking for programs to hunt on.

| Grade | Meaning |
|---|---|
| 3 | Exactly what the query asks for: the program clearly matches every part of the query (e.g. "graphql api bounty" → a paying program whose scope lists a GraphQL endpoint or is described as a GraphQL API). |
| 2 | Clearly relevant: matches the main intent (e.g. "graphql api bounty" → a paying API program with no explicit GraphQL mention; "crypto exchange" → a crypto exchange). |
| 1 | Marginally related: shares a facet but not the intent (e.g. "crypto exchange" → a DeFi lending protocol; "android app paying over 5k" → an Android program paying $2k). |
| 0 | Not relevant. |

Rules:
- Use only what the card shows plus common knowledge of what a company is (e.g. "Uber" is ride sharing). Don't guess beyond that.
- Numeric constraints in the query (">5k", "50k") count: a program that misses them can be at most 1.
- Platform constraints ("on yeswehack") count: a program on another platform is 0.
- "new scope this week" / "live now" style queries: judge from the card's name/type only; grade 2 for contests or obviously fresh items, else 1 if otherwise on-topic. (Freshness isn't on the card, so these queries are noisy; they're kept to show it.)
- Labelled by Claude subagents ("agent-labelled"); the owner reviews a sample.
