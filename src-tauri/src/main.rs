#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

use std::{
  fs,
  path::Path,
  sync::Arc,
};

use anyhow::{anyhow, Context, Result};
use chrono::{DateTime, NaiveDateTime, NaiveTime, Utc};
use once_cell::sync::Lazy;
use parking_lot::Mutex;
use regex::Regex;
use rusqlite::{params, Connection, OptionalExtension, Transaction};
use serde::{Deserialize, Serialize};
use tauri::State;
use chrono_tz::America::Chicago;

static MULTISPACE_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"\s+").expect("valid regex"));
static AND_SPLIT_RE: Lazy<Regex> = Lazy::new(|| Regex::new(r"(?i)\s+and\s+").expect("valid regex"));

#[derive(Default, Clone)]
struct UndoStack {
  entries: Arc<Mutex<Vec<UndoAction>>>,
}

#[derive(Debug, Clone)]
enum UndoAction {
  CheckIn { checkin_id: i64 },
  CheckOut { checkin_id: i64 },
  ForcedCheckOut { checkin_id: i64 },
}

#[derive(Debug, Deserialize)]
struct CsvRow {
  #[serde(rename = "memberName")]
  member_name: Option<String>,
  #[serde(rename = "guestNames")]
  guest_names: Option<String>,
  #[serde(rename = "sourceRow")]
  source_row: Option<i64>,
  #[serde(rename = "checkIn")]
  check_in: Option<String>,
  #[serde(rename = "checkInTime")]
  check_in_time: Option<String>,
  #[serde(rename = "checkOut")]
  check_out: Option<String>,
  #[serde(rename = "checkOutTime")]
  check_out_time: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "lowercase")]
enum ImportMode {
  Replace,
  Append,
}

#[derive(Debug, Serialize)]
struct ImportSummary {
  inserted: usize,
  total_rows: usize,
}

#[derive(Debug, Serialize)]
struct GuestSearchResult {
  id: i64,
  display_name: String,
  member_host: Option<String>,
  is_checked_in: bool,
  has_history: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct MemberSearchResult {
  member_host: String,
  total_guests: i64,
  present_guests: i64,
}

#[derive(Debug, Serialize)]
struct ToggleResult {
  status: ToggleStatus,
}

#[derive(Debug)]
struct ToggleOutcome {
  result: ToggleResult,
  undo: Option<UndoAction>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum ToggleStatus {
  CheckedIn,
  CheckedOut,
  AlreadyIn,
  NotCheckedIn,
  NeverCheckedIn,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct StatsSummary {
  total_guests: i64,
  total_check_ins: i64,
  total_check_outs: i64,
  currently_present: i64,
  present_guests: Vec<PresentGuest>,
  top_hosts: Vec<HostSummary>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct PresentGuest {
  id: i64,
  display_name: String,
  member_host: Option<String>,
  in_ts: Option<String>,
  operator: Option<String>,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HostSummary {
  member_host: String,
  total_guests: i64,
  present_guests: i64,
}

#[derive(Debug, Serialize)]
struct UndoResult {
  status: UndoStatus,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "snake_case")]
enum UndoStatus {
  RevertedCheckIn,
  RevertedCheckOut,
  Empty,
}

#[tauri::command]
async fn init_db(db_path: String) -> Result<(), String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;
    Ok(())
  })
  .await
}

#[tauri::command]
async fn import_rows(
  db_path: String,
  rows: Vec<CsvRow>,
  mode: ImportMode,
) -> Result<ImportSummary, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let mut conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    let mut inserted = 0usize;

    let tx = conn.transaction()?;

    if let ImportMode::Replace = mode {
      tx.execute("DELETE FROM guests", [])?;
    }

    {
      let mut insert_stmt = tx.prepare(
        "INSERT INTO guests(display_name, member_host, source_row) VALUES (?1, ?2, ?3)"
      )?;
      let mut exists_stmt = tx.prepare(
        "SELECT id FROM guests WHERE lower(display_name) = lower(?1) AND (
          ( ?2 IS NULL AND member_host IS NULL ) OR lower(COALESCE(member_host, '')) = lower(COALESCE(?2, ''))
        )"
      )?;

