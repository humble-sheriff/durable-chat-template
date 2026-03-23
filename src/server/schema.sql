CREATE TABLE IF NOT EXISTS players (
  username TEXT PRIMARY KEY,
  konami_id TEXT NOT NULL,
  university TEXT DEFAULT '',
  instagram TEXT DEFAULT '',
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);
