-- Alerts: no new tables (uses `subscriptions`, see schema.sql). Row kinds: telegram-pending | telegram | discord | push | rss.
-- Index for token / chat-id / link-code lookups (feed requests, Telegram webhook).
CREATE INDEX IF NOT EXISTS subscriptions_kind_target ON subscriptions(kind, target);