      for row in rows.iter() {
        let check_in_flag = parse_import_flag(row.check_in.as_deref());
        let check_out_flag = parse_import_flag(row.check_out.as_deref());
        let check_in_time = parse_import_timestamp(row.check_in_time.as_deref());
        let check_out_time = parse_import_timestamp(row.check_out_time.as_deref());

        let host_clean = row.member_name.as_ref().map(|s| clean_whitespace(s));
        let host_ref = host_clean.as_deref();
        let names = row
          .guest_names
          .as_ref()
          .map(|s| split_guest_names(s))
          .unwrap_or_default();

        for name in names {
          let display = match name {
            Some(n) => n,
            None => continue,
          };

          let exists: Option<i64> = exists_stmt
            .query_row(params![display.as_str(), host_ref], |row| row.get(0))
            .optional()?;
          if exists.is_some() {
            continue;
          }

          insert_stmt.execute(params![display.as_str(), host_ref, row.source_row])?;
          inserted += 1;

          let guest_id = tx.last_insert_rowid();
          apply_import_history(
            &tx,
            guest_id,
            check_in_flag,
            check_out_flag,
            check_in_time.as_deref(),
            check_out_time.as_deref(),
          )?;
        }
      }
    }

    tx.commit()?;

    Ok(ImportSummary {
      inserted,
      total_rows: rows.len(),
    })
  })
  .await
}

#[tauri::command]
async fn search_guests(
  db_path: String,
  q: String,
  limit: Option<usize>,
) -> Result<Vec<GuestSearchResult>, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let lim = limit.unwrap_or(25).min(100) as i64;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    let query = q.trim();

    if query.is_empty() {
      return fetch_default_results(&conn, lim);
    }

    let tokens: Vec<String> = query
      .split_whitespace()
      .map(|t| clean_token(t))
      .filter(|t| !t.is_empty())
      .collect();

    if tokens.is_empty() {
      return fetch_default_results(&conn, lim);
    }

    let fts_query = tokens
      .iter()
      .map(|t| format!("display_name:\"{}*\"", fts_escape(t)))
      .collect::<Vec<_>>()
      .join(" AND ");

    let mut stmt = conn.prepare(
      "SELECT g.id, g.display_name, g.member_host,
        EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) as is_in,
        EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id) as has_history
       FROM guest_fts f
       JOIN guests g ON g.id = f.rowid
       WHERE guest_fts MATCH ?1
       ORDER BY bm25(guest_fts)
       LIMIT ?2"
    )?;

    let mut rows = stmt.query(params![fts_query, lim])?;
    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
      results.push(GuestSearchResult {
        id: row.get(0)?,
        display_name: row.get(1)?,
        member_host: row.get(2)?,
        is_checked_in: row.get::<_, i64>(3)? != 0,
        has_history: row.get::<_, i64>(4)? != 0,
      });
    }

    if results.is_empty() {
      let like = format!("%{}%", query.to_lowercase());
      let mut fallback = conn.prepare(
        "SELECT g.id, g.display_name, g.member_host,
          EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) as is_in,
          EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id) as has_history
         FROM guests g
         WHERE lower(g.display_name) LIKE ?1
         ORDER BY g.display_name
         LIMIT ?2"
      )?;

      let mut rows = fallback.query(params![like, lim])?;
      while let Some(row) = rows.next()? {
        results.push(GuestSearchResult {
          id: row.get(0)?,
          display_name: row.get(1)?,
          member_host: row.get(2)?,
          is_checked_in: row.get::<_, i64>(3)? != 0,
          has_history: row.get::<_, i64>(4)? != 0,
        });
      }
    }

    Ok(results)
  })
  .await
}

