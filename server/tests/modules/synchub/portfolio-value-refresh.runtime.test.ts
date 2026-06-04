import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  resolveSyncHubDatabaseUrl,
  runPortfolioProjectValueRefresh,
  runPortfolioValueRefreshGuarded,
  type PortfolioProjectValueRefreshResult,
  type ProcoreCompanyOfficeMapping,
} from "../../../src/modules/synchub/portfolio-projects-sync.js";
// The manual CLI script must keep working after the core is extracted: it re-exports
// the moved core, so its exports must be the SAME references the module provides.
import {
  runPortfolioProjectValueRefresh as refreshFromScript,
  runPortfolioProjectsSeed as seedFromScript,
  splitSeedCandidates as splitFromScript,
  summarizeSyncHubValueFreshness as summarizeFromScript,
} from "../../../../scripts/seed-portfolio-projects-from-synchub.js";

/**
 * Load-bearing guard for the automated portfolio Contract Value refresh.
 *
 * The Projects/Portfolio board reads office_*.portfolio_projects.total_value /
 * value_synced_at and flags anything older than 7 days as "Stale value as of …".
 * Those columns are only written by runPortfolioProjectValueRefresh, which reads
 * SyncHub's public.procore_projects and stamps value_synced_at from SyncHub's
 * last_synced_at (true data freshness — NOT the run time).
 *
 * Proven here against real SQL (PGlite) + the real refresh path:
 *   - total_value + value_synced_at are written from the SyncHub source row;
 *   - value_synced_at is stamped from SyncHub's last_synced_at (falling back to
 *     updated_at), never the cron run time;
 *   - re-running is idempotent (no spurious writes);
 *   - every mapped office schema is refreshed (per-tenant);
 *   - a relayed-but-unseeded project is skipped, never crashes the run;
 *   - a cross-DB read failure surfaces and is swallowed by the guarded runner so the
 *     worker never crashes (skip + log, retry next interval).
 */

const MAPPINGS: ProcoreCompanyOfficeMapping[] = [
  { procoreCompanyId: "CO_DALLAS", officeSchema: "office_dallas" },
  { procoreCompanyId: "CO_HOUSTON", officeSchema: "office_houston" },
];

let db: PGlite;
// runPortfolioProjectValueRefresh only needs a `query` executor; PGlite supplies real
// Postgres, so one client can stand in for BOTH the CRM and SyncHub connections (the
// public source tables and the office_* schemas all live in one database here).
const client = () =>
  ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

async function setupSchemas() {
  await db.exec(`
    CREATE TABLE public.procore_projects (
      procore_id text PRIMARY KEY,
      project_number text,
      name text,
      display_name text,
      stage text,
      project_stage_name text,
      active boolean,
      company_id text,
      company_name text,
      estimated_value text,
      total_value text,
      last_synced_at timestamptz,
      procore_updated_at timestamptz,
      updated_at timestamptz,
      properties jsonb
    );

    CREATE TABLE public.offices (
      id text PRIMARY KEY,
      slug text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO public.offices (id, slug, is_active, created_at) VALUES
      ('o-dallas', 'dallas', true, '2026-01-01T00:00:00.000Z'),
      ('o-houston', 'houston', true, '2026-01-02T00:00:00.000Z');

    CREATE SCHEMA office_dallas;
    CREATE SCHEMA office_houston;
  `);

  for (const schema of ["office_dallas", "office_houston"]) {
    await db.exec(`
      CREATE TABLE ${schema}.portfolio_projects (
        id text PRIMARY KEY DEFAULT gen_random_uuid()::text,
        procore_company_id text NOT NULL,
        procore_project_id text NOT NULL,
        project_number text,
        name text NOT NULL,
        current_stage text NOT NULL,
        current_stage_normalized text NOT NULL,
        current_stage_entered_at timestamptz,
        total_value numeric(14,2),
        value_synced_at timestamptz,
        is_board_relevant boolean NOT NULL DEFAULT true,
        first_seen_at timestamptz NOT NULL DEFAULT now(),
        updated_at timestamptz NOT NULL DEFAULT now(),
        UNIQUE (procore_company_id, procore_project_id)
      );
    `);
  }
}

async function insertSource(input: {
  procoreId: string;
  companyId: string;
  totalValue: string | null;
  lastSyncedAt: string | null;
  updatedAt?: string | null;
  stage?: string;
  active?: boolean;
}) {
  await db.query(
    `INSERT INTO public.procore_projects
       (procore_id, project_number, name, display_name, stage, project_stage_name,
        active, company_id, company_name, estimated_value, total_value,
        last_synced_at, procore_updated_at, updated_at, properties)
     VALUES ($1, 'PN-' || $1, 'Project ' || $1, NULL, $5, $5,
        $6, $2, 'T-Rock', NULL, $3, $4, NULL, $7, '{}'::jsonb)`,
    [
      input.procoreId,
      input.companyId,
      input.totalValue,
      input.lastSyncedAt,
      input.stage ?? "Buy Out",
      input.active ?? true,
      input.updatedAt ?? null,
    ],
  );
}

