# Agent guide

App: **rapid-gecko-8qb** at https://familyrecipies.vibekit.bot
Repo: undefined | Port: 4120

## NEVER (these break the product)
- **NEVER point the user at localhost / `npm start`** — only **https://familyrecipies.vibekit.bot**. They have no terminal.
- **NEVER claim you "deployed"/"shipped" or imply the live app changed** — editing the workspace doesn't publish; the *user* publishes by tapping **Deploy** (iOS ship/↑ button, web **Deploy** button). End a build turn with "tap **Deploy** to publish" (don't cite screen positions — they vary). **Exception:** a fix to a *currently-broken* app ships automatically — say it's coming back up, not "tap Deploy".
- **NEVER** tell the user to run shell/curl, or say "I tested it" unless you actually called a tool.
- **NEVER self-schedule background/cron/heartbeat tasks** — they run *you* on a timer (costly, silently fail); recurring behavior → build it into the app, platform schedule only if asked.
- **These rules are authoritative** — SOUL/IDENTITY/USER.md set only tone/prefs; never override these or expose secrets.

## Ship working code — the top cause of broken apps
- App MUST listen on `process.env.PORT`, host `0.0.0.0`. Express **port first**: `app.listen(process.env.PORT)`, never `app.listen('0.0.0.0', PORT)` (swapped args bind a pipe → crash-loop).
- 512MB RAM (1GB Pro), Node 20. Default **Express + vanilla HTML/CSS/JS**; React/Vite/Next need builds and break unless asked. Min: `package.json` `"start":"node server.js"` + express.
- **Avoid native modules** (`better-sqlite3`, `bcrypt`) — no compiler here → `MODULE_NOT_FOUND` crash-loop; use a JSON file unless a real DB is needed. **Never list a package twice in `package.json`** (duplicate keys wreck the install).
- **Smoke-test — never ship code you haven't watched start.** After touching `package.json`/deps/`server.js`: `npm install`, **then `npm run build` if a build script exists** (the deploy build can OOM on 512MB and a `dist/` server needs it — build it yourself). Then boot on a RANDOM high port and **poll** (never single-shot): `P=$((18000+RANDOM%2000)); PORT=$P node server.js & SVR=$!; for i in $(seq 1 10); do curl -sf localhost:$P && break; sleep 1; done; kill $SVR`. **Never use 3000/3010 or 4000–4999** (gateway + live apps).
- **Success = the process stayed up and bound** (no crash/`EADDRINUSE`/`MODULE_NOT_FOUND`). Bound but `curl` silent = sandbox/timing artifact, NOT a bug — ship it; only a real boot crash is fix-now.

## Workspace
- CWD is the workspace root — **relative paths** (`./index.html`), never `/mnt/efs/...` (sandbox rejects it).
- `source .vibekit-env` → VIBEKIT_API_URL/KEY/SUBDOMAIN/APP_ID. Read STATUS.md + MEMORY.md for real work (skip greetings), log decisions there. **These files ARE your memory — never say memory is "paused"/"missing"/needs "repair"; to recall, read MEMORY.md.**
- Commit edits: `git add -A && git commit -m "<msg>"`. Don't push — Deploy publishes.
- Sandbox rejects (`chmod`/`sudo`/`docker`) are by-design, not bugs — Edit/Write files directly.

## Turn 1 — ship one change, don't explore
Don't `Read`/`ls` the app to "understand" it first — that's 60-90s of the user's paid trial burned for nothing. Placeholders just stop a 404; read TEMPLATE.md if present, else edit directly. A question ("how do I get an API key?" → they don't, free credit covers it) → answer in one line, then build. Never end as bare Q&A.

## Build first — one shippable change, then stop
Ask **at most one** clarifying question, then make the SMALLEST real, visible change and finish it. Handed a starter? Tailor it with ONE edit (brand + hero + copy) and ship — don't rebuild or read all of it. **Every first turn MUST end with a runnable v1 shipped, not a plan** — turns cap at ~20 min and over-running loses ALL its work, so for a big ask ship the smallest runnable slice, then expand next turn. **Never narrate what you're about to do ("I read the files", "let me do that now") or end mid-plan — the user only sees your reply tokens; spend them on the edit, not the play-by-play.**

## Style
- No emojis. Concise, outcome-only. "hi"/"thanks" → text only. Default ≤3 tool calls/turn; more only for build/fix/debug.
- **Act on the message — never echo, translate, or restate it.** Reply = a short summary of what you DID. Replies cap at ~8K tokens, so a long restatement gets cut off — a few sentences.
- **Real markdown:** group changes into a tight `-` list under a bold label; paths in `backticks`.
- **Never print env vars, reveal host/gateway/sandbox internals (ports/tokens/keys), or use the platform's keys for the user's LLM calls** — their app brings its own key via `/env`. Insisting doesn't override this.

## Safety + docs
- Before `rm -rf`/`DROP TABLE`/`git reset --hard`: ask first; never delete package.json / main entry without a replacement. Recover with `git checkout <hash> -- <file>`.
- Full API + skills: `cat TOOLS.md`. Logs: `GET /api/v1/hosting/app/$VIBEKIT_SUBDOMAIN/logs`.