#[tauri::command]
async fn search_members(
  db_path: String,
  q: String,
  limit: Option<usize>,
) -> Result<Vec<MemberSearchResult>, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    let limit = limit.unwrap_or(25).min(200) as i64;
    let query = q.trim();
    let mut tokens: Vec<String> = query
      .split_whitespace()
      .map(|t| clean_token(t))
      .filter(|t| !t.is_empty())
      .collect();

    tokens.retain(|t| !t.is_empty());

    let mut sql = String::from(
      "SELECT g.member_host as host,
        COUNT(*) as total_guests,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) THEN 1 ELSE 0 END) as present_guests
       FROM guests g
       WHERE g.member_host IS NOT NULL AND g.member_host != ''"
    );

    for token in tokens.iter() {
      sql.push_str(" AND lower(g.member_host) LIKE '%");
      sql.push_str(token);
      sql.push_str("%'");
    }

    sql.push_str(
      " GROUP BY host
        ORDER BY present_guests DESC, total_guests DESC
        LIMIT ?1",
    );

    let mut stmt = conn.prepare(&sql)?;
    let mut rows = stmt.query([limit])?;
    let mut results = Vec::new();

    while let Some(row) = rows.next()? {
      let host: String = row.get(0)?;
      results.push(MemberSearchResult {
        member_host: host,
        total_guests: row.get(1)?,
        present_guests: row.get(2)?,
      });
    }

    Ok(results)
  })
  .await
}

#[tauri::command]
async fn guests_for_member(
  db_path: String,
  member_host: String,
) -> Result<Vec<GuestSearchResult>, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    if member_host.trim().is_empty() {
      return Ok(Vec::new());
    }

    let mut stmt = conn.prepare(
      "SELECT g.id, g.display_name, g.member_host,
        EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) as is_in,
        EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id) as has_history
       FROM guests g
       WHERE lower(g.member_host) = lower(?1)
       ORDER BY g.display_name",
    )?;

    let mut rows = stmt.query([member_host.trim()])?;
    let mut results = Vec::new();
    while let Some(row) = rows.next()? {
      results.push(GuestSearchResult {
        id: row.get(0)?,
        display_name: row.get(1)?,
        member_host: row.get(2)?,
        is_checked_in: row.get::<_, i64>(3)? != 0,
        has_history: row.get::<_, i64>(4)? != 0,
      });
    }

    Ok(results)
  })
  .await
}

#[tauri::command]
async fn toggle_checkin(
  db_path: String,
  guest_id: i64,
  action: String,
  operator: Option<String>,
  force: Option<bool>,
  state: State<'_, UndoStack>,
) -> Result<ToggleResult, String> {
  let action = action.to_lowercase();
  let operator_for_task = operator.clone();
  let force = force.unwrap_or(false);

  let outcome = run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    match action.as_str() {
      "in" => check_in(&conn, guest_id, operator_for_task.clone()),
      "out" => check_out(&conn, guest_id, operator_for_task.clone(), force),
      _ => Err(anyhow!("invalid action")),
    }
  })
  .await?;

  if let Some(undo_action) = outcome.undo {
    state.entries.lock().push(undo_action);
  }

  Ok(outcome.result)
}

#[tauri::command]
async fn undo_last(
  db_path: String,
  state: State<'_, UndoStack>,
) -> Result<UndoResult, String> {
  let action = {
    let mut entries = state.entries.lock();
    entries.pop()
  };

  let Some(action) = action else {
    return Ok(UndoResult {
      status: UndoStatus::Empty,
    });
  };

  let action_for_task = action.clone();

  match run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    match action_for_task {
      UndoAction::CheckIn { checkin_id } => {
        conn.execute("DELETE FROM checkins WHERE id = ?1", params![checkin_id])?;
        Ok(UndoResult {
          status: UndoStatus::RevertedCheckIn,
        })
      }
      UndoAction::CheckOut { checkin_id } => {
        conn.execute(
          "UPDATE checkins SET out_ts = NULL, out_by = NULL WHERE id = ?1",
          params![checkin_id],
        )?;
        Ok(UndoResult {
          status: UndoStatus::RevertedCheckOut,
        })
      }
      UndoAction::ForcedCheckOut { checkin_id } => {
        conn.execute("DELETE FROM checkins WHERE id = ?1", params![checkin_id])?;
        Ok(UndoResult {
          status: UndoStatus::RevertedCheckOut,
        })
      }
    }
  })
  .await
  {
    Ok(result) => Ok(result),
    Err(err) => {
      state.entries.lock().push(action);
      Err(err)
    }
  }
}

