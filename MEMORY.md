# MEMORY.md

## App Info
- Subdomain: rapid-gecko-8qb
- Repo: template/blank
- Created: 2026-07-01T13:54:49.581Z

## Architecture
(document key decisions here as you build)

## Known Issues
(none currently)

## Decisions
- API endpoints should return JSON errors for `/api/*` routes so the UI never dumps HTML into user-facing alerts.
- Use `POST` for folder and recipe update actions. `PATCH` is unreliable behind the app proxy and causes save regressions.
- Folder rename saves are supported over POST, PATCH, and PUT; the server binds to `0.0.0.0` and persists live recipe/folder state only to SQLite.
- Local smoke tests can set `DATA_DIR`, `DB_FILE`, `LEGACY_DATA_FILE`, and `UPLOADS_DIR` to isolate SQLite/import behavior from live-backed runtime files.
- `data.json` is legacy import input only. SQLite stores `legacy_json_import_status` so an old JSON file cannot re-seed records after the SQLite store has been initialized.
- Folder rename UI sends the new name in the query string with a bodyless `POST` to avoid mobile/proxy aborted JSON-body requests causing 502s.
- Express raw-body was replaced with a small JSON parser so aborted API requests log cleanly instead of dumping `BadRequestError: request aborted` stacks.

## Preferences
- Always list folders in alphabetical order when presenting directory listings to the user.

## How to Use Memory
- Update this file with important decisions, architecture choices, and lessons
- Daily logs go in `memory/2026-07-01.md` (create memory/ dir if needed)
- Use /compact if context gets long during a session
