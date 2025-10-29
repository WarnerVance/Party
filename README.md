# Party Sign-In

Offline-first desktop sign-in tool focused on lightning-fast name search, keyboard operation, and resilient local storage.

## Stack

- [Tauri 2 beta](https://tauri.app/) shell
- React + Vite + Tailwind UI
- SQLite (rusqlite) with FTS5 full-text search

## Getting Started

1. **Install prerequisites**
   - Rust toolchain (`rustup`)
   - Node.js (LTS) + npm
   - Tauri v2 CLI (`npm install --global @tauri-apps/cli@beta`)

2. **Install dependencies**

   ```bash
   npm install
   ```

3. **Run the desktop app in dev mode**

   ```bash
   npm run tauri dev
   ```

   The dev shell launches Vite (UI hot reload) alongside Tauri.

4. **Build installers**

   ```bash
   npm run tauri build
   ```

   Bundled artifacts (macOS `.dmg`, Windows `.msi`) will appear under `src-tauri/target/release/bundle`.

## Core Flows

- **Import CSV**: Click *Import CSV*, choose the file, then pick *Replace event* (clears all guests/check-ins) or *Append only new names*. Import summary confirms how many guests were added.
- **Search & check-in**: Cursor stays in the search box. Type, use ↑/↓ to highlight, press `Enter` to check in or `Shift+Enter` to check out.
- **Undo**: `Ctrl+Z` / `Cmd+Z` or the *Undo* button reverts the last check-in/out.
- **Export CSV**: Writes the latest event snapshot to a timestamped file on the Desktop (unless overridden by backend args).

## Data & Storage

- Database lives at the OS app-data directory (e.g. `~/Library/Application Support/PartySignIn/app.db` on macOS).
- Schema is defined in `src-tauri/schema.sql` and applied automatically on launch.
- `import_rows` deduplicates by `display_name + member_host` (case-insensitive) when appending.
- Full-text search uses FTS5 with LIKE fallback for typo-heavy queries.

## Keyboard Reference

| Action | Shortcut |
| --- | --- |
| Check in highlighted guest | `Enter` |
| Check out highlighted guest | `Shift+Enter` |
| Move selection | `↑` / `↓` |
| Undo last toggle | `Ctrl+Z` / `Cmd+Z` |

## Project Structure

```
/ (workspace)
├── index.html
├── package.json
├── src
│   ├── App.tsx
│   ├── main.tsx
│   ├── styles.css
│   └── vite-env.d.ts
├── src-tauri
│   ├── Cargo.toml
│   ├── build.rs
│   ├── schema.sql
│   ├── src
│   │   └── main.rs
│   └── tauri.conf.json
└── Spec.md (product spec)
```

## Testing Ideas

- Use sample rows in `Spec.md` to confirm import splitting (`John Smith, Mary Jones & Alex Wu`).
- With ~5k rows, ensure search latency stays sub-100ms (profiling via `EXPLAIN QUERY PLAN` if needed).
- Validate CSV export by re-importing into a spreadsheet and checking flags.

## Next Steps

- Add walk-in guest creation (UI + backend command).
- Consider persisted undo history per session.
- Enable auto-update once release pipeline is ready.