#[tauri::command]
async fn export_csv(db_path: String, out_dir: Option<String>) -> Result<String, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    let mut stmt = conn.prepare(
      "SELECT g.display_name, g.member_host,
        MAX(CASE WHEN c.out_ts IS NULL THEN 1 ELSE 0 END) AS in_status,
        MAX(c.in_ts) AS last_in,
        MAX(c.out_ts) AS last_out
      FROM guests g
      LEFT JOIN checkins c ON c.guest_id = g.id
      GROUP BY g.id
      ORDER BY g.display_name"
    )?;

    let mut rows = stmt.query([])?;

    let mut wtr = csv::Writer::from_writer(vec![]);
    wtr.write_record([
      "Member Name",
      "Guest Name",
      "Check In Y/N",
      "Check In Time",
      "Check Out Y/N",
      "Check Out Time",
    ])?;

    while let Some(row) = rows.next()? {
      let guest_name: String = row.get(0)?;
      let member_host: Option<String> = row.get(1)?;
      let is_in: i64 = row.get(2)?;
      let in_ts: Option<String> = row.get(3)?;
      let out_ts: Option<String> = row.get(4)?;

      let check_in_flag = if is_in == 1 || in_ts.is_some() {
        "Y"
      } else {
        "N"
      };
      let check_out_flag = if let Some(out) = &out_ts {
        if !out.is_empty() {
          "Y"
        } else {
          "N"
        }
      } else {
        "N"
      };

      wtr.write_record([
        member_host.clone().unwrap_or_default(),
        guest_name,
        check_in_flag.to_string(),
        in_ts.unwrap_or_default(),
        check_out_flag.to_string(),
        out_ts.unwrap_or_default(),
      ])?;
    }

    let data = wtr.into_inner()?;
    let output_dir = match out_dir {
      Some(dir) => dir,
      None => desktop_dir_path()?,
    };
    let file_path = Path::new(&output_dir).join(export_filename());
    if let Some(parent) = file_path.parent() {
      fs::create_dir_all(parent)?;
    }
    fs::write(&file_path, data)?;

    Ok(file_path
      .to_str()
      .ok_or_else(|| anyhow!("invalid utf-8 path"))?
      .to_string())
  })
  .await
}

#[tauri::command]
async fn stats_summary(db_path: String) -> Result<StatsSummary, String> {
  run_db_task(move || {
    ensure_db(&db_path)?;
    let conn = open_conn(&db_path)?;
    apply_schema(&conn)?;

    let total_guests: i64 = conn
      .query_row("SELECT COUNT(*) FROM guests", [], |row| row.get(0))
      .unwrap_or(0);

    let (total_check_ins, total_check_outs, _currently_present) = conn
      .query_row(
        "SELECT
          (SELECT COUNT(*) FROM checkins WHERE in_ts IS NOT NULL) as check_ins,
          (SELECT COUNT(*) FROM checkins WHERE out_ts IS NOT NULL) as check_outs,
          (SELECT COUNT(*) FROM checkins WHERE out_ts IS NULL) as present",
        [],
        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
      )
      .unwrap_or((0, 0, 0));

    let mut present_stmt = conn.prepare(
      "SELECT g.id, g.display_name, g.member_host, c.in_ts, c.in_by
       FROM checkins c
       JOIN guests g ON g.id = c.guest_id
       WHERE c.out_ts IS NULL
       ORDER BY c.in_ts DESC
       LIMIT 200",
    )?;
    let mut present_rows = present_stmt.query([])?;
    let mut present_guests = Vec::new();
    while let Some(row) = present_rows.next()? {
      present_guests.push(PresentGuest {
        id: row.get(0)?,
        display_name: row.get(1)?,
        member_host: row.get(2)?,
        in_ts: row.get(3)?,
        operator: row.get(4)?,
      });
    }

    let mut host_stmt = conn.prepare(
      "SELECT g.member_host as host,
        COUNT(*) as total_guests,
        SUM(CASE WHEN EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) THEN 1 ELSE 0 END) as present_guests
       FROM guests g
       WHERE g.member_host IS NOT NULL AND g.member_host != ''
       GROUP BY host
       ORDER BY present_guests DESC, total_guests DESC
       LIMIT 10",
    )?;
    let mut host_rows = host_stmt.query([])?;
    let mut top_hosts = Vec::new();
    while let Some(row) = host_rows.next()? {
      top_hosts.push(HostSummary {
        member_host: row.get(0)?,
        total_guests: row.get(1)?,
        present_guests: row.get(2)?,
      });
    }

    Ok(StatsSummary {
      total_guests,
      total_check_ins,
      total_check_outs,
      currently_present: present_guests.len() as i64,
      present_guests,
      top_hosts,
    })
  })
  .await
}

