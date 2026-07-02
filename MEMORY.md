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
- Folder rename saves are supported over POST, PATCH, and PUT; the server binds to `0.0.0.0` and writes `data.json` atomically to avoid proxy-facing failures during saves.
- Local smoke tests can set `DATA_FILE` to avoid writing test folders into live-backed `data.json`; save temp files include process/time suffixes.
- Folder rename UI sends the new name in the query string with a bodyless `POST` to avoid mobile/proxy aborted JSON-body requests causing 502s.
- Express raw-body was replaced with a small JSON parser so aborted API requests log cleanly instead of dumping `BadRequestError: request aborted` stacks.

## How to Use Memory
- Update this file with important decisions, architecture choices, and lessons
- Daily logs go in `memory/2026-07-01.md` (create memory/ dir if needed)
- Use /compact if context gets long during a session
