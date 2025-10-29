Got it. Here’s a tight, developer-ready spec you can hand to Codex to build the **name-search party sign-in desktop app** from your spreadsheet (no QR).

---

# Party Sign-In Desktop App — Product & Technical Specification

## 1) Summary

A desktop application for fast, reliable **guest name search** and **check-in/out** at events. It imports a CSV in the format you currently use (columns include `Guest Names`, `Member Name`, etc.), splits multi-guest cells into individual records, and enables keyboard-first operations (type → select → Enter).

**Primary goals**

* Blazing-fast fuzzy name search (works with typos/partials).
* One-keystroke check-in; easy check-out and undo.
* Runs fully offline; durable local storage.
* CSV import/export compatible with the current sheet.

**Non-goals (v1)**

* QR codes or ticket scanning.
* Multi-venue sync or live cloud dashboards.
* Badge/label printing.

---

## 2) Target Users & Platforms

* **Door staff** with minimal training; prefer keyboard over mouse.
* **OS:** Windows 10+ and macOS 12+. (Linux nice-to-have.)

---

## 3) Architecture & Stack

* **Shell:** Tauri
* **UI:** React + Vite + Tailwind (or simple CSS)
* **Local DB:** SQLite with **FTS5** for full-text search
* **IPC:** Tauri commands for DB + file system
* **Packaging:** Tauri Bundler → `.msi` (Win) and `.dmg` (macOS)
* **Auto-update:** Optional; ship disabled by default in v1

---

## 4) Data Model

### 4.1 Tables

```sql
-- Guests derived from CSV (one row per person)
CREATE TABLE IF NOT EXISTS guests (
  id INTEGER PRIMARY KEY,
  display_name TEXT NOT NULL,         -- e.g., "Jane Doe"
  member_host TEXT,                   -- from "Member Name", nullable
  source_row INTEGER,                 -- original CSV row number (optional)
  created_at TEXT DEFAULT (datetime('now'))
);

-- Check-ins for the current event (one open row per guest when in)
CREATE TABLE IF NOT EXISTS checkins (
  id INTEGER PRIMARY KEY,
  guest_id INTEGER NOT NULL REFERENCES guests(id) ON DELETE CASCADE,
  in_ts  TEXT,                        -- ISO8601
  out_ts TEXT,                        -- ISO8601
  in_by  TEXT,                        -- operator/device id
  out_by TEXT
);

-- Full-text search index over names/hosts
CREATE VIRTUAL TABLE IF NOT EXISTS guest_fts USING fts5(
  display_name, member_host, content='guests', content_rowid='id'
);

-- Triggers to keep FTS in sync
-- (AI/AD/AU insert/update/delete triggers, as standard for FTS5)
```

### 4.2 CSV → DB Mapping

* **Input columns present in current sheet:**
  `Member Name`, `Guest Names`, `Check In Y/N`, `Check In Time`, `Check Out Y/N`, `Check Out Time`, `[Unnamed columns]`, `Sober Monitors`.
* **Import rules:**

  * Use only `Guest Names` and `Member Name`.
  * Split `Guest Names` into individual guests by **comma**, **ampersand (&)**, and **“ and ”** (with spaces).
  * Trim whitespace; collapse internal multiple spaces; preserve capitalization but title-case if a token is all-caps.
  * Ignore blank results.
  * Set each guest’s `member_host` from the row’s `Member Name` (trimmed; may be empty/null).
  * Store `source_row` for traceability.
* **Re-import behavior (idempotence):**

  * Provide a modal with two choices:

    1. **Replace** (wipe `guests` and `checkins` then reimport).
    2. **Append** (add only new names not already present by exact case-insensitive match on `display_name` + `member_host`).

---

## 5) Search Behavior (FTS)

* Tokenize on spaces and punctuation; **prefix match** each typed token:

  * User query `"jan sm"` → FTS query: `jan* sm*`
* Show top 25 results ranked by FTS.
* **Fuzzy tolerance (typos):** Use FTS5 + fallback substring LIKE if FTS returns 0 rows (for near-misses).
* Highlight matched tokens in UI (optional).

---

## 6) Core User Flows

### 6.1 Import CSV (one-time per event)

1. User clicks **Import CSV** and picks the file.
2. App parses, splits guest lists, inserts guests, builds FTS.
3. Show summary: “Imported 500 rows → 732 guests” (example).

### 6.2 Search & Check-In (keyboard-first)

* Focus is always in the search box.
* Type → results list updates live.
* **Arrow Up/Down** to select, **Enter** to check in the highlighted guest.
* On check-in:

  * Insert a `checkins` row with `in_ts=now`, `in_by=<operator>`.
  * UI shows a **green toast** (“Checked in: Jane Doe”).
  * Clear the search box.

### 6.3 Check-Out

* Select the same guest (search) → press **Shift+Enter** (or click “Check-out”).
* Update the latest open `checkins` row for that `guest_id` with `out_ts=now`, `out_by=<operator>`.
* Gray toast (“Checked out: Jane Doe”).

### 6.4 Undo (last action)

* **Ctrl+Z** (Cmd+Z on macOS) reverts the last check-in/out for the session:

  * If last action was check-in, delete that `checkins` row.
  * If last action was check-out, set `out_ts=NULL, out_by=NULL`.

### 6.5 Walk-In (not on the list)

* **Alt+N** opens a minimal dialog:

  * `Name` (required), `Member Host` (optional).
  * On save: add to `guests`, index in FTS, immediately check in.

### 6.6 Export (end of night)

* **Export CSV** with:

  * `display_name`, `member_host`, `checked_in` (Y/N), `in_ts`, `out_ts`.
