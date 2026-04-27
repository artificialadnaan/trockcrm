# Local Migration Dry-Run Tooling

## Problem

This worktree has no way to apply a Drizzle migration locally before pushing to Railway. Surfaced concretely during PR1 (lead verification): migration `0059_add_lead_verification_fields.sql` shipped without a dry-run because the verification worktree has neither a local Postgres instance, a `.env`, nor a containerized DB.

The current verification path is "visually confirm SQL parses, hope the Railway deploy validates it." That's a deploy-time discovery loop. A bad migration there means a failed deploy and a hot rollback under pressure — not a local typo caught in 30 seconds.

## What's missing

- No `docker-compose.yml` (only `Dockerfile`, `Dockerfile.frontend`, `Dockerfile.worker` — these build production images, none of them spin up a Postgres for local use).
- No `.env.example` entry for a local DB the developer can spin up against (`.env.example` defines `DATABASE_URL=postgresql://postgres:postgres@localhost:5432/trock_crm` but assumes a postgres is already running locally).
- No `npm run db:dry-run` script. `db:migrate` exists but applies against `DATABASE_URL` whatever it is — there's no isolated throwaway DB.
- No script that creates a tenant schema for tenant-loop migrations to actually exercise. Migration `0057` and PR1's `0059` both iterate `information_schema.schemata` and only touch schemas that have `leads` / `companies` tables. On a fresh local DB with no tenant schemas, the loop runs zero iterations and the column-add code never executes — so even applying the migration locally is a partial test unless a real tenant schema exists.

## Suggested approach

### Step 1 — `docker-compose.test.yml`
Spin up Postgres 15 with a deterministic password. One service, one volume. Make `npm run db:dry-run` start the container, apply migrations, run a quick smoke query, then tear down.

```yaml
# docker-compose.test.yml
services:
  postgres:
    image: postgres:15
    environment:
      POSTGRES_DB: trock_crm_dryrun
      POSTGRES_PASSWORD: dryrun
    ports: ["55432:5432"]
    tmpfs: ["/var/lib/postgresql/data"]   # ephemeral, dies with container
```

### Step 2 — Tenant seed for the dry-run DB
Add a `scripts/seed-dryrun-tenant.ts` that:
1. Creates a `tenant_dryrun` schema.
2. Runs the bare-minimum table creates that the tenant-loop migrations expect (`leads`, `companies`, `deals`, `contacts`, `activities`, `emails`).
3. Lets the tenant-loop migrations actually exercise their `EXECUTE format(...)` paths on a real schema.

Without this, tenant-loop migrations like `0057` and `0059` parse-but-don't-execute their column adds, defeating the purpose.

### Step 3 — `npm run db:dry-run`
```json
"db:dry-run": "docker compose -f docker-compose.test.yml up -d && DATABASE_URL=postgresql://postgres:dryrun@localhost:55432/trock_crm_dryrun tsx scripts/seed-dryrun-tenant.ts && DATABASE_URL=postgresql://postgres:dryrun@localhost:55432/trock_crm_dryrun npm run db:migrate && docker compose -f docker-compose.test.yml down"
```

End-to-end: container up → tenant schema seeded → migrations applied → container down. Full cycle should be ~10 seconds on a warm Docker.

### Step 4 — Make it part of the migration-PR checklist
Add to `CONTRIBUTING.md` or wherever the migration norms live: "Run `npm run db:dry-run` against your branch before opening any PR that touches `migrations/`."

## Out of scope

- Replacing Railway's migration step with a CI-driven apply. That's a bigger change and depends on CI access we don't have today.
- Migration testing frameworks (e.g., `pgTAP`). Useful eventually; overkill for the immediate "did the SQL parse" gap.
- Snapshot testing of generated schemas. Nice-to-have but not the bottleneck.

## Why this matters now

PR1 shipped `0059` without local validation. PR2 (verification email infra) likely won't add migrations, but PR3 (assigned-approver UI / lookups) probably will. The lead-verification feature also has follow-on schema work — backfills, indexes, possible token-table additions. Each of those is a deploy-roulette spin until this gap is closed.

**Cost to close: ~1 hour of work.** Compose file + seed script + npm script + docs update. The compose file is ~10 lines. The seed script can crib from existing tenant-creation logic in `scripts/migration-promote.ts`.

## Trade-offs

- **Docker is a hard dependency.** Anyone without Docker locally can't run the dry-run. Acceptable — the alternative (homebrew Postgres + manual env) is worse for cross-machine consistency.
- **Tmpfs volume = no persistence.** That's intentional. Dry-runs should always start clean. If you want a persistent local dev DB, that's a separate compose file (`docker-compose.dev.yml`).
- **Different from production DB topology.** Railway uses managed Postgres with a different network model. The dry-run catches *SQL syntax* and *migration logic* errors, not Railway-specific deploy failures (network, IAM, plugin wiring). It's the cheap 80% of the value.
