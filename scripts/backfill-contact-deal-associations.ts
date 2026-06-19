/**
 * Backfill `contact_deal_associations` (cda) from `deals.primary_contact_id`.
 *
 * WHY A SCRIPT (not a migration): this is a one-time PROD DATA write that must be run DELIBERATELY, not
 * auto-applied on deploy. Like the region / file-category backfills, it is INERT until invoked, defaults to
 * a read-only dry-run, and only writes with an explicit `--commit`:
 *
 *     tsx scripts/backfill-contact-deal-associations.ts --dry-run   # census only, no writes
 *     tsx scripts/backfill-contact-deal-associations.ts --commit    # demote + upsert, in a txn per office
 *
 * WHAT IT DOES (mirrors the manual createAssociation writer EXACTLY):
 *   cda is empty in every office_* schema, yet office_dallas has ~752 deals carrying a primary_contact_id
 *   (HubSpot held the edges; migration 0027 repaired the deal-side column but never re-seeded cda). For each
 *   ACTIVE deal whose primary_contact_id is an ACTIVE contact, per office:
 *     1. DEMOTE any OTHER is_primary row on that deal (so each deal ends with exactly one primary; readers
 *        join on is_primary = true). Gated on an active target so a deal is never left primary-less.
 *     2. UPSERT the primary edge (ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true).
 *   Idempotent / replayable. Skips inactive/archived deals and inactive contacts (active-only).
 */
import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

type Mode = "dry-run" | "commit";

interface QueryClient {
  query: (text: string, params?: unknown[]) => Promise<{ rows: any[]; rowCount: number | null }>;
}

export interface SchemaCensus {
  schema: string;
  dealsWithPrimary: number;
  wouldUpsert: number; // active deal + active contact (insert-or-promote target)
  wouldDemote: number; // other is_primary rows that would be cleared
}
export interface SchemaCommit {
  schema: string;
  demoted: number;
  upserted: number;
}
export interface BackfillReport {
  mode: Mode;
  committed: boolean;
  census: SchemaCensus[];
  applied: SchemaCommit[];
  totals: { wouldUpsert: number; wouldDemote: number; upserted: number; demoted: number };
}

function parseArgs(argv = process.argv.slice(2)): { mode: Mode } {
  const hasDryRun = argv.includes("--dry-run");
  const hasCommit = argv.includes("--commit");
  if (hasDryRun === hasCommit) {
    throw new Error("Specify exactly one of --dry-run or --commit");
  }
  return { mode: hasCommit ? "commit" : "dry-run" };
}

function findCrmEnvPath(): string | null {
  const candidates = [
    path.resolve(process.cwd(), ".env"),
    path.resolve(process.cwd(), "..", ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  return candidates.find((candidate) => fs.existsSync(candidate)) ?? null;
}
function loadEnv() {
  const envPath = findCrmEnvPath();
  if (envPath) dotenv.config({ path: envPath });
  dotenv.config();
}
function resolveDatabaseUrl() {
  const url = process.env.CRM_DATABASE_URL?.trim() || process.env.DATABASE_PUBLIC_URL?.trim() || "";
  if (!url) throw new Error("Missing CRM database URL. Set CRM_DATABASE_URL or DATABASE_PUBLIC_URL.");
  return url;
}
function quoteIdent(identifier: string): string {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Invalid identifier: ${identifier}`);
  }
  return `"${identifier.replace(/"/g, '""')}"`;
}

async function fetchOfficeSchemas(client: QueryClient): Promise<string[]> {
  // Restrict to the office_* tenant schemas the app/provisioner own (never an ad-hoc/backup schema), and
  // require ALL THREE referenced tables so a partial schema can't abort the run when the SQL hits a missing
  // %I.contacts / %I.contact_deal_associations.
  const result = await client.query(
    `SELECT n.nspname AS schema_name
       FROM pg_namespace n
      WHERE n.nspname LIKE 'office\\_%' ESCAPE '\\'
        AND to_regclass(format('%I.deals', n.nspname)) IS NOT NULL
        AND to_regclass(format('%I.contacts', n.nspname)) IS NOT NULL
        AND to_regclass(format('%I.contact_deal_associations', n.nspname)) IS NOT NULL
      ORDER BY n.nspname ASC`
  );
  return result.rows.map((row: { schema_name: string }) => row.schema_name);
}

/**
 * The write statements, schema-qualified. EXPORTED so the runtime test executes the SHIPPED SQL (so
 * `--commit` and the test can never diverge). `lock` takes the same per-deal FOR UPDATE that
 * createAssociation/updateAssociation use (association-service.ts) to serialize primary changes, so running
 * --commit during a rolling deploy / concurrent manual edit can't leave two is_primary rows on a deal.
 * Active-deal + active-contact gated; order in --commit is lock → demote → upsert (in one txn per office).
 */
