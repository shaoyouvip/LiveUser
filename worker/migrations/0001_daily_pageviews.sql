-- Stores one aggregate page view counter per site and day.
CREATE TABLE IF NOT EXISTS daily_pageviews (
    site_id TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    pv INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    PRIMARY KEY (site_id, visit_date)
) WITHOUT ROWID;

CREATE INDEX IF NOT EXISTS idx_daily_pageviews_date
    ON daily_pageviews (visit_date);
