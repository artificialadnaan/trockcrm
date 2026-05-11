import { procoreClient } from "../../lib/procore-client.js";
import {
  buildProjectMirrorFields,
  findExistingProjectSyncRow,
  findSourceDealIdForProcoreProject,
  upsertProjectMirror,
} from "./service.js";
import type { QueryExecutor } from "./service.js";

export interface ProjectsBackfillResult {
  companyId: string;
  backfilled: number;
  skipped: number;
  errored: number;
  errors: Array<{ procoreProjectId: string | null; message: string }>;
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

function savepointName(page: number, index: number) {
  return `projects_backfill_p${page}_i${index}`;
}

export async function runProjectsBackfill(
  client: QueryExecutor,
  schemaName: string,
  officeSlug: string,
  companyId = process.env.PROCORE_COMPANY_ID ?? "598134325683880"
): Promise<ProjectsBackfillResult> {
  const result: ProjectsBackfillResult = {
    companyId,
    backfilled: 0,
    skipped: 0,
    errored: 0,
    errors: [],
  };
  const perPage = 200;

  for (let page = 1; ; page += 1) {
    const rows = await procoreClient.get<unknown[]>(
      `/rest/v1.0/companies/${companyId}/projects?page=${page}&per_page=${perPage}`,
      { companyId }
    );
    if (!Array.isArray(rows) || rows.length === 0) break;

    for (let index = 0; index < rows.length; index += 1) {
      const row = rows[index];
      const normalized = normalizeProjectRow(row, companyId);
      if (!normalized) {
        result.errored += 1;
        result.errors.push({ procoreProjectId: null, message: "Malformed Procore project row" });
        continue;
      }

      // Per-row savepoint: if any DB statement for this row aborts the outer transaction,
      // ROLLBACK TO SAVEPOINT restores a clean state so the next row can still backfill.
      const sp = savepointName(page, index);
      await client.query(`SAVEPOINT ${sp}`);
      try {
        const fields = buildProjectMirrorFields({
          ...normalized,
          syncSource: "backfill",
        });
        const existing = await findExistingProjectSyncRow(client, normalized.procoreProjectId);
        if (existing && sameTimestamp(existing.procoreUpdatedAt, fields.procoreUpdatedAt)) {
          result.skipped += 1;
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          continue;
        }

        const sourceDealId = await findSourceDealIdForProcoreProject(
          client,
          normalized.procoreProjectId,
          normalized.procoreProjectNumber
        );
        if (!sourceDealId && !projectNumberBelongsToOffice(normalized.procoreProjectNumber, officeSlug)) {
          result.skipped += 1;
          await client.query(`RELEASE SAVEPOINT ${sp}`);
          continue;
        }

        await upsertProjectMirror(client as any, schemaName, {
          ...normalized,
          sourceDealId,
          syncSource: "backfill",
        });
        await client.query(`RELEASE SAVEPOINT ${sp}`);
        result.backfilled += 1;
      } catch (error) {
        await client.query(`ROLLBACK TO SAVEPOINT ${sp}`).catch(() => {});
        await client.query(`RELEASE SAVEPOINT ${sp}`).catch(() => {});
        result.errored += 1;
        result.errors.push({
          procoreProjectId: normalized.procoreProjectId,
          message: error instanceof Error ? error.message : "Unknown backfill error",
        });
      }
    }

    if (rows.length < perPage) break;
  }

  return result;
}
