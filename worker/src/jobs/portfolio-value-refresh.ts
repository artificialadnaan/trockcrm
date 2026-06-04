// worker/src/jobs/portfolio-value-refresh.ts
// Refreshes the Projects/Portfolio board Contract Values
// (office_*.portfolio_projects.total_value / value_synced_at) from SyncHub's
// public.procore_projects. Scheduled every 4 hours from worker/src/index.ts.
//
// The refresh CORE lives in the server package (server/src/modules/synchub/
// portfolio-projects-sync.ts) so it stays the single source of truth shared with the
// manual CLI; here we dynamic-import the compiled module (dist in prod, src in dev),
// mirroring the worker's other cross-package jobs.
//
// CRM side reuses the worker's existing pool (process.env.DATABASE_URL); the cross-DB
// SyncHub read uses a dedicated pg Client built from SYNCHUB_DATABASE_PUBLIC_URL /
// SYNCHUB_DATABASE_URL. A missing SyncHub URL or any failure is logged and skipped —
// the worker never crashes and simply retries on the next interval.

import { Client } from "pg";
import { pool } from "../db.js";

const PORTFOLIO_SYNC_MODULES = [
  "../../../server/dist/modules/synchub/portfolio-projects-sync.js",
  "../../../server/src/modules/synchub/portfolio-projects-sync.js",
] as const;

type QueryClient = { query: (sql: string, params?: any[]) => Promise<any> };

type PortfolioProjectValueRefreshResult = {
  crm: {
    matched: number;
    updated: number;
    alreadyCurrent: number;
    missingPortfolioProjectSkipped: number;
    missingOfficeSkipped: number;
  };
};

// Structural type of just the exports we call — keeps the worker typecheck independent of
// the server package (which is not a worker tsconfig reference), per the worker convention.
type PortfolioSyncModule = {
  resolveSyncHubDatabaseUrl: () => string;
  syncHubUrlMatchesCrm: (syncHubUrl: string | null | undefined, crmUrl: string | null | undefined) => boolean;
  runPortfolioProjectValueRefresh: (input: {
    mode: "commit" | "dry-run";
    crmClient: QueryClient;
    syncHubClient: QueryClient;
    refreshedAt?: Date;
    limit?: number | null;
  }) => Promise<PortfolioProjectValueRefreshResult>;
  runPortfolioValueRefreshGuarded: (deps: {
    execute: () => Promise<PortfolioProjectValueRefreshResult>;
    log?: (message: string) => void;
    logError?: (message: string, error: unknown) => void;
  }) => Promise<{ ok: boolean }>;
};

async function importFirstAvailable<T>(paths: readonly string[]): Promise<T> {
  let lastError: unknown;

  for (const path of paths) {
    try {
      return (await import(path)) as T;
    } catch (error) {
      lastError = error;
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Unable to import portfolio-projects-sync module");
}

export async function runPortfolioValueRefresh(): Promise<void> {
  let mod: PortfolioSyncModule;
  try {
    mod = await importFirstAvailable<PortfolioSyncModule>(PORTFOLIO_SYNC_MODULES);
  } catch (error) {
    console.error("[Worker:portfolio-value-refresh] failed to load sync module (will retry next interval):", error);
    return;
  }

  const syncHubDatabaseUrl = mod.resolveSyncHubDatabaseUrl();
  if (!syncHubDatabaseUrl) {
    console.warn(
      "[Worker:portfolio-value-refresh] SYNCHUB_DATABASE_PUBLIC_URL / SYNCHUB_DATABASE_URL not set — "
      + "skipping. Set it on the worker service to enable portfolio Contract Value refresh.",
    );
    return;
  }

  // Defense-in-depth (mirrors the CLI's crm===synchub guard): never run the cross-DB read
  // against the CRM database itself. The worker's CRM side is the pool on DATABASE_URL.
  if (mod.syncHubUrlMatchesCrm(syncHubDatabaseUrl, process.env.DATABASE_URL)) {
    console.error(
      "[Worker:portfolio-value-refresh] SyncHub database URL equals the CRM DATABASE_URL — "
      + "refusing to run. Set a distinct SYNCHUB_DATABASE_URL.",
    );
    return;
  }

  const crmClient = await pool.connect();
  const syncHubClient = new Client({
    connectionString: syncHubDatabaseUrl,
    ssl: { rejectUnauthorized: false },
  });

  try {
    await syncHubClient.connect();
    await mod.runPortfolioValueRefreshGuarded({
      execute: () => mod.runPortfolioProjectValueRefresh({ mode: "commit", crmClient, syncHubClient }),
      log: (message) => console.log(`[Worker:portfolio-value-refresh] ${message}`),
      logError: (message, error) => console.error(`[Worker:portfolio-value-refresh] ${message}:`, error),
    });
  } catch (error) {
    // Connection setup (e.g. syncHubClient.connect()) runs outside the guarded runner, so
    // swallow any failure here too — a transient SyncHub outage must not crash the worker.
    console.error("[Worker:portfolio-value-refresh] refresh setup failed (will retry next interval):", error);
  } finally {
    // Always free both connections, even if release() somehow throws, so the SyncHub
    // client is never leaked and the pool (max 10) can't be exhausted over many cycles.
    try {
      crmClient.release();
    } catch (releaseError) {
      console.error("[Worker:portfolio-value-refresh] failed to release CRM client:", releaseError);
    }
    await syncHubClient.end().catch(() => undefined);
  }
}