async function insertPortfolio(input: {
  schema: string;
  companyId: string;
  procoreId: string;
  totalValue: string | null;
  valueSyncedAt: string | null;
  stage?: string;
}) {
  const stage = input.stage ?? "Buy Out";
  await db.query(
    `INSERT INTO ${input.schema}.portfolio_projects
       (id, procore_company_id, procore_project_id, project_number, name,
        current_stage, current_stage_normalized, total_value, value_synced_at, is_board_relevant)
     VALUES ('pp-' || $1, $2, $1, 'PN-' || $1, 'Project ' || $1, $3, lower($3), $4, $5, true)`,
    [input.procoreId, input.companyId, stage, input.totalValue, input.valueSyncedAt],
  );
}

async function readPortfolio(schema: string, procoreId: string) {
  const result = await db.query<{ total_value: string | null; value_synced_at: string | Date | null }>(
    `SELECT total_value, value_synced_at FROM ${schema}.portfolio_projects WHERE procore_project_id = $1`,
    [procoreId],
  );
  const row = result.rows[0];
  return {
    totalValue: row?.total_value ?? null,
    valueSyncedAt: row?.value_synced_at ? new Date(row.value_synced_at).toISOString() : null,
  };
}

const refresh = (overrides: Partial<Parameters<typeof runPortfolioProjectValueRefresh>[0]> = {}) =>
  runPortfolioProjectValueRefresh({
    mode: "commit",
    crmClient: client(),
    syncHubClient: client(),
    mappings: MAPPINGS,
    ...overrides,
  });

