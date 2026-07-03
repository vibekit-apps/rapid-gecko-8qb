# TOOLS.md — familyrecipes

## What you have
- Shell: node, npm, git, curl (sandboxed — no docker/aws/ssh)
- File read/write on your workspace (which IS the live app code)
- web_fetch, web_search, browser, sub-agents, image analysis
- VibeKit API via `source .vibekit-env` (see AGENTS.md for endpoints)

## Parallel sub-agents — worktree isolation
When you fan work out to multiple sub-agents that touch DIFFERENT files, give
each its own git worktree (isolated branch + dir) so they never clobber each
other, then merge back. Gated by the app's **Worktree Isolation** / **Auto
Merge** settings — if disabled the create call returns 403, so just work
serially on main. Workflow:

```bash
source .vibekit-env
# 1) Before spawning a sub-agent for a task, make its worktree:
curl -s -X POST $VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/worktree/create \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"taskId":"auth-refactor"}'
# → { "worktreePath": ".worktrees/auth-refactor", "branchName": "agent/task-auth-refactor" }
# 2) Tell that sub-agent to cd into worktreePath and do ALL its edits there.
# 3) When it finishes, merge back (auto-resolves conflicts — prefers newer
#    changes unless code was deleted; if Auto Merge is off, conflicting files
#    come back for you to resolve on the branch, main stays clean):
curl -s -X POST $VIBEKIT_API_URL/api/v1/hosting/app/$VIBEKIT_APP_ID/worktree/merge \
  -H "Authorization: Bearer $VIBEKIT_API_KEY" -H 'Content-Type: application/json' \
  -d '{"taskId":"auth-refactor"}'
# List active: GET …/worktrees · Clean up stragglers: POST …/worktree/cleanup
```
Use this only for genuinely parallel, file-disjoint work — for serial edits just
work on main.

## Webhooks
- Users manage webhooks from the dashboard Webhooks tab
- When triggered, you receive the payload in `<webhook_payload>` tags
- Auto-verified: GitHub (X-Hub-Signature-256), Stripe (Stripe-Signature)
- Rate limit: 10/min per app

## Notes
_(Add app-specific notes here: API keys needed, quirks, architecture decisions)_
