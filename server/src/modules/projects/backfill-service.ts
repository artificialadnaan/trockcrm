import type { Pool, PoolClient } from "pg";
import { procoreClient } from "../../lib/procore-client.js";
import {
  buildProjectMirrorFields,
  findExistingProjectSyncRow,
  findSourceDealIdForProcoreProject,
  quoteIdent,
  upsertProjectMirror,
} from "./service.js";

export interface ProjectsBackfillResult {
  companyId: string;
  backfilled: number;
  skipped: number;
  errored: number;
  errors: Array<{ procoreProjectId: string | null; message: string }>;
}

export interface ProjectsBackfillOptions {
  companyId?: string;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function readString(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "bigint" || typeof value === "boolean") {
    return String(value);
  }
  return null;
}

function normalizeProjectRow(row: unknown, companyId: string) {
  const snapshot = asRecord(row);
  if (!snapshot) return null;
  const procoreProjectId = readString(snapshot.id ?? snapshot.procore_id ?? snapshot.procoreId);
  if (!procoreProjectId) return null;
  const procoreProjectNumber = readString(snapshot.project_number ?? snapshot.projectNumber);
  return {
    procoreProjectId,
    procoreCompanyId: readString(snapshot.company_id ?? snapshot.companyId) ?? companyId,
    procoreProjectNumber,
    name:
      readString(snapshot.display_name ?? snapshot.displayName) ??
      readString(snapshot.name) ??
      procoreProjectNumber ??
      `Procore project ${procoreProjectId}`,
    snapshot,
  };
}

function sameTimestamp(left: string | null, right: string | null) {
  if (!left || !right) return false;
  const leftDate = new Date(left);
  const rightDate = new Date(right);
  if (Number.isNaN(leftDate.getTime()) || Number.isNaN(rightDate.getTime())) return left === right;
  return leftDate.getTime() === rightDate.getTime();
}

const OFFICE_PROJECT_PREFIXES: Record<string, string[]> = {
  dallas: ["DFW"],
  atlanta: ["ATL"],
};

function projectNumberBelongsToOffice(projectNumber: string | null | undefined, officeSlug: string) {
  const prefixes = OFFICE_PROJECT_PREFIXES[officeSlug] ?? [];
  if (prefixes.length === 0) return false;
  const normalized = (projectNumber ?? "").trim().toUpperCase();
  return prefixes.some((prefix) => normalized.startsWith(`${prefix}-`));
}

async function processRow(
  client: PoolClient,
  schemaName: string,
  officeSlug: string,
  companyId: string,
  row: unknown,
  result: ProjectsBackfillResult
) {
  const normalized = normalizeProjectRow(row, companyId);
  if (!normalized) {
    result.errored += 1;
    result.errors.push({ procoreProjectId: null, message: "Malformed Procore project row" });
    return;
  }

  // Each row runs in its own short-lived transaction so a single failure
  // cannot abort the rest of the batch. The Procore HTTP fetch happens
  // outside of any transaction, so an idle-in-transaction timeout cannot
  // terminate the connection mid-backfill.
  await client.query("BEGIN");
  try {
    const fields = buildProjectMirrorFields({ ...normalized, syncSource: "backfill" });
    const existing = await findExistingProjectSyncRow(client, normalized.procoreProjectId);
    if (existing && sameTimestamp(existing.procoreUpdatedAt, fields.procoreUpdatedAt)) {
      await client.query("COMMIT");
      result.skipped += 1;
      return;
    }

    const sourceDealId = await findSourceDealIdForProcoreProject(
      client,
      normalized.procoreProjectId,
      normalized.procoreProjectNumber
    );
    if (!sourceDealId && !projectNumberBelongsToOffice(normalized.procoreProjectNumber, officeSlug)) {
      await client.query("COMMIT");
      result.skipped += 1;
      return;
    }

    await upsertProjectMirror(client, schemaName, {
      ...normalized,
      sourceDealId,
      syncSource: "backfill",
    });
    await client.query("COMMIT");
    result.backfilled += 1;
  } catch (error) {
    await client.query("ROLLBACK").catch((rollbackError) => {
      console.error(
        "[ProjectsBackfill] ROLLBACK failed after row error",
        { procoreProjectId: normalized.procoreProjectId, rollbackError }
      );
    });
    result.errored += 1;
    result.errors.push({
      procoreProjectId: normalized.procoreProjectId,
      message: error instanceof Error ? error.message : "Unknown backfill error",
    });
  }
}

export async function runProjectsBackfill(
  pool: Pool,
  schemaName: string,
  officeSlug: string,
  options: ProjectsBackfillOptions = {}
): Promise<ProjectsBackfillResult> {
  const companyId = options.companyId ?? process.env.PROCORE_COMPANY_ID ?? "598134325683880";
  const result: ProjectsBackfillResult = {
    companyId,
    backfilled: 0,
    skipped: 0,
    errored: 0,
    errors: [],
  };
  const perPage = 200;

  const client = await pool.connect();
  try {
    // Session-level search_path so per-row transactions can address tenant
    // tables unqualified where needed (e.g. `FROM projects`, `FROM deals`).
    // Qualified writes still use `schemaName.table` to make routing explicit.
    // We RESET search_path in the finally below so the client returns to the
    // pool in a clean state — node-postgres does not call DISCARD ALL on
    // release, and a stale search_path would leak to the next consumer.
    await client.query(`SET search_path TO ${quoteIdent(schemaName)}, public`);

    for (let page = 1; ; page += 1) {
      // HTTP fetch happens with NO active transaction, so Postgres's
      // idle_in_transaction_session_timeout cannot kill the connection
      // while Procore is responding.
      const rows = await procoreClient.get<unknown[]>(
        `/rest/v1.0/companies/${companyId}/projects?page=${page}&per_page=${perPage}`,
        { companyId }
      );
      if (!Array.isArray(rows) || rows.length === 0) break;

      for (const row of rows) {
        await processRow(client, schemaName, officeSlug, companyId, row, result);
      }

      if (rows.length < perPage) break;
    }
  } finally {
    // Reset session state before returning the client to the pool so the
    // next consumer doesn't inherit our search_path.
    await client.query("RESET search_path").catch((resetError) => {
      console.error("[ProjectsBackfill] RESET search_path failed before release", {
        schemaName,
        officeSlug,
        resetError,
      });
    });
    client.release();
  }

  return result;
}
