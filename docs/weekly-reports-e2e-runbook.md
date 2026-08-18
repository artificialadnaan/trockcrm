# Weekly Reports — local end-to-end runbook

Everything needed to drive the Weekly Reports chain in a browser against a **local** database:
leadership sets a project up on a Won deal → a superintendent writes the week's report → the PM
approves it → the client gets an emailed link to a public page and a PDF.

Two of the six PRs are merged, so the first half of the chain runs **today**. The rest is prepared and
waiting — see [What runs today](#what-runs-today) for exactly where the line is.

> **Local only.** Nothing here touches production. The seed script refuses any database whose host is
> not `localhost`. If you ever find yourself wanting a Railway connection string for this, stop.

---

## 0. What runs today

| PR | Scope | State | Chain step |
|---|---|---|---|
| #1070 (1/6) | migration 0222 + the `weekly-reports` server module | **merged** | project setup API, Won guard |
| #1071 (2/6) | the CRM board at `/projects/weekly-reports` (+ migration 0223 pauses) | **merged** | board, backlog, ordering, setup form |
| #1073 (3/6) | T-Rock Cam Reports tab + superintendent wizard (adds `/api/field/weekly-reports/*`) | open | superintendent authoring |
| #1075 (4/6) | PDF renderer + public `/wr/:token` viewer + token minting | open | the client-facing page and PDF |
| — (5/6) | `feat/weekly-reports-send` — send flow, send dialog, migration 0226. **Branch exists, no PR yet.** | open | approval + send |
| #1072 (6/6) | reminder cron + leadership digest (worker) | open | reminders |

So today you can log in, see the board, confirm the backlog and its ordering, create a setup through
the form, and watch the new cadence week appear. Authoring, approval, send, the public viewer and the
reminders all arrive with the PRs above.

---

## 1. The database

A prepared database already exists: **`trock_wr_verify`**, on the local Homebrew PostgreSQL 16, with
the full migration chain applied through `0225`.

```bash
brew services start postgresql@16       # if it is not already running
psql -d trock_wr_verify -c "select count(*) from public._migrations;"
```

Confirm the feature's tables are there:

```bash
psql -d trock_wr_verify -tAc "
  select table_name from information_schema.tables
   where table_schema='office_dallas' and table_name like 'weekly_report%' order by 1;"
# weekly_report_dismissals / weekly_report_pauses / weekly_report_photos /
# weekly_report_projects / weekly_report_reminders_sent / weekly_report_settings / weekly_reports
```

`weekly_report_pauses` is the one to check for: it arrives with migration `0223`, and a database that
predates it will silently bill a resumed project for every week it spent paused.

### Bringing it to the head of the chain

Newer migrations land constantly. To catch up:

```bash
cd /Users/adnaaniqbal/Developer/trockcrm-wr-e2e
DATABASE_URL="postgresql://$USER@localhost:5432/trock_wr_verify" npx tsx server/src/migrations/runner.ts
```

### Building one from scratch

Only if `trock_wr_verify` is gone. Two things bite:

1. **`pgvector` is required.** It is already compiled and installed for this PG16. If it is missing,
   `CREATE EXTENSION vector` fails early in the chain and nothing after it runs.
2. **Migration `0110` hardcodes `office_atlanta`.** This is the pre-existing new-office provisioning
   bug — a fresh database grows a stub `office_atlanta` schema, and later migrations that loop over
   every `office_*` schema then die on tables that stub does not have. **Do not fix this in the repo.**
   Work around it locally by cloning each missing table's shape from the real tenant and continuing:

   ```bash
   createdb trock_wr_verify
   psql -d trock_wr_verify -c 'CREATE EXTENSION IF NOT EXISTS vector;'
   # then loop: run the migration runner; on `relation "office_atlanta.X" does not exist`, run
   #   CREATE TABLE IF NOT EXISTS office_atlanta.X (LIKE office_dallas.X INCLUDING ALL);
   # and run the runner again. Roughly a dozen rounds.
   ```

   `office_atlanta` is **not** a real office — there is no row for it in `public.offices` and nothing
   reads it. It exists only to keep migration `0110` happy.

---

## 2. Seed data

```bash
cd /Users/adnaaniqbal/Developer/trockcrm-wr-e2e
DATABASE_URL="postgresql://$USER@localhost:5432/trock_wr_verify" \
  npx tsx scripts/seed-weekly-reports-e2e.ts
```

**Idempotent** — every row is upserted against a fixed id, so run it as often as you like. It also
prints exactly which weeks the cadence should generate, computed with the *shipped* generator from
`shared` rather than a restatement of it, so the printout is a real oracle for the board.

Every date is derived from the office's business "today" at run time, so the shape below holds
whenever you run it.

### What it creates

**Five personas.** Password for all of them: **`WeeklyReports!2026`**

| Email | Password | Role | Name | Part |
|---|---|---|---|---|
| `admin@trock.dev` | `WeeklyReports!2026` | `admin` | Admin User | **Leadership** |
| `director@trock.dev` | `WeeklyReports!2026` | `director` | James Director | Leadership (2nd) |
| `pm@trock.dev` | `WeeklyReports!2026` | `director` | Priya Mendes | **The assigned T-Rock PM** |
| `super@trock.dev` | `WeeklyReports!2026` | `construction` | Steve Sanchez | **The assigned superintendent** |
| `super2@trock.dev` | — no CRM login | `field_contractor` | Marcus Webb | Superintendent on two projects |

The seed writes a real `public.user_local_auth` row for the first four, hashed with the server's own
`hashPassword`, with `must_change_password=false` and the lockout counters cleared. Marcus Webb is
deliberately left without one: `loginWithLocalPassword` refuses `field_contractor` outright, so that
account genuinely cannot open the CRM — worth seeing rather than papering over.

The PM holds `director`, not `rep`, and that is forced rather than chosen. An assignee must pass
`assertAssignableUser` (`field_contractor | construction | admin | director`) *and* the weekly-reports
router's `requireRole("admin","director","rep")`. The intersection is `admin`/`director` — a `rep` PM
would be assignable-rejected, and a `construction` PM could not open the CRM board. All five are real
`public.users` rows and office members; `deal_team_members` is empty in production and is not the
source the picker reads.

**Six Won deals and one that is not:**

| Deal | Number | Stage | Setup |
|---|---|---|---|
| 4123 Cedar Springs | DFW-10432 | won | Project A |
| 8800 Preston Road | DFW-10501 | won | Project B |
| 1500 Marilla Street | DFW-10502 | won | Project C |
| 2200 Ross Avenue | DFW-10503 | won | Project D |
| 700 North Pearl | DFW-10504 | won | Project E |
| 3300 Oak Lawn Avenue | DFW-10506 | won | **none — reserved for the "New project" form** |
| 9001 Forest Lane | DFW-10505 | `estimating` | **none — the server must refuse it, 400** |

**Five weekly-report setups**, each with a client name, the four client-team contacts, a T-Rock PM and
superintendent, contract/start dates and a cadence weekday:

| | Property | Cadence | Starts | Shape |
|---|---|---|---|---|
| A | 4123 Cedar Springs | Thursday | 8 weeks ago | 8 backlog weeks + this week — the top of the board |
| B | 8800 Preston Road | Wednesday | 3 weeks ago | 3 backlog weeks + this week |
| C | 1500 Marilla Street | Monday | today | one row, "Due", zero days late |
| D | 2200 Ross Avenue | Friday | 7 weeks ago | pre-pause weeks outstanding, **paused weeks absent** |
| E | 700 North Pearl | Tuesday | 6 weeks ago | `status=paused` — on Projects, **nowhere** on This Week |

A and B are the demonstration that matters: *the rows are generated from the cadence, not read from the
reports table.* Not one report has been filed, `weekly_reports` is empty, and the board is still full.

D carries a **closed** pause interval and E an **open** one, which together cover migration 0223: a
resumed project must not come back owing the weeks it was stood down for, while the weeks it missed
*before* the pause stay outstanding.

**Fifteen photo rows** (`files`, `category='photo'`) spread across the projects, most inside and a few
deliberately outside the 14-day window ending on `week_of` that the photo picker draws from. The
window is what `taken_at` decides, so the seed sets it explicitly.

**Leadership digest recipients** — `weekly_report_settings.leadership_recipient_emails` is set to
`admin@trock.dev, director@trock.dev`, ready for PR 6/6.

### The board the seed produces

19 rows, 15 of them overdue, most-overdue-first. The script prints the full list; the top and bottom:

```
 54 days late  <8 weeks ago, Thu>   4123 Cedar Springs
 47 days late  ...                  4123 Cedar Springs
 46 days late  ...                  2200 Ross Avenue
 ...
        Due    <this Mon>           1500 Marilla Street
```

---

## 3. The API and the client

### Standard ports

```bash
cd /Users/adnaaniqbal/Developer/trockcrm-wr-e2e
npm install                       # first time in this worktree only
npm run build --workspace=shared  # the server will not start without shared/dist

DATABASE_URL="postgresql://$USER@localhost:5432/trock_wr_verify" \
NODE_ENV=development PORT=3001 DEV_MODE=true \
JWT_SECRET=local-dev-secret-for-weekly-reports-e2e \
ENCRYPTION_KEY=0000000000000000000000000000000000000000000000000000000000000000 \
  npx tsx server/src/index.ts
```

```bash
cd /Users/adnaaniqbal/Developer/trockcrm-wr-e2e/client
npx vite --port 5173 --strictPort
```

Then open <http://localhost:5173>. Vite proxies `/api` to `localhost:3001`, so the browser sees one
origin and cookies and CSRF need no thought.

### When port 3001 is already taken

It usually is — other worktrees run their own API there. Use a second port and point the client at it
explicitly rather than through the proxy:

```bash
# API
… PORT=3011 CORS_ALLOWED_ORIGINS=http://localhost:5174 npx tsx server/src/index.ts

# client
cd client && VITE_API_URL=http://localhost:3011 npx vite --port 5174 --strictPort
```

`5173`, `5174` and `3000` are CORS-allowed by default in development. Any other client port needs
adding to `CORS_ALLOWED_ORIGINS`. Cookies still work cross-port because same-site is decided by host,
not port — but the API origin must be allow-listed or every request answers 403.

**Ports used by the prepared setup in this runbook: API `3011`, client `5174`.**

### Health check

```bash
curl -s localhost:3011/api/health
```

---

## 4. Logging in

**In the browser:** open <http://localhost:5174>, type the email and `WeeklyReports!2026` into the
login form. That is it — no password change prompt, no picker to find.

There is a `DevUserPicker` component in the client and a `/api/auth/dev/login` endpoint on the server,
but **the picker is not mounted on any route**, so the only way in through a browser is the password
form. That is why the seed writes real credentials rather than relying on dev login.

From the shell:

```bash
WR_PW='WeeklyReports!2026'
curl -s -c /tmp/wr-cookies.txt -X POST http://localhost:3011/api/auth/local/login \
  -H 'Content-Type: application/json' -H 'Origin: http://localhost:5174' \
  -d "{\"email\":\"admin@trock.dev\",\"password\":\"$WR_PW\"}"
```

`POST /api/auth/dev/login` with just `{"email":"..."}` also works from the shell (`@trock.dev` only,
`NODE_ENV=development`, localhost host) if you would rather not carry the password.

**If an account locks:** five bad attempts lock it for 15 minutes, and the counter is *not* cleared by
a later success. Re-running the seed zeroes `failed_login_attempts` and `locked_until`.

Every **mutating** call additionally needs the CSRF cookie echoed back:

```bash
CSRF=$(grep csrf_token /tmp/wr-cookies.txt | awk '{print $7}')
curl -s -b /tmp/wr-cookies.txt -X POST http://localhost:3011/api/weekly-reports/... \
  -H "X-CSRF-Token: $CSRF" -H 'Origin: http://localhost:5174' -H 'Content-Type: application/json' -d '{...}'
```

A 403 with `{"error":{"message":"Forbidden origin"}}` means the `Origin` header is missing, not that
authorisation failed.

---

## 5. URLs

### The CRM board — merged, works today

| | |
|---|---|
| Board | <http://localhost:5174/projects/weekly-reports> |
| Tabs | **This Week** (generated weeks) · **Projects** (setups) · **History** (sent reports) |
| Guarded to | `admin`, `director`, `rep` — client route and API router both |

### CRM API — merged, works today

All under `http://localhost:3011/api/weekly-reports`, all `requireRole("admin","director","rep")`:

| Method | Path | Purpose |
|---|---|---|
| GET | `/dashboard?asOf=&lookbackWeeks=` | the generated board. `asOf` overrides the business day |
| GET | `/projects?status=&search=` | setups + per-project summary |
| GET | `/assignable-users` | the PM / superintendent picker feed |
| POST | `/projects` | create a setup — **400 unless the deal is Won** |
| GET·PATCH·DELETE | `/projects/:id` | read / edit / stop reporting (soft delete) |
| POST | `/projects/:id/dismiss` | write off a missed week; a reason is mandatory |
| GET·POST | `/reports` | list / create a draft (201 new, 200 on an idempotent retry) |
| GET·PATCH | `/reports/:id` | read / edit content |
| GET | `/reports/:id/photo-candidates` | the 14-day photo window |
| PUT | `/reports/:id/photos` | replace the selection |
| POST | `/reports/:id/transition` | `draft → pending_review → approved → sent` |
| GET·PUT | `/settings` | digest recipients (PUT is `admin`/`director` only) |

### App-facing — arrives with #1073

T-Rock Cam signs in through `/auth/field-login` and uses a **separate mount**, because the CRM router
above would refuse a `construction` superintendent outright:

```
http://localhost:3011/api/field/weekly-reports/assignments
http://localhost:3011/api/field/weekly-reports/reports            (POST)
http://localhost:3011/api/field/weekly-reports/reports/:id        (GET, PATCH)
http://localhost:3011/api/field/weekly-reports/reports/:id/photo-candidates
http://localhost:3011/api/field/weekly-reports/reports/:id/photos (PUT)
http://localhost:3011/api/field/weekly-reports/reports/:id/transition (POST)
```

The surface itself is the Expo app in `mobile/`, not this client.

### The public client-facing viewer — arrives with #1075

Served by the **API service, not the SPA**, so the page is same-origin with the photo bytes it loads:

```
http://localhost:3011/wr/<token>                  the page the client opens
http://localhost:3011/wr/<token>/pdf              the PDF
http://localhost:3011/wr/<token>/photos/<fileId>  a photo
```

Two things to know before trying it:

- **The raw token cannot be recovered from the database.** `public.weekly_report_tokens.token` stores a
  SHA-256 hash; the raw value exists only in the URL that gets emailed. Capture it at send time.
- **Photos and the PDF need R2.** Set `R2_ACCOUNT_ID`, `R2_ACCESS_KEY_ID`, `R2_SECRET_ACCESS_KEY` (and
  optionally `R2_BUCKET_NAME`) or those routes fail. The seeded photo rows carry `r2_key` values with
  no bytes behind them — enough to exercise the picker and the candidate window, not enough to render.

---

## 6. Driving it

A Playwright walk-through of the whole chain lives in the session scratchpad — **which is
session-scoped and will be cleaned up. Move it into the repo when the feature merges.**

```
/private/tmp/claude-501/-Users-adnaaniqbal-Developer-trockcrm/<session>/scratchpad/weekly-reports-e2e.mjs
```

```bash
cd /Users/adnaaniqbal/Developer/trockcrm-wr-e2e     # it resolves `playwright` from here
npx playwright install chromium                     # first time only
node <path>/weekly-reports-e2e.mjs --shots ./wr-e2e-shots
node <path>/weekly-reports-e2e.mjs --headed         # watch it
```

Its defaults match this runbook (client `5174`, API `3011`, password `WeeklyReports!2026`); override
with `WR_CLIENT_URL`, `WR_API_URL`, `WR_E2E_PASSWORD`.

Steps 1–4 run today and pass. Steps 5–9 are marked skeletons and are skipped with the PR that blocks
each one named; `RUN_BLOCKED=1` attempts them. The script cleans up the setup it creates, so it is
re-runnable without re-seeding.

### By hand, today

1. Log in as `admin@trock.dev` / `WeeklyReports!2026`, open `/projects/weekly-reports`.
2. **This Week** should show 19 rows, 15 overdue, oldest first, past weeks tagged `BACKLOG`. Nothing
   has been filed — every row is generated.
3. **Projects** shows all five setups including the paused one; This Week shows four.
4. **New project** → search `3300 Oak Lawn` → fill it in → Create. A new cadence week appears at once.
5. Try the same against `9001 Forest Lane` via the API: 400, "Weekly reports can only be set up on a
   Won project". The picker offers it, the server refuses it — that is the guard working.

### When each PR lands

- **#1073** — log in to T-Rock Cam as `super@trock.dev`, open Reports, write the week for
  4123 Cedar Springs, pick photos (4 candidates sit inside the window), submit. The board row flips
  from *Not started* to *Pending review* and *Waiting on* moves from Steve Sanchez to Priya Mendes.
- **5/6 (send)** — as `pm@trock.dev`, approve and send. The row leaves This Week (a settled past week
  is dropped by design) and appears under History. **Capture the raw token from the send response.**
- **#1075** — open `http://localhost:3011/wr/<token>` in a private window with no cookies.
- **#1072** — run the worker's reminder job against this database and check
  `weekly_report_reminders_sent` gains exactly one row per (project, week, kind).

---

## 7. Reset

```bash
# back to the seeded state, discarding anything the browser created
DATABASE_URL="postgresql://$USER@localhost:5432/trock_wr_verify" \
  npx tsx scripts/seed-weekly-reports-e2e.ts
```

The seed removes any setup on its own deals that it did not create, so a project made through the form
is cleared. It does **not** delete reports on other deals; to start completely clean:

```bash
psql -d trock_wr_verify -c "truncate office_dallas.weekly_reports cascade;"
```