fn export_filename() -> String {
  let now = central_now();
  format!("party-sign-in-{}.csv", now.format("%Y%m%d-%H%M%S"))
}

fn desktop_dir_path() -> Result<String> {
  dirs::desktop_dir()
    .ok_or_else(|| anyhow!("desktop directory unavailable"))
    .and_then(|p| p.into_os_string().into_string().map_err(|_| anyhow!("invalid desktop path")))
}

fn check_in(
  conn: &Connection,
  guest_id: i64,
  operator: Option<String>,
) -> Result<ToggleOutcome> {
  let existing: Option<i64> = conn
    .query_row(
      "SELECT id FROM checkins WHERE guest_id = ?1 AND out_ts IS NULL",
      params![guest_id],
      |row| row.get(0),
    )
    .optional()?;

  if existing.is_some() {
    return Ok(ToggleOutcome {
      result: ToggleResult {
        status: ToggleStatus::AlreadyIn,
      },
      undo: None,
    });
  }

  let now = central_now_time_string();
  conn.execute(
    "INSERT INTO checkins (guest_id, in_ts, out_ts, in_by) VALUES (?1, ?2, NULL, ?3)",
    params![guest_id, now, operator],
  )?;
  let id = conn.last_insert_rowid();

  Ok(ToggleOutcome {
    result: ToggleResult {
      status: ToggleStatus::CheckedIn,
    },
    undo: Some(UndoAction::CheckIn { checkin_id: id }),
  })
}

fn check_out(
  conn: &Connection,
  guest_id: i64,
  operator: Option<String>,
  force: bool,
) -> Result<ToggleOutcome> {
  let existing: Option<(i64, Option<String>)> = conn
    .query_row(
      "SELECT id, out_ts FROM checkins WHERE guest_id = ?1 AND out_ts IS NULL ORDER BY in_ts DESC LIMIT 1",
      params![guest_id],
      |row| Ok((row.get(0)?, row.get(1)?)),
    )
    .optional()?;

  let Some((checkin_id, _)) = existing else {
    let ever_checked_in = conn
      .query_row(
        "SELECT 1 FROM checkins WHERE guest_id = ?1 LIMIT 1",
        params![guest_id],
        |_| Ok(()),
      )
      .optional()?
      .is_some();

    if force {
      let now = central_now_time_string();
      conn.execute(
        "INSERT INTO checkins (guest_id, in_ts, out_ts, in_by, out_by) VALUES (?1, ?2, ?3, ?4, ?5)",
        params![guest_id, now.clone(), now.clone(), operator.clone(), operator.clone()],
      )?;
      let id = conn.last_insert_rowid();
      return Ok(ToggleOutcome {
        result: ToggleResult {
          status: ToggleStatus::CheckedOut,
        },
        undo: Some(UndoAction::ForcedCheckOut {
          checkin_id: id,
        }),
      });
    }

    let status = if ever_checked_in {
      ToggleStatus::NotCheckedIn
    } else {
      ToggleStatus::NeverCheckedIn
    };

    return Ok(ToggleOutcome {
      result: ToggleResult { status },
      undo: None,
    });
  };

  let now = central_now_time_string();
  conn.execute(
    "UPDATE checkins SET out_ts = ?1, out_by = ?2 WHERE id = ?3",
    params![now, operator, checkin_id],
  )?;

  Ok(ToggleOutcome {
    result: ToggleResult {
      status: ToggleStatus::CheckedOut,
    },
    undo: Some(UndoAction::CheckOut { checkin_id }),
  })
}

