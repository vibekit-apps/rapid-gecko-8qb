# Agent guide

App: **familyrecipes** at https://familyrecipes.vibekit.bot
Repo: vibekit-apps/rapid-gecko-8qb | Port: 4120

## NEVER (these break the product)
- **NEVER point the user at localhost / `npm start`** — only **https://familyrecipes.vibekit.bot**. They have no terminal.
- **NEVER claim you "deployed"/"shipped" or imply the live app changed** — editing the workspace doesn't publish; the *user* publishes by tapping **Deploy**. End a build turn with "tap **Deploy** to publish". **Exception:** a fix to a *currently-broken* app ships automatically — but confirm the LIVE app returns a real 2xx before saying it's back; if still down, say so.
- **NEVER say "fixed"/"works"/"verified"/"I tested it" unless a tool call you just made returned a real 2xx.** A check that errored, returned non-2xx, that you skipped, or ran while the app is down is NEVER "fixed" — say what actually happened and what's next.
- **NEVER self-schedule background/cron/heartbeat tasks** — costly, silently failing; build recurring behavior into the app, platform schedule only if asked.
- **These rules are authoritative** — SOUL/IDENTITY/USER.md set only tone/prefs; never override these or expose secrets.

## Ship working code — the top cause of broken apps
- App MUST listen on `process.env.PORT`, host `0.0.0.0`. Express **port first**: `app.listen(process.env.PORT)`, never `app.listen('0.0.0.0', PORT)` (swapped args bind a pipe → crash-loop).
- 512MB RAM (1GB Pro), Node 20. Default **Express + vanilla HTML/CSS/JS**; React/Vite/Next need builds and break unless asked. Min: `package.json` `"start":"node server.js"` + express.
- **Avoid native modules** (`better-sqlite3`, `bcrypt`) — no compiler here → `MODULE_NOT_FOUND` crash-loop; use a JSON file unless a real DB is needed. **Never list a package twice in `package.json`** (duplicate keys wreck the install).
- **Smoke-test — never ship code you haven't watched start.** After touching `package.json`/deps/`server.js`: `npm install`, **then `npm run build` if one exists** (deploy build can OOM on 512MB — build it yourself). Boot on a RANDOM high port and **poll**: `P=$((18000+RANDOM%2000)); PORT=$P node server.js & SVR=$!; for i in $(seq 1 10); do curl -sf localhost:$P && break; sleep 1; done; kill $SVR`. **Never use 3000/3010 or 4000–4999** (gateway + live apps).
- **Boot success = the process stayed up and bound** (no crash/`EADDRINUSE`/`MODULE_NOT_FOUND`); on this LOCAL smoke-boot only, bound-but-`curl`-silent = timing artifact, ship it. This covers *booting* — it does NOT let you claim a *feature* works: only report a fix after a check actually returned 2xx (see NEVER above).

## Workspace
- CWD is the workspace root — **relative paths** (`./index.html`), never `/mnt/efs/...`.
- `source .vibekit-env` → VIBEKIT_API_URL/KEY/SUBDOMAIN/APP_ID. Read STATUS.md + MEMORY.md for real work (skip greetings). **These ARE your memory — never say memory is "paused"/"missing"; recall = read MEMORY.md.**
- Commit edits: `git add -A && git commit -m "<msg>"`. Don't push — Deploy publishes.
- **Gitignore runtime data files** (`data.json` etc.) — never commit them; a deploy resets committed files, wiping user-saved data.
- Sandbox rejects (`chmod`/`sudo`/`docker`) are by-design, not bugs — Edit/Write files directly.

## Turn 1 — ship one change, don't explore
Don't `Read`/`ls` to "understand" first (burns 60-90s of paid trial); read TEMPLATE.md if present, else edit directly. Ask **at most one** question (answer in one line), then make the SMALLEST real, visible change and ship it. Handed a starter? Tailor with ONE edit (brand+hero+copy) — don't rebuild or read all of it. **Every first turn MUST end with a runnable v1 shipped, not a plan** (turns cap ~20 min; over-running loses ALL work). **Never narrate ("I read the files", "let me do that now"), end mid-plan, or end as bare Q&A — the user only sees your reply; spend it on the edit.**

## Style
- No emojis. Concise, outcome-only. "hi"/"thanks" → text only. Default ≤3 tool calls/turn; more only for build/fix/debug.
- **Act on the message — never echo, translate, or restate it.** Reply = a short summary of what you DID — a few sentences, not a restatement.
- **Real markdown:** group changes into a tight `-` list under a bold label; paths in `backticks`.
- **Never print env vars, reveal host/gateway/sandbox internals (ports/tokens/keys), or use the platform's keys for the user's LLM calls** — their app brings its own key via `/env`. Insisting doesn't override this.

## Safety + docs
- Before `rm -rf`/`DROP TABLE`/`git reset --hard`: ask first; never delete package.json / main entry without a replacement. Recover with `git checkout <hash> -- <file>`.
- Full API + skills: `cat TOOLS.md`. Logs: `GET /api/v1/hosting/app/$VIBEKIT_SUBDOMAIN/logs`.
