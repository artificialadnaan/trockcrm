# T Rock AI demo — deploy & operate

A password-gated, **read-only** AI chat over the Dallas CRM tenant, exposed to Anthropic's API via a
scoped MCP server. It runs as a **separate Railway service from the existing `server` workspace** —
same repo, same build, a **distinct start command**. The CRM `createApp()` is untouched.

- Browser surface (page gate + chat) → `POST /api/login`, `GET /api/session`, (Phase 4) `POST /api/ai-chat`
- Machine surface (Anthropic connector) → `/mcp` (Bearer MCP session token, `validateSessionToken`)
- Entry point: `server/src/mcp/index.ts` → built to `server/dist/mcp/index.js`

## Railway service setup

Create a **second service** in the same Railway project, pointed at the same GitHub repo as the CRM
API. It differs from the CRM service only in the **start command** and its **env**.

| Setting | Value |
|---|---|
| Root Directory | repo root (`/`) — required so `npm ci` installs the workspaces and the `@trock-crm/shared` symlink resolves |
| Install | `npm ci` (Nixpacks default) |
| Build Command | `npm run build -w @trock-crm/shared && npm run build -w @trock-crm/server && npm run build -w @trock-crm/client` |
| Start Command | `npm run start:ai-demo -w @trock-crm/server` (= `node server/dist/mcp/index.js`) |
| Health check path | `/api/health` |

The demo service serves the built React client too, so the demo UI is at **`${PUBLIC_BASE_URL}/ai-demo`** (the page prompts for `DEMO_PASSWORD`, then chats). Building the client is why the build command includes the `client` workspace.

> The CRM API service in the same repo keeps Start = `node server/dist/index.js`. Same build output,
> two start commands — that's the whole separation.

## Environment variables (this service)

| Var | Required | Notes |
|---|---|---|
| `DEMO_PASSWORD` | ✅ | Single shared page-gate password (`POST /api/login`). |
| `MCP_SESSION_SECRET` | ✅ | Signs the scoped MCP token + the demo session cookie. **MUST differ from the CRM's `JWT_SECRET`** — startup fails fast if it equals it. |
| `ANTHROPIC_API_KEY` | Phase 4 | Needed only once the `/api/ai-chat` connector ships. The read-only MCP demo boots and passes its direct checks without it (the connectivity check skips its Anthropic step when unset). |
| `DATABASE_URL` | ✅ | **Same Postgres as the CRM.** The demo reads `office_dallas` read-only. |
| `PUBLIC_BASE_URL` | ✅ | This service's own public **https** origin (the Railway domain). Used to build the MCP connector URL `${PUBLIC_BASE_URL}/mcp` handed to Anthropic. |
| `DB_POOL_MAX` | optional | Cap the demo's DB pool low (e.g. `5`) so demo load can't starve the CRM's shared-Postgres connection budget. |
| `NODE_ENV` | recommended | `production` (enables secure cookies + the secret-required checks). |
| `PORT` | auto | Set by Railway; the entry point reads it. |

Startup fails fast (before listening) if `DEMO_PASSWORD` / `MCP_SESSION_SECRET` are missing outside
local dev, or if `MCP_SESSION_SECRET` reuses `JWT_SECRET`.

## Post-deploy live verification

Run the connectivity check against the deployed service (the one thing that can't be validated until
live — that Anthropic's servers can reach `${PUBLIC_BASE_URL}/mcp` over HTTPS with a minted token):

```bash
# From the repo root, with the SAME PUBLIC_BASE_URL + MCP_SESSION_SECRET (+ ANTHROPIC_API_KEY) the
# deployed service uses:
PUBLIC_BASE_URL=https://<demo>.up.railway.app \
MCP_SESSION_SECRET=<the deployed secret> \
ANTHROPIC_API_KEY=<key> \
npm run mcp:connectivity-check -w @trock-crm/server
```

It (1) mints a token and completes an MCP `initialize` handshake against `/mcp` over HTTPS, (2)
confirms `/mcp` rejects an unauthenticated request (401), and (3) if `ANTHROPIC_API_KEY` is set,
makes a real Anthropic Messages API call with the `mcp_servers` connector and confirms Anthropic
reached the server (an `mcp_tool_use`/`mcp_tool_result` block comes back).

Also do the **manual data reconciliation** before any demo: pipeline Won count/revenue vs the CRM
reports page for the same window, and **spot-check bid→award variance for 2-3 named reps** against
their actual deals (the variance figure has no inventory anchor).
