import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

export type SmokeCleanupRecordType = "deal" | "contact" | "company";

export interface KnownSmokeCleanupAssignment {
  label: string;
  assignmentId: string;
  recordType: SmokeCleanupRecordType;
  recordId: string;
  expectedNamePattern: RegExp;
}

export interface ResolvedAssignment {
  expected: KnownSmokeCleanupAssignment;
  assignmentId: string | null;
  statusBefore: string | null;
  recordName: string | null;
  found: boolean;
}

export interface ReseedSummaryInput {
  assignmentId: string | null;
  statusBefore: string | null;
  found: boolean;
}

export const KNOWN_SMOKE_CLEANUP_ASSIGNMENTS: KnownSmokeCleanupAssignment[] = [
  {
    label: "company: example company",
    assignmentId: "465095c6-23a0-4ae8-a91e-65fcc71c889e",
    recordType: "company",
    recordId: "40833bf3-24a1-5c6d-9abc-17b50b9a9ea2",
    expectedNamePattern: /SMOKE TEST DELETE - Example Company/i,
  },
  {
    label: "contact: smoke contact one",
    assignmentId: "e1b5a2bc-af13-4aad-9de2-072f3d43f468",
    recordType: "contact",
    recordId: "41394184-9ec0-55a8-b1ab-8fe2cdd7f7a7",
    expectedNamePattern: /Smoke Contact One/i,
  },
  {
    label: "contact: smoke contact two",
    assignmentId: "884be155-df94-43f0-a8a5-9176bdb7c4c2",
    recordType: "contact",
    recordId: "2ca8b8ee-b091-53ac-9cf6-b6f7c0eb8ec1",
    expectedNamePattern: /Smoke Contact Two|smoke-contact-two@example\.invalid/i,
  },
  {
    label: "deal: missing amount",
    assignmentId: "693bc918-2644-4675-b0a4-25117290538e",
    recordType: "deal",
    recordId: "51efa4f6-833c-5b52-8abe-83a75c39c601",
    expectedNamePattern: /SMOKE TEST DELETE - Missing Amount/i,
  },
  {
    label: "deal: missing company",
    assignmentId: "28a92456-aaa5-4716-b55d-d3717a742a83",
    recordType: "deal",
    recordId: "70adce31-9bc3-5ef1-a98e-c06e1d39aa7c",
    expectedNamePattern: /SMOKE TEST DELETE - Missing Company/i,
  },
  {
    label: "deal: missing contact",
    assignmentId: "1cefe62e-a5c2-49d6-9594-205e12afd517",
    recordType: "deal",
    recordId: "e34757d0-3657-5506-a0da-e2af16fb2829",
    expectedNamePattern: /SMOKE TEST DELETE - Missing Contact/i,
  },
];

export function parseReseedSmokeCleanupArgs(argv = process.argv.slice(2)) {
  let execute = false;
  let tenant = "office_dallas";
  let email = "test-sales@trock.test";

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      execute = false;
      continue;
    }
    if (arg === "--tenant") {
      tenant = argv[++i] ?? tenant;
      continue;
    }
    if (arg === "--email") {
      email = argv[++i] ?? email;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return { execute, tenant, email };
}

export function buildReseedSummary(rows: ReseedSummaryInput[]) {
  const foundRows = rows.filter((row) => row.found);
  const alreadyPending = foundRows.filter((row) => row.statusBefore === "pending").length;
  return {
    found: foundRows.length,
    missing: rows.length - foundRows.length,
    alreadyPending,
    toUpdate: foundRows.length - alreadyPending,
  };
}

export function selectAssignmentsToUpdate(rows: ResolvedAssignment[]) {
  return rows.filter((row) => row.found && row.statusBefore !== "pending");
}

function assertSafeTenant(tenant: string) {
  if (!/^office_[a-z0-9_]+$/.test(tenant)) {
    throw new Error(`Unsafe tenant schema: ${tenant}`);
  }
}

function quoteIdent(identifier: string) {
  return `"${identifier.replace(/"/g, '""')}"`;
}

function recordNameSql(recordType: SmokeCleanupRecordType) {
  if (recordType === "deal") return "r.name";
  if (recordType === "company") return "r.name";
  return "concat_ws(' ', r.first_name, r.last_name, r.email)";
}

function recordTable(recordType: SmokeCleanupRecordType) {
  if (recordType === "deal") return "deals";
  if (recordType === "company") return "companies";
  return "contacts";
}

async function pendingCount(client: Client, tenant: string, userId: string) {
  const result = await client.query<{ count: string }>(
    `
      SELECT count(*)::text AS count
      FROM ${quoteIdent(tenant)}.cleanup_assignments
      WHERE assigned_to = $1
        AND status = 'pending'
    `,
    [userId]
  );
  return Number(result.rows[0]?.count ?? 0);
}