describe("portfolio value refresh — real SQL (PGlite)", () => {
  beforeEach(async () => {
    db = new PGlite();
    await setupSchemas();
  });

  afterEach(async () => {
    await db?.close();
  });

  it("writes total_value + value_synced_at into portfolio_projects from the SyncHub source row", async () => {
    await insertSource({ procoreId: "PJ1", companyId: "CO_DALLAS", totalValue: "125000.75", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ1", totalValue: null, valueSyncedAt: null });

    const result = await refresh();

    expect(result.crm.matched).toBe(1);
    expect(result.crm.updated).toBe(1);
    const row = await readPortfolio("office_dallas", "PJ1");
    expect(row.totalValue).toBe("125000.75");
    expect(row.valueSyncedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("stamps value_synced_at from SyncHub last_synced_at, NOT the cron run time", async () => {
    await insertSource({ procoreId: "PJ1", companyId: "CO_DALLAS", totalValue: "500.00", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ1", totalValue: null, valueSyncedAt: null });

    const runTime = new Date("2026-12-31T23:59:59.000Z");
    const result = await refresh({ refreshedAt: runTime });

    const row = await readPortfolio("office_dallas", "PJ1");
    expect(row.valueSyncedAt).toBe("2026-06-01T00:00:00.000Z");
    expect(row.valueSyncedAt).not.toBe(runTime.toISOString());
    // refreshedAt is a label only; it must not leak into the freshness stamp.
    expect(result.refreshedAt).toBe(runTime.toISOString());
  });

  it("falls back to SyncHub updated_at when last_synced_at is null", async () => {
    await insertSource({ procoreId: "PJ2", companyId: "CO_DALLAS", totalValue: "42.00", lastSyncedAt: null, updatedAt: "2026-05-20T08:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ2", totalValue: null, valueSyncedAt: null });

    await refresh();

    const row = await readPortfolio("office_dallas", "PJ2");
    expect(row.valueSyncedAt).toBe("2026-05-20T08:00:00.000Z");
  });

  it("is idempotent — a second run writes nothing and leaves the values intact", async () => {
    await insertSource({ procoreId: "PJ1", companyId: "CO_DALLAS", totalValue: "999.99", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ1", totalValue: null, valueSyncedAt: null });

    const first = await refresh();
    const second = await refresh();

    expect(first.crm.updated).toBe(1);
    expect(second.crm.updated).toBe(0);
    expect(second.crm.alreadyCurrent).toBeGreaterThanOrEqual(1);
    const row = await readPortfolio("office_dallas", "PJ1");
    expect(row.totalValue).toBe("999.99");
    expect(row.valueSyncedAt).toBe("2026-06-01T00:00:00.000Z");
  });

  it("refreshes every mapped office schema (per-tenant)", async () => {
    await insertSource({ procoreId: "PJ1", companyId: "CO_DALLAS", totalValue: "111.00", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertSource({ procoreId: "PJ2", companyId: "CO_HOUSTON", totalValue: "222.00", lastSyncedAt: "2026-06-02T00:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ1", totalValue: null, valueSyncedAt: null });
    await insertPortfolio({ schema: "office_houston", companyId: "CO_HOUSTON", procoreId: "PJ2", totalValue: null, valueSyncedAt: null });

    const result = await refresh();

    expect(result.crm.updated).toBe(2);
    expect(result.byOffice["office_dallas"]?.updated).toBe(1);
    expect(result.byOffice["office_houston"]?.updated).toBe(1);
    expect((await readPortfolio("office_dallas", "PJ1")).totalValue).toBe("111.00");
    expect((await readPortfolio("office_houston", "PJ2")).totalValue).toBe("222.00");
  });

  it("skips a relayed-but-unseeded project without crashing the run", async () => {
    await insertSource({ procoreId: "PJ1", companyId: "CO_DALLAS", totalValue: "777.00", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertSource({ procoreId: "PJ_NOROW", companyId: "CO_DALLAS", totalValue: "888.00", lastSyncedAt: "2026-06-01T00:00:00.000Z" });
    await insertPortfolio({ schema: "office_dallas", companyId: "CO_DALLAS", procoreId: "PJ1", totalValue: null, valueSyncedAt: null });

    const result = await refresh();

    expect(result.crm.updated).toBe(1);
    expect(result.crm.missingPortfolioProjectSkipped).toBeGreaterThanOrEqual(1);
    expect((await readPortfolio("office_dallas", "PJ1")).totalValue).toBe("777.00");
  });

  it("a cross-DB read failure rejects the refresh and is swallowed by the guarded runner", async () => {
    const failing = {
      query: () => Promise.reject(new Error("SyncHub DB unreachable")),
    } as any;

    await expect(
      runPortfolioProjectValueRefresh({ mode: "commit", crmClient: client(), syncHubClient: failing, mappings: MAPPINGS }),
    ).rejects.toThrow(/unreachable/i);

    const errors: unknown[] = [];
    const outcome = await runPortfolioValueRefreshGuarded({
      execute: () => runPortfolioProjectValueRefresh({ mode: "commit", crmClient: client(), syncHubClient: failing, mappings: MAPPINGS }),
      logError: (_msg, err) => errors.push(err),
    });

    expect(outcome.ok).toBe(false);
    expect(errors).toHaveLength(1);
  });
});

describe("resolveSyncHubDatabaseUrl", () => {
  const KEYS = ["SYNCHUB_DATABASE_PUBLIC_URL", "SYNCHUB_DATABASE_URL", "SYNCHUB_DATABASE_URI"] as const;
  let saved: Record<string, string | undefined>;

  beforeEach(() => {
    saved = {};
    for (const key of KEYS) {
      saved[key] = process.env[key];
      delete process.env[key];
    }
  });

  afterEach(() => {
    for (const key of KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  it("returns the empty string when no SyncHub URL is configured", () => {
    expect(resolveSyncHubDatabaseUrl()).toBe("");
  });

  it("prefers SYNCHUB_DATABASE_PUBLIC_URL over SYNCHUB_DATABASE_URL", () => {
    process.env.SYNCHUB_DATABASE_URL = "postgres://private/synchub";
    process.env.SYNCHUB_DATABASE_PUBLIC_URL = "postgres://public/synchub";
    expect(resolveSyncHubDatabaseUrl()).toBe("postgres://public/synchub");
  });

  it("falls back to SYNCHUB_DATABASE_URL when the public URL is absent", () => {
    process.env.SYNCHUB_DATABASE_URL = "postgres://private/synchub";
    expect(resolveSyncHubDatabaseUrl()).toBe("postgres://private/synchub");
  });
});

describe("runPortfolioValueRefreshGuarded", () => {
  const sampleResult = {
    crm: { matched: 3, updated: 2, alreadyCurrent: 1, missingPortfolioProjectSkipped: 0, missingOfficeSkipped: 0, wouldUpdate: 0 },
  } as unknown as PortfolioProjectValueRefreshResult;

  it("returns ok with the result and logs a summary on success", async () => {
    const logs: string[] = [];
    const outcome = await runPortfolioValueRefreshGuarded({
      execute: async () => sampleResult,
      log: (msg) => logs.push(msg),
    });

    expect(outcome).toEqual({ ok: true, result: sampleResult });
    expect(logs.length).toBeGreaterThanOrEqual(1);
  });

  it("swallows a thrown error, returns ok:false, and never rethrows", async () => {
    const boom = new Error("boom");
    const errors: unknown[] = [];
    const outcome = await runPortfolioValueRefreshGuarded({
      execute: async () => {
        throw boom;
      },
      logError: (_msg, err) => errors.push(err),
    });

    expect(outcome).toEqual({ ok: false, error: boom });
    expect(errors).toEqual([boom]);
  });
});

describe("manual CLI re-export surface stays intact", () => {
  it("the script re-exports the SAME moved core (manual run keeps working)", () => {
    expect(refreshFromScript).toBe(runPortfolioProjectValueRefresh);
    expect(typeof seedFromScript).toBe("function");
    expect(typeof splitFromScript).toBe("function");
    expect(typeof summarizeFromScript).toBe("function");
  });
});
