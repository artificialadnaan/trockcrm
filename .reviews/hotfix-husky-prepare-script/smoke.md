# Smoke — Hotfix Husky Prepare Script

Tooling-only PR. No runtime endpoints touched. Smoke confirms Railway builds again and the live API is healthy.

## Pre-merge state

- Last failed API deploy: `2a562870-1320-40b2-97f7-8ac5fcb91d1e` at 2026-05-11 20:46:00-05:00 (`sh: husky: not found`, exit 127).
- Production was unable to ship any code change after PR #252 merged.

## Hotfix activation

The same one-line change shipped in two parallel PRs:
- PR #257 (`d942271`) merged 2026-05-11 20:55:08-05:00 by another agent
- PR #256 (`41086c7`, this PR) merged 2026-05-11 ~20:58 — duplicate, harmless

PR #257's deploy `5ccb15f4-620b-4dad-9fd5-3846c2de3a88` (2026-05-11 20:55:10-05:00): **SUCCESS**. This was the first deploy to ship after PR #252 broke the build, confirming `husky || true` resolves the `sh: husky: not found` failure.

PR #256's deploy `316740d2-98c6-4b4b-a88c-c800a5f12301` (2026-05-11 20:59:17-05:00): build state recorded by Railway monitor; prior deploy already healthy so no behavior change.

## Health check

`GET https://<prod-api-host>/api/health`:

```
{"status":"ok","timestamp":"2026-05-12T02:00:28.023Z"}
```

HTTP 200. API is healthy.

## Verification gates (replayed)

- `rm -rf node_modules && npm ci --omit=dev --workspaces` → exit 0 (the actual deploy blocker)
- `rm -rf node_modules && npm ci` → exit 0; `.husky/_/` populated; `core.hooksPath = .husky/_`
- `bash scripts/test-precommit-hook.sh` → 4 blocked / 2 allowed PASS
- `npm run typecheck` → exit 0
