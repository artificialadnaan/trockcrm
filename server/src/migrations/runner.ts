import { readdirSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import pg from "pg";
import dotenv from "dotenv";
import {
  AUDIT_LOG_PERFORMANCE_MIGRATION,
  runAuditLogPerformanceIndexMigration,
} from "./audit-log-performance-indexes.js";
import {
  PROJECT_NUMBER_FIRST_SET_MIGRATION,
  runProjectNumberFirstSetIndexMigration,
} from "./project-number-first-set-index.js";
import {
  BID_BOARD_INGEST_MIGRATION,
  runBidBoardIngestIndexMigration,
} from "./bid-board-ingest-indexes.js";
import {
  DEAL_STAGE_HISTORY_CREATED_AT_MIGRATION,
  runDealStageHistoryCreatedAtIndexMigration,
} from "./deal-stage-history-created-at-index.js";
import {
  ACTIVITIES_PERFORMED_BY_USER_MIGRATION,
  runActivitiesPerformedByUserIndexMigration,
} from "./activities-performed-by-user-index.js";
import {
  TASK_SOURCE_INDEX_MIGRATION,
  runTaskSourceIndexMigration,
} from "./task-source-index.js";
import {
  TASK_SOURCE_BACKFILL_MIGRATION,
  runTaskSourceBackfill,
} from "./task-source-backfill.js";
import {
  FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION,
  runFilesAssociationCheckRepair,
} from "./files-association-check-repair.js";

dotenv.config({
  path: join(dirname(fileURLToPath(import.meta.url)), "../../../.env"),
});

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = join(__dirname, "../../../migrations");

async function runMigrations(): Promise<void> {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS public._migrations (
        id SERIAL PRIMARY KEY,
        name VARCHAR(255) UNIQUE NOT NULL,
        executed_at TIMESTAMPTZ DEFAULT NOW()
      );
    `);

    // Read migration files sorted alphabetically
    const migrationFiles = readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of migrationFiles) {
      // Check if already run
      const { rows } = await client.query(
        "SELECT id FROM public._migrations WHERE name = $1",
        [file]
      );
      if (rows.length > 0) {
        console.log(`Skipping ${file} (already executed)`);
        continue;
      }

      console.log(`Running ${file}...`);
      if (file === AUDIT_LOG_PERFORMANCE_MIGRATION) {
        await runAuditLogPerformanceIndexMigration(client);
      } else if (file === PROJECT_NUMBER_FIRST_SET_MIGRATION) {
        // CREATE UNIQUE INDEX CONCURRENTLY cannot run inside the DO block in the
        // SQL file, so build the per-tenant index here first; then the SQL file's
        // `CREATE UNIQUE INDEX IF NOT EXISTS` becomes a no-op on existing tenants.
        await runProjectNumberFirstSetIndexMigration(client);
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      } else if (file === DEAL_STAGE_HISTORY_CREATED_AT_MIGRATION) {
        // Same reason as the two below: a plain CREATE INDEX over every tenant's deal_stage_history holds
        // write-blocking locks for the whole DO block, and that table is on the deal hot path. Build each
        // tenant's index CONCURRENTLY first; the file's plain statement then no-ops on existing schemas
        // while remaining the marker the office provisioner replays for new ones.
        await runDealStageHistoryCreatedAtIndexMigration(client);
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      } else if (file === ACTIVITIES_PERFORMED_BY_USER_MIGRATION) {
        // Same reason again, and the sharpest case of it: `activities` is the biggest table in a tenant
        // schema and is written by nearly every CRM action, so a plain CREATE INDEX inside the file's DO
        // block would hold a write-blocking SHARE lock across ALL offices until the last one finished.
        // Build each tenant's index CONCURRENTLY first; the file's plain statement then no-ops on
        // existing schemas while remaining the marker the office provisioner replays for new ones.
        await runActivitiesPerformedByUserIndexMigration(client);
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      } else if (file === TASK_SOURCE_BACKFILL_MIGRATION) {
        // The one case where the step runs AFTER the file rather than before it: 0233 adds the column,
        // and the backfill cannot classify a column that does not exist yet.
        //
        // The backfill is not in the SQL because it has to disable set_tasks_updated_at and audit_tasks
        // around itself, and `ALTER TABLE ... DISABLE TRIGGER` takes a lock that conflicts with task
        // writes. A migration file is ONE transaction, so a DO block doing that per office would hold
        // the first office's lock until the last office finished — task writes blocking across every
        // tenant, on deploy. The step below takes one transaction PER OFFICE and commits each before
        // moving on. See task-source-backfill.ts for the invariant this protects.
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
        await runTaskSourceBackfill(client);
      } else if (file === TASK_SOURCE_INDEX_MIGRATION) {
        // Same reason again: `tasks` is written by the rules engine, the email queue, two crons, deal
        // reassignment and every person using the New Task form, so a plain CREATE INDEX inside the
        // file's DO block would hold a write-blocking SHARE lock across ALL offices until the last one
        // finished — on API boot. Build each tenant's index CONCURRENTLY first; the file's plain
        // statement then no-ops on existing schemas while remaining the marker the office provisioner
        // replays for new ones.
        //
        // The `source` column this indexes is added by 0233, which sorts EARLIER and has therefore
        // already run by the time we get here. That ordering is the whole reason the index is not in
        // 0233 itself: a pre-step cannot build an index on a column that does not exist yet, so sharing
        // one migration made this skip every schema on the first deploy and handed the blocking build
        // back to the file.
        await runTaskSourceIndexMigration(client);
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      } else if (file === BID_BOARD_INGEST_MIGRATION) {
        // CREATE INDEX CONCURRENTLY cannot run inside the file's implicit transaction, so build the two
        // public.job_queue indexes CONCURRENTLY here first (never blocking enqueue/outcome writes on the
        // accumulated prod queue); the file's plain `CREATE INDEX IF NOT EXISTS` then no-ops.
        await runBidBoardIngestIndexMigration(client);
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      } else if (file === FILES_ASSOCIATION_CHECK_REPAIR_MIGRATION) {
        // Install the persistent deferred public.offices guard FIRST. Old API containers can have the
        // previous 0232 baked into their image; CREATE TRIGGER serializes a transaction that already
        // inserted public.offices, and an old container that inserts afterward receives the guard at its
        // own COMMIT. Only then scan and repair existing offices one short transaction at a time. This
        // ordering leaves no scan-to-ledger window in which an old container can permanently strand a new
        // office with the obsolete CHECK; already-correct offices take no files-table lock at all.
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
        await runFilesAssociationCheckRepair(client);
      } else {
        const sql = readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
        await client.query(sql);
      }

      await client.query(
        "INSERT INTO public._migrations (name) VALUES ($1)",
        [file]
      );
      console.log(`Completed ${file}`);
    }

    console.log("All migrations complete.");
  } catch (err) {
    console.error("Migration failed:", err);
    process.exit(1);
  } finally {
    await client.end();
  }
}

runMigrations();
