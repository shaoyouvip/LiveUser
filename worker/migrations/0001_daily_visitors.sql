-- Stores only a daily HMAC digest, never the browser's raw visitorId.
CREATE TABLE IF NOT EXISTS daily_visitors (
    site_id TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    visitor_key TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (site_id, visit_date, visitor_key)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_visitors_date
    ON daily_visitors (visit_date);