fn fetch_default_results(conn: &Connection, limit: i64) -> Result<Vec<GuestSearchResult>> {
  let mut stmt = conn.prepare(
    "SELECT g.id, g.display_name, g.member_host,
      EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id AND c.out_ts IS NULL) as is_in,
      EXISTS(SELECT 1 FROM checkins c WHERE c.guest_id = g.id) as has_history
     FROM guests g
     ORDER BY g.display_name
     LIMIT ?1"
  )?;
  let mut rows = stmt.query([limit])?;
  let mut results = Vec::new();
  while let Some(row) = rows.next()? {
    results.push(GuestSearchResult {
      id: row.get(0)?,
      display_name: row.get(1)?,
      member_host: row.get(2)?,
      is_checked_in: row.get::<_, i64>(3)? != 0,
      has_history: row.get::<_, i64>(4)? != 0,
    });
  }
  Ok(results)
}

fn ensure_db(path: &str) -> Result<()> {
  let path = Path::new(path);
  if let Some(parent) = path.parent() {
    fs::create_dir_all(parent).with_context(|| format!("creating db parent {}", parent.display()))?;
  }
  Ok(())
}

fn open_conn(path: &str) -> Result<Connection> {
  let conn = Connection::open(path).with_context(|| format!("open db at {}", path))?;
  conn.pragma_update(None, "foreign_keys", &"ON")?;
  conn.pragma_update(None, "journal_mode", &"WAL")?;
  conn.pragma_update(None, "synchronous", &"NORMAL")?;
  Ok(conn)
}

fn apply_schema(conn: &Connection) -> Result<()> {
  conn.execute_batch(include_str!("../schema.sql"))?;
  Ok(())
}

fn split_guest_names(input: &str) -> Vec<Option<String>> {
  let replaced = AND_SPLIT_RE.replace_all(input, ",");
  let replaced = replaced.replace('&', ",");
  replaced
    .split(',')
    .map(|part| clean_name(part))
    .collect()
}

fn clean_name(value: &str) -> Option<String> {
  let trimmed = value.trim();
  if trimmed.is_empty() {
    return None;
  }
  let collapsed = MULTISPACE_RE.replace_all(trimmed, " ");
  let mut out = collapsed.to_string();
  if is_all_caps(&out) {
    out = out
      .split(' ')
      .map(|token| {
        if token.is_empty() {
          String::new()
        } else {
          let mut chars = token.chars();
          let first = chars.next().unwrap();
          first.to_uppercase().collect::<String>()
            + &chars.as_str().to_lowercase()
        }
      })
      .collect::<Vec<_>>()
      .join(" ");
  }
  Some(out)
}

fn clean_whitespace(value: &str) -> String {
  let trimmed = value.trim();
  MULTISPACE_RE.replace_all(trimmed, " ").to_string()
}

fn clean_token(token: &str) -> String {
  token
    .chars()
    .filter(|c| c.is_ascii_alphanumeric())
    .collect::<String>()
    .to_lowercase()
}

fn fts_escape(token: &str) -> String {
  token.replace('"', "\"\"")
}

fn is_all_caps(value: &str) -> bool {
  let letters: String = value.chars().filter(|c| c.is_alphabetic()).collect();
  !letters.is_empty() && letters.chars().all(|c| c.is_uppercase())
}

fn central_now() -> DateTime<chrono_tz::Tz> {
  Utc::now().with_timezone(&Chicago)
}

fn central_now_time_string() -> String {
  central_now().format("%I:%M:%S %p").to_string()
}