export function backfillStatements(schema: string): { lock: string; demote: string; upsert: string } {
  const s = quoteIdent(schema);
  const lock = `
    SELECT d.id
    FROM ${s}.deals d
    WHERE d.primary_contact_id IS NOT NULL
      AND d.is_active = true
      AND EXISTS (SELECT 1 FROM ${s}.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)
    FOR UPDATE`;
  const demote = `
    UPDATE ${s}.contact_deal_associations cda
       SET is_primary = false
    FROM ${s}.deals d
    WHERE cda.deal_id = d.id
      AND cda.is_primary = true
      AND cda.contact_id <> d.primary_contact_id
      AND d.primary_contact_id IS NOT NULL
      AND d.is_active = true
      AND EXISTS (SELECT 1 FROM ${s}.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)`;
  const upsert = `
    INSERT INTO ${s}.contact_deal_associations (contact_id, deal_id, is_primary)
    SELECT d.primary_contact_id, d.id, true
    FROM ${s}.deals d
    WHERE d.primary_contact_id IS NOT NULL
      AND d.is_active = true
      AND EXISTS (SELECT 1 FROM ${s}.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true)
    ON CONFLICT (contact_id, deal_id) DO UPDATE SET is_primary = true`;
  return { lock, demote, upsert };
}

/** Read-only census: rows the upsert would write + primaries the demote would clear (matches the predicates). */
export function censusQuery(schema: string): string {
  const s = quoteIdent(schema);
  return `
    SELECT
      (SELECT count(*) FROM ${s}.deals d WHERE d.primary_contact_id IS NOT NULL)::int AS deals_with_primary,
      (SELECT count(*) FROM ${s}.deals d
         WHERE d.primary_contact_id IS NOT NULL AND d.is_active = true
           AND EXISTS (SELECT 1 FROM ${s}.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true))::int AS would_upsert,
      (SELECT count(*) FROM ${s}.contact_deal_associations cda
         JOIN ${s}.deals d ON d.id = cda.deal_id
         WHERE cda.is_primary = true AND cda.contact_id <> d.primary_contact_id
           AND d.primary_contact_id IS NOT NULL AND d.is_active = true
           AND EXISTS (SELECT 1 FROM ${s}.contacts c WHERE c.id = d.primary_contact_id AND c.is_active = true))::int AS would_demote`;
}

export async function runBackfill(input: { client: QueryClient; mode: Mode }): Promise<BackfillReport> {
  const schemas = await fetchOfficeSchemas(input.client);
  const census: SchemaCensus[] = [];
  const applied: SchemaCommit[] = [];

  for (const schema of schemas) {
    const { rows } = await input.client.query(censusQuery(schema));
    const c = rows[0] ?? { deals_with_primary: 0, would_upsert: 0, would_demote: 0 };
    census.push({
      schema,
      dealsWithPrimary: Number(c.deals_with_primary ?? 0),
      wouldUpsert: Number(c.would_upsert ?? 0),
      wouldDemote: Number(c.would_demote ?? 0),
    });
  }

  if (input.mode === "commit") {
    for (const schema of schemas) {
      const { lock, demote, upsert } = backfillStatements(schema);
      await input.client.query("BEGIN");
      try {
        await input.client.query(lock); // hold the eligible deal rows so a concurrent createAssociation can't interleave a 2nd primary
        const demoteRes = await input.client.query(demote);
        const upsertRes = await input.client.query(upsert);
        await input.client.query("COMMIT");
        applied.push({ schema, demoted: demoteRes.rowCount ?? 0, upserted: upsertRes.rowCount ?? 0 });
      } catch (error) {
        await input.client.query("ROLLBACK");
        throw error;
      }
    }
  }

  const totals = {
    wouldUpsert: census.reduce((n, s) => n + s.wouldUpsert, 0),
    wouldDemote: census.reduce((n, s) => n + s.wouldDemote, 0),
    upserted: applied.reduce((n, s) => n + s.upserted, 0),
    demoted: applied.reduce((n, s) => n + s.demoted, 0),
  };

  return { mode: input.mode, committed: input.mode === "commit", census, applied, totals };
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  loadEnv();
  const client = new pg.Client({
    connectionString: resolveDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const result = await runBackfill({ client, mode: args.mode });
    console.log(JSON.stringify(result, null, 2));
    if (result.mode === "dry-run") {
      console.log(`\nDRY-RUN — no writes. Re-run with --commit to apply ${result.totals.wouldUpsert} upserts / ${result.totals.wouldDemote} demotes.`);
    } else {
      console.log(`\nCOMMITTED — ${result.totals.upserted} upserts / ${result.totals.demoted} demotes.`);
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