* File named `checkins-YYYYMMDD-HHmm.csv`.

---

## 7) UI Requirements

### 7.1 Main Screen (wireframe)

```
+-----------------------------------------------------+
|  Search: [__________________________] (auto-focus)  |
|                                                     |
|  Results (top 25):                                  |
|  > Jane Doe                Host: Alice Johnson      |
|    John Smyth              Host: -                  |
|    ...                                            v |
|                                                     |
|  [Enter] Check-in   [Shift+Enter] Check-out         |
|  [Alt+N] Walk-in    [Ctrl/Cmd+Z] Undo               |
+-----------------------------------------------------+
Status bar: Imported 732 guests • Checked in: 418 • Out: 57
```

### 7.2 Toasters/Feedback

* Success/Warning/Error toasts in lower-right.
* Never block the search field focus.

### 7.3 Accessibility

* Full keyboard nav, visible focus states.
* Large font mode toggle.
* High-contrast theme toggle.

---

## 8) Performance & Reliability (NFRs)

* **Cold start:** < 2s on mid-range laptop.
* **Search latency:** < 100ms for 10k guests.
* **Import 1k sheet rows:** < 5s.
* **Crash safety:** DB writes wrapped in transactions; no partial imports.
* **Offline-first:** No network dependencies.

---

## 9) Security & Storage

* DB file stored in OS app-data dir:

  * Windows: `%APPDATA%\PartySignIn\app.db`
  * macOS: `~/Library/Application Support/PartySignIn/app.db`
* No PII beyond names/hosts/timestamps.
* Optional password to open the app (v2).

---

## 10) Configuration

* **Operator ID** (string shown in `in_by/out_by`), stored locally.
* **Import split delimiters:** default `,`, `&`, `" and "`.
* **Export location:** default to Desktop.

---

## 11) Error Handling & Edge Cases

* **Duplicate names:** allow multiple rows; show `(Host: X)` to disambiguate.
* **Zero search results:** show “No matches” and a **Walk-In** hint.
* **Multiple check-ins:** if a guest is already “in” (open record), Enter does nothing and shows “Already checked in”; use check-out first.
* **Clock/timezone:** timestamps in local time, ISO format; no TZ math required.

---

## 12) QA / Acceptance Criteria

**Import**

* Given a CSV row `Guest Names = "John Smith, Mary Jones & Alex Wu"`, `Member Name = "Chris Park"`, the app creates **3** guests with `member_host = "Chris Park"`.
* Blank or whitespace-only names are ignored.
* Re-import with “Replace” yields the same guest count deterministically.

**Search**

* Typing `"jan sm"` surfaces **“Jane Smith”** in top results.
* Typo `"jnae smi"` returns results via LIKE fallback.

**Check-in/out**

* Enter on a highlighted guest creates a `checkins` row with non-null `in_ts`.
* Shift+Enter sets `out_ts` on that row.
* Undo reverts the last action accurately.

**Export**

* The export contains the correct flags/timestamps for all checked-in/out guests.

**Performance**

* With 5k guests, first keystroke renders results in <100ms on a 2019 laptop.

---

## 13) Deliverables

1. Tauri project with:

   * `schema.sql` (tables + FTS + triggers)
   * IPC commands: `init_db`, `import_rows`, `search_guests`, `toggle_checkin`, `export_csv`, `undo_last`
2. React UI:

   * Main screen per wireframe; keyboard shortcuts implemented.
   * Import & Export dialogs.
3. Build scripts for `.msi` and `.dmg`.
4. README with operator quick-start.

---

## 14) IPC Command Contracts (Tauri)

```ts
// init the DB (runs schema.sql if missing)
invoke<void>("init_db", { dbPath: string });

// bulk import rows (already parsed on the frontend)
type CsvRow = { memberName?: string; guestNames?: string; sourceRow?: number };
invoke<number>("import_rows", { dbPath: string, rows: CsvRow[], mode: "replace" | "append" });

// search with prefix tokens; returns [id, displayName, memberHost]
invoke<Array<[number,string,(string|null)]>>("search_guests", {
  dbPath: string, q: string, limit: number
});

// check-in or check-out
invoke<void>("toggle_checkin", {
  dbPath: string, guestId: number, action: "in" | "out", operator: string
});

// undo last action (in current session)
invoke<void>("undo_last", { dbPath: string });

// export current state to CSV; returns absolute filepath
invoke<string>("export_csv", { dbPath: string, outDir?: string });
```

---

## 15) Example CSV Snippet (input)

```csv
Member Name,Guest Names,Check In Y/N,Check In Time,Check Out Y/N,Check Out Time
Alice Johnson,"Jane Doe, John Smyth & Alex Wu",,,,
,Chris Miller,,,,
Ben Carter,"Eva-Louise Anders",,,,
```

**Expected import:** `Jane Doe`, `John Smyth`, `Alex Wu` (host: `Alice Johnson`); `Chris Miller` (host empty); `Eva-Louise Anders` (host: `Ben Carter`).

---

## 16) Future Enhancements (post-v1)

* Multi-event support (separate event files).
* Cloud sync / shared device merge.
* Label/badge printing (DYMO/Zebra).
* Role-based access & audit exports.
* Basic analytics (check-ins per minute, capacity).

---

### Notes to the implementer

* Prefer **FTS5** over pure LIKE for large lists; keep a LIKE fallback for single-letter or typo-heavy queries.
* Wrap imports and exports in transactions and guard rails.
* Maintain keyboard focus in the search field after every action.

---

If you want this adapted for **.NET (WPF/WinUI + EF Core + SQLite)** instead of Tauri/React, the same data model and flows apply; swap FTS with `FTS5` via SQLite provider and replicate the shortcuts.