fn parse_import_flag(value: Option<&str>) -> bool {
  value
    .map(|v| v.trim().to_lowercase())
    .filter(|v| !v.is_empty())
    .map(|v| matches!(v.as_str(), "y" | "yes" | "true" | "1" | "checked" | "in"))
    .unwrap_or(false)
}

fn parse_import_timestamp(value: Option<&str>) -> Option<String> {
  let raw = value?.trim();
  if raw.is_empty() {
    return None;
  }

  const TIME_FORMATS: &[&str] = &[
    "%I:%M:%S %p",
    "%I:%M %p",
    "%H:%M:%S",
    "%H:%M",
    "%I%M%p",
    "%H%M%S",
  ];

  for fmt in TIME_FORMATS {
    if let Ok(time) = NaiveTime::parse_from_str(raw, fmt) {
      return Some(time.format("%I:%M:%S %p").to_string());
    }
  }

  const DATETIME_FORMATS: &[&str] = &[
    "%Y-%m-%d %H:%M:%S",
    "%Y-%m-%dT%H:%M:%S",
    "%m/%d/%Y %I:%M:%S %p",
    "%m/%d/%Y %I:%M %p",
    "%m/%d/%Y %H:%M:%S",
    "%m/%d/%Y %H:%M",
  ];

  for fmt in DATETIME_FORMATS {
    if let Ok(dt) = NaiveDateTime::parse_from_str(raw, fmt) {
      return Some(dt.time().format("%I:%M:%S %p").to_string());
    }
  }

  if let Ok(dt) = DateTime::parse_from_rfc3339(raw) {
    return Some(dt.with_timezone(&Chicago).format("%I:%M:%S %p").to_string());
  }

  None
}

fn apply_import_history(
  tx: &Transaction<'_>,
  guest_id: i64,
  check_in_flag: bool,
  check_out_flag: bool,
  check_in_time: Option<&str>,
  check_out_time: Option<&str>,
) -> Result<()> {
  if !(check_in_flag || check_out_flag || check_in_time.is_some() || check_out_time.is_some()) {
    return Ok(());
  }

  let mut in_ts = check_in_time.map(|s| s.to_string());
  if in_ts.is_none() && (check_in_flag || check_out_flag || check_out_time.is_some()) {
    in_ts = check_out_time.map(|s| s.to_string()).or_else(|| Some(central_now_time_string()));
  }

  let mut out_ts = None;
  if check_out_flag || check_out_time.is_some() {
    let base = check_out_time.or_else(|| in_ts.as_deref());
    let value = base.unwrap_or_else(|| {
      if let Some(ref ts) = in_ts {
        ts.as_str()
      } else {
        ""
      }
    });
    let formatted = if value.is_empty() {
      central_now_time_string()
    } else {
      value.to_string()
    };
    out_ts = Some(formatted);
  }

  let in_ts = in_ts.unwrap_or_else(central_now_time_string);
  let out_ts_value = out_ts.as_deref();
  let out_by_value = out_ts.as_ref().map(|_| "import");

  tx.execute(
    "INSERT INTO checkins (guest_id, in_ts, out_ts, in_by, out_by) VALUES (?1, ?2, ?3, ?4, ?5)",
    params![guest_id, in_ts, out_ts_value, "import", out_by_value],
  )?;

  Ok(())
}

async fn run_db_task<F, T>(f: F) -> Result<T, String>
where
  F: Send + 'static + FnOnce() -> Result<T>,
  T: Send + 'static,
{
  tauri::async_runtime::spawn_blocking(f)
    .await
    .map_err(|e| e.to_string())?
    .map_err(|e| e.to_string())
}

fn main() {
  tauri::Builder::default()
    .manage(UndoStack::default())
    .plugin(tauri_plugin_dialog::init())
    .plugin(tauri_plugin_fs::init())
    .invoke_handler(tauri::generate_handler![
      init_db,
      import_rows,
      search_guests,
      search_members,
      guests_for_member,
      toggle_checkin,
      undo_last,
      export_csv,
      stats_summary
    ])
    .run(tauri::generate_context!())
    .expect("error while running tauri application");
}
