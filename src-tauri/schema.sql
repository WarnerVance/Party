BEGIN;

CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,
  member_host TEXT,
  source_row INTEGER,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  in_ts TEXT NOT NULL,
  out_ts TEXT,
  in_by TEXT,
  out_by TEXT
);

CREATE TABLE IF NOT EXISTS checkin_events (
  id INTEGER PRIMARY KEY,
  guest_id INTEGER NOT NULL,
  timestamp TEXT NOT NULL,
  action TEXT NOT NULL CHECK (action IN ('in', 'out'))
);

CREATE VIRTUAL TABLE IF NOT EXISTS guest_fts USING fts5(
  display_name,
  member_host,
  content='guests',
  content_rowid='id'
);

CREATE TRIGGER IF NOT EXISTS guests_ai AFTER INSERT ON guests BEGIN
  INSERT INTO guest_fts(rowid, display_name, member_host)
  VALUES (new.id, new.display_name, new.member_host);
END;

CREATE TRIGGER IF NOT EXISTS guests_ad AFTER DELETE ON guests BEGIN
  INSERT INTO guest_fts(guest_fts, rowid, display_name, member_host)
  VALUES('delete', old.id, old.display_name, old.member_host);
END;

CREATE TRIGGER IF NOT EXISTS guests_au AFTER UPDATE ON guests BEGIN
  INSERT INTO guest_fts(guest_fts, rowid, display_name, member_host)
  VALUES('delete', old.id, old.display_name, old.member_host);
  INSERT INTO guest_fts(rowid, display_name, member_host)
  VALUES (new.id, new.display_name, new.member_host);
END;

COMMIT;
