-- Quarry D1 schema. D1 holds only what the Worker has to *query*; full scopes live in static per-program
-- JSON (free to serve). See docs/decisions.md "D1 layout" for the measured write cost of each layout.

CREATE TABLE IF NOT EXISTS programs (
  id TEXT PRIMARY KEY,
  platform TEXT NOT NULL,
  name TEXT NOT NULL,
  url TEXT,
  state TEXT NOT NULL,
  live INTEGER NOT NULL,
  bounty INTEGER NOT NULL,
  contest INTEGER NOT NULL,
  reward_min TEXT,
  reward_max TEXT,
  max_usd INTEGER NOT NULL DEFAULT 0,
  listed_at INTEGER,
  updated_at INTEGER,
  scope_changed_at INTEGER,
  categories TEXT,            -- space-separated
  tags TEXT,                  -- JSON array
  n_in_scope INTEGER,
  n_paid INTEGER,
  new_7d INTEGER,
  new_14d INTEGER,
  new_30d INTEGER,
  wild_new_30d INTEGER,
  latest_added_at INTEGER,
  hash TEXT NOT NULL,         -- content hash from the pipeline (normalize.content_hash)
  rules TEXT,                 -- validated RulesCard JSON, or NULL
  rules_hash TEXT
) WITHOUT ROWID;

-- In-scope assets added in the last 90 days (what "what's new" and freshness need). Older scope: static JSON.
CREATE TABLE IF NOT EXISTS recent_assets (
  program_id TEXT NOT NULL,
  ident TEXT NOT NULL,
  cat TEXT,
  paid INTEGER,
  added_at INTEGER NOT NULL,
  PRIMARY KEY (program_id, ident)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS recent_assets_added ON recent_assets(added_at);

CREATE VIRTUAL TABLE IF NOT EXISTS programs_fts USING fts5(
  id UNINDEXED, name, body, tokenize = 'unicode61 remove_diacritics 2'
);

CREATE TABLE IF NOT EXISTS changes (
  id TEXT PRIMARY KEY,
  ts INTEGER NOT NULL,
  kind TEXT NOT NULL,
  prio INTEGER,
  program_id TEXT,
  title TEXT,
  body TEXT,
  summary TEXT
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS changes_ts ON changes(ts);

CREATE TABLE IF NOT EXISTS policies (
  program_id TEXT PRIMARY KEY,
  source_url TEXT,
  fetched_at INTEGER,
  version TEXT,               -- platform version id / etag / content hash
  hash TEXT NOT NULL,
  program_hash TEXT,          -- the program's content hash when this policy was fetched
  text TEXT NOT NULL          -- normalised markdown, untrusted third-party text
);

CREATE TABLE IF NOT EXISTS embeddings (
  program_id TEXT PRIMARY KEY,
  model TEXT NOT NULL,
  text_hash TEXT NOT NULL,
  vec TEXT NOT NULL           -- base64 float16 (pipeline-side cache; the Worker reads the static int8 matrix)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS subscriptions (
  id TEXT PRIMARY KEY,        -- random
  user_id TEXT NOT NULL,
  kind TEXT NOT NULL,         -- telegram | discord | push | rss
  target TEXT NOT NULL,       -- chat id / webhook url / push subscription JSON / feed token
  profile TEXT,               -- JSON profile snapshot used for filtering
  created_at INTEGER NOT NULL,
  last_sent_at INTEGER,
  failures INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS subscriptions_user ON subscriptions(user_id);

CREATE TABLE IF NOT EXISTS feedback (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id TEXT NOT NULL,
  program_id TEXT NOT NULL,
  action TEXT NOT NULL,       -- save | dismiss | click
  reason TEXT,
  ts INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS metrics (
  day TEXT NOT NULL,
  k TEXT NOT NULL,
  v REAL NOT NULL,
  PRIMARY KEY (day, k)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS meta (
  k TEXT PRIMARY KEY,
  v TEXT
) WITHOUT ROWID;