async function resolveAssignment(
  client: Client,
  tenant: string,
  userId: string,
  expected: KnownSmokeCleanupAssignment
): Promise<ResolvedAssignment> {
  const table = recordTable(expected.recordType);
  const nameSql = recordNameSql(expected.recordType);
  const byAssignment = await client.query<{
    assignment_id: string;
    status: string;
    record_name: string | null;
  }>(
    `
      SELECT ca.id AS assignment_id, ca.status, ${nameSql} AS record_name
      FROM ${quoteIdent(tenant)}.cleanup_assignments ca
      LEFT JOIN ${quoteIdent(tenant)}.${quoteIdent(table)} r
        ON r.id = ca.record_id
      WHERE ca.id = $1
        AND ca.assigned_to = $2
      LIMIT 1
    `,
    [expected.assignmentId, userId]
  );

  const row = byAssignment.rows[0];
  if (row?.record_name && expected.expectedNamePattern.test(row.record_name)) {
    return {
      expected,
      assignmentId: row.assignment_id,
      statusBefore: row.status,
      recordName: row.record_name,
      found: true,
    };
  }

  const fallback = await client.query<{
    assignment_id: string;
    status: string;
    record_name: string | null;
  }>(
    `
      SELECT ca.id AS assignment_id, ca.status, ${nameSql} AS record_name
      FROM ${quoteIdent(tenant)}.cleanup_assignments ca
      JOIN ${quoteIdent(tenant)}.${quoteIdent(table)} r
        ON r.id = ca.record_id
      WHERE ca.record_type = $1
        AND ca.record_id = $2
        AND ca.assigned_to = $3
      ORDER BY ca.created_at DESC NULLS LAST
      LIMIT 1
    `,
    [expected.recordType, expected.recordId, userId]
  );

  const fallbackRow = fallback.rows[0];
  const fallbackNameMatches =
    Boolean(fallbackRow?.record_name) && expected.expectedNamePattern.test(fallbackRow!.record_name!);
  return {
    expected,
    assignmentId: fallbackNameMatches ? fallbackRow!.assignment_id : null,
    statusBefore: fallbackNameMatches ? fallbackRow!.status : null,
    recordName: fallbackRow?.record_name ?? row?.record_name ?? null,
    found: fallbackNameMatches,
  };
}

export async function runReseedSmokeCleanup(argv = process.argv.slice(2)) {
  const options = parseReseedSmokeCleanupArgs(argv);
  assertSafeTenant(options.tenant);

  const connectionString = process.env.DATABASE_PUBLIC_URL || process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL or DATABASE_PUBLIC_URL is required");

  const client = new Client({ connectionString });
  await client.connect();
  try {
    const userResult = await client.query<{ id: string }>(
      "SELECT id FROM public.users WHERE lower(email) = lower($1) LIMIT 1",
      [options.email]
    );
    const userId = userResult.rows[0]?.id;
    if (!userId) throw new Error(`Smoke user not found: ${options.email}`);

    const beforePending = await pendingCount(client, options.tenant, userId);
    const resolved = [];
    for (const expected of KNOWN_SMOKE_CLEANUP_ASSIGNMENTS) {
      resolved.push(await resolveAssignment(client, options.tenant, userId, expected));
    }

    const summary = buildReseedSummary(resolved);
    console.log(`[smoke-cleanup] mode=${options.execute ? "execute" : "dry-run"} tenant=${options.tenant} user=${options.email}`);
    console.log(`[smoke-cleanup] pending_before=${beforePending}`);
    for (const row of resolved) {
      console.log(
        `[smoke-cleanup] ${row.found ? "FOUND" : "MISSING"} ${row.expected.label} assignment=${row.assignmentId ?? row.expected.assignmentId} status=${row.statusBefore ?? "n/a"} record="${row.recordName ?? "n/a"}"`
      );
    }
    console.log(`[smoke-cleanup] found=${summary.found} missing=${summary.missing} already_pending=${summary.alreadyPending} to_update=${summary.toUpdate}`);

    if (summary.missing > 0) {
      throw new Error("Refusing to reseed because one or more smoke cleanup assignments/records are missing");
    }

    if (options.execute) {
      await client.query("BEGIN");
      try {
        let updated = 0;
        for (const row of selectAssignmentsToUpdate(resolved)) {
          const result = await client.query(
            `
              UPDATE ${quoteIdent(options.tenant)}.cleanup_assignments
              SET status = 'pending',
                  updated_at = now()
              WHERE id = $1
                AND assigned_to = $2
                AND record_type = $3
                AND record_id = $4
                AND status <> 'pending'
            `,
            [row.assignmentId, userId, row.expected.recordType, row.expected.recordId]
          );
          updated += result.rowCount ?? 0;
        }
        if (updated !== summary.toUpdate) {
          throw new Error(`Expected to update ${summary.toUpdate} smoke cleanup assignments, updated ${updated}`);
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const afterPending = await pendingCount(client, options.tenant, userId);
    console.log(`[smoke-cleanup] pending_after=${afterPending}`);
    if (!options.execute) {
      console.log("[smoke-cleanup] dry run only; pass --execute to write");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runReseedSmokeCleanup().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
