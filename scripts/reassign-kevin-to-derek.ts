import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

export const OFFICE_SCHEMAS = ["office_dallas", "office_atlanta", "office_pwauditoffice"] as const;
const FROM_USER_NAME = "Kevin Scott";
const TO_USER_NAME = "Derek Barr";

export type Mode = "dry-run" | "rollback-check" | "commit";
type OfficeSchema = (typeof OFFICE_SCHEMAS)[number];
type EntityTable = "deals" | "leads" | "contacts" | "companies";

export interface Args {
  mode: Mode;
  backupDir: string;
}

export interface AssignmentTarget {
  entityType: EntityTable;
  table: EntityTable;
  column: string;
  nullable: boolean;
  reason: string;
}

interface UserRecord {
  id: string;
  display_name: string;
  first_name: string | null;
  last_name: string | null;
  email: string;
  role: string;
  is_active: boolean;
  office_id: string;
}

interface BackupField {
  field: string;
  oldValue: string;
}

interface BackupRow {
  officeSchema: string;
  entityType: string;
  table: string;
  rowId: string;
  fields: BackupField[];
}

interface CountRow {
  officeSchema: string;
  entityType: string;
  table: string;
  field: string;
  count: number;
}

export const ASSIGNMENT_TARGETS: AssignmentTarget[] = [
  {
    entityType: "deals",
    table: "deals",
    column: "assigned_rep_id",
    nullable: true,
    reason: "deal Sales Rep assignment",
  },
  {
    entityType: "leads",
    table: "leads",
    column: "assigned_rep_id",
    nullable: false,
    reason: "lead primary assigned rep",
  },
  {
    entityType: "leads",
    table: "leads",
    column: "sales_rep_id",
    nullable: true,
    reason: "lead secondary sales rep field",
  },
  {
    entityType: "contacts",
    table: "contacts",
    column: "owner_id",
    nullable: true,
    reason: "contact owner",
  },
  {
    entityType: "companies",
    table: "companies",
    column: "owner_id",
    nullable: true,
    reason: "company owner",
  },
  {
    entityType: "companies",
    table: "companies",
    column: "assigned_approver_user_id",
    nullable: true,
    reason: "company verification approver assignment",
  },
];

const USAGE = `Usage:
  node --import tsx scripts/reassign-kevin-to-derek.ts --dry-run [--backup-dir=/private/tmp]
  node --import tsx scripts/reassign-kevin-to-derek.ts --rollback-check [--backup-dir=/private/tmp]
  node --import tsx scripts/reassign-kevin-to-derek.ts --commit [--backup-dir=/private/tmp]

Exactly one mode flag is required. --commit writes production data and must only run after dry-run count confirmation.`;

export function parseArgs(argv: string[]): Args {
  const hasDryRun = argv.includes("--dry-run");
  const hasRollbackCheck = argv.includes("--rollback-check");
  const hasCommit = argv.includes("--commit");
  const modeCount = [hasDryRun, hasRollbackCheck, hasCommit].filter(Boolean).length;
  if (modeCount !== 1) {
    throw new Error(`Specify exactly one of --dry-run, --rollback-check, or --commit.\n${USAGE}`);
  }

  const backupDirArg = argv.find((arg) => arg.startsWith("--backup-dir="));
  const backupDir = backupDirArg ? backupDirArg.slice("--backup-dir=".length) : os.tmpdir();
  if (!path.isAbsolute(backupDir)) {
    throw new Error("--backup-dir must be an absolute path");
  }

  return {
    mode: hasCommit ? "commit" : hasRollbackCheck ? "rollback-check" : "dry-run",
    backupDir,
  };
}

function loadEnv() {
  const candidates = [
    path.join(process.cwd(), ".env"),
    path.resolve(process.cwd(), "../..", ".env"),
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath });
      return;
    }
  }
  dotenv.config();
}

function getDatabaseUrl() {
  const databaseUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  if (!databaseUrl) throw new Error("DATABASE_PUBLIC_URL is required");
  if (/railway\.internal/.test(databaseUrl)) {
    throw new Error("DATABASE_PUBLIC_URL must be externally reachable, not railway.internal");
  }
  return databaseUrl;
}

function quoteIdent(identifier: string) {
  return pg.escapeIdentifier(identifier);
}

export function buildUpdateSql(schema: string, target: AssignmentTarget) {
  return `
UPDATE ${quoteIdent(schema)}.${quoteIdent(target.table)}
SET ${quoteIdent(target.column)} = $2::uuid,
    ${quoteIdent("updated_at")} = NOW()
WHERE ${quoteIdent(target.column)} = $1::uuid
RETURNING id::text
`.trim();
}

function buildSelectAffectedSql(schema: string, target: AssignmentTarget) {
  return `
SELECT id::text AS id, ${quoteIdent(target.column)}::text AS old_value
FROM ${quoteIdent(schema)}.${quoteIdent(target.table)}
WHERE ${quoteIdent(target.column)} = $1::uuid
ORDER BY id
`.trim();
}

function buildCountSql(schema: string, target: AssignmentTarget) {
  return `
SELECT COUNT(*)::int AS count
FROM ${quoteIdent(schema)}.${quoteIdent(target.table)}
WHERE ${quoteIdent(target.column)} = $1::uuid
`.trim();
}

async function resolveExactUser(client: pg.Client, displayName: string) {
  const { rows } = await client.query<UserRecord>(
    `
    SELECT id, display_name, first_name, last_name, email, role, is_active, office_id
    FROM public.users
    WHERE lower(display_name) = lower($1)
       OR lower(trim(coalesce(first_name, '') || ' ' || coalesce(last_name, ''))) = lower($1)
    ORDER BY is_active DESC, display_name, email
    `,
    [displayName],
  );

  if (rows.length !== 1) {
    const records = rows.map((row) => ({
      id: row.id,
      displayName: row.display_name,
      email: row.email,
      role: row.role,
      isActive: row.is_active,
      officeId: row.office_id,
    }));
    throw new Error(`Expected exactly one user record for ${displayName}; found ${rows.length}: ${JSON.stringify(records)}`);
  }

  const [user] = rows;
  if (!user.is_active) {
    throw new Error(`User ${displayName} resolved to inactive account ${user.id}; refusing to proceed without disambiguation.`);
  }
  return user;
}

async function assertExpectedColumnsExist(client: pg.Client) {
  for (const schema of OFFICE_SCHEMAS) {
    for (const target of ASSIGNMENT_TARGETS) {
      const { rows } = await client.query(
        `
        SELECT column_name
        FROM information_schema.columns
        WHERE table_schema = $1
          AND table_name = $2
          AND column_name = $3
          AND udt_name = 'uuid'
        `,
        [schema, target.table, target.column],
      );
      if (rows.length !== 1) {
        throw new Error(`Missing expected uuid assignment column ${schema}.${target.table}.${target.column}`);
      }
    }
  }
}

async function discoverPotentialAssignmentColumns(client: pg.Client) {
  const { rows } = await client.query<{
    table_schema: string;
    table_name: string;
    column_name: string;
    data_type: string;
    udt_name: string;
  }>(
    `
    SELECT table_schema, table_name, column_name, data_type, udt_name
    FROM information_schema.columns
    WHERE table_schema = ANY($1)
      AND table_name = ANY($2)
      AND (
        column_name IN ('owner_id', 'assigned_rep_id', 'sales_rep_id')
        OR column_name LIKE '%owner%'
        OR column_name LIKE '%assigned%'
        OR column_name LIKE '%rep%'
        OR column_name LIKE '%user_id%'
      )
    ORDER BY table_schema, table_name, ordinal_position
    `,
    [OFFICE_SCHEMAS, ["deals", "leads", "contacts", "companies"]],
  );
  return rows;
}

function assertNoUnknownAssignmentColumns(columns: Array<{ table_name: string; column_name: string; udt_name: string }>) {
  const allowed = new Set([
    ...ASSIGNMENT_TARGETS.map((target) => `${target.table}.${target.column}`),
    "deals.hubspot_owner_id",
    "deals.hubspot_owner_email",
    "deals.ownership_synced_at",
    "deals.ownership_sync_status",
    "deals.unassigned_reason_code",
    "deals.bid_board_assigned_pm",
    "deals.created_by_user_id",
    "leads.hubspot_owner_id",
    "leads.hubspot_owner_email",
    "leads.ownership_synced_at",
    "leads.ownership_sync_status",
    "leads.unassigned_reason_code",
    "leads.created_by_user_id",
  ]);

  const unknown = columns.filter((column) => !allowed.has(`${column.table_name}.${column.column_name}`));
  if (unknown.length > 0) {
    throw new Error(`Found unclassified assignment-like columns; review before proceeding: ${JSON.stringify(unknown)}`);
  }
}

async function collectCounts(client: pg.Client, userId: string): Promise<CountRow[]> {
  const counts: CountRow[] = [];
  for (const schema of OFFICE_SCHEMAS) {
    for (const target of ASSIGNMENT_TARGETS) {
      const { rows } = await client.query<{ count: number }>(buildCountSql(schema, target), [userId]);
      counts.push({
        officeSchema: schema,
        entityType: target.entityType,
        table: target.table,
        field: target.column,
        count: Number(rows[0]?.count ?? 0),
      });
    }
  }
  return counts;
}

async function collectBackupRows(client: pg.Client, fromUserId: string): Promise<BackupRow[]> {
  const grouped = new Map<string, BackupRow>();
  for (const schema of OFFICE_SCHEMAS) {
    for (const target of ASSIGNMENT_TARGETS) {
      const { rows } = await client.query<{ id: string; old_value: string }>(buildSelectAffectedSql(schema, target), [fromUserId]);
      for (const row of rows) {
        const key = `${schema}:${target.table}:${row.id}`;
        const existing = grouped.get(key) ?? {
          officeSchema: schema,
          entityType: target.entityType,
          table: target.table,
          rowId: row.id,
          fields: [],
        };
        existing.fields.push({ field: target.column, oldValue: row.old_value });
        grouped.set(key, existing);
      }
    }
  }
  return [...grouped.values()].sort((left, right) =>
    `${left.officeSchema}:${left.table}:${left.rowId}`.localeCompare(`${right.officeSchema}:${right.table}:${right.rowId}`),
  );
}

function backupPath(backupDir: string, mode: Mode) {
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  return path.join(backupDir, `kevin-to-derek-reassignment-${mode}-${stamp}.json`);
}

async function writeBackup(backupDir: string, mode: Mode, payload: unknown) {
  await fs.promises.mkdir(backupDir, { recursive: true });
  const filePath = backupPath(backupDir, mode);
  await fs.promises.writeFile(filePath, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
  return filePath;
}

async function applyUpdates(client: pg.Client, fromUserId: string, toUserId: string) {
  const results: CountRow[] = [];
  for (const schema of OFFICE_SCHEMAS) {
    for (const target of ASSIGNMENT_TARGETS) {
      const updated = await client.query<{ id: string }>(buildUpdateSql(schema, target), [fromUserId, toUserId]);
      results.push({
        officeSchema: schema,
        entityType: target.entityType,
        table: target.table,
        field: target.column,
        count: updated.rowCount ?? updated.rows.length,
      });
    }
  }
  return results;
}

function totalCount(counts: CountRow[]) {
  return counts.reduce((sum, row) => sum + row.count, 0);
}

function printCounts(label: string, counts: CountRow[]) {
  console.log(`\n${label}`);
  for (const row of counts) {
    console.log(`${row.officeSchema}.${row.table}.${row.field}: ${row.count}`);
  }
  console.log(`TOTAL_FIELD_UPDATES: ${totalCount(counts)}`);
}

function publicUser(user: UserRecord) {
  return {
    id: user.id,
    displayName: user.display_name,
    email: user.email,
    role: user.role,
    isActive: user.is_active,
    officeId: user.office_id,
  };
}

async function run(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);
  loadEnv();

  const client = new Client({
    connectionString: getDatabaseUrl(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const fromUser = await resolveExactUser(client, FROM_USER_NAME);
    const toUser = await resolveExactUser(client, TO_USER_NAME);
    console.log(`FROM_USER ${JSON.stringify(publicUser(fromUser))}`);
    console.log(`TO_USER ${JSON.stringify(publicUser(toUser))}`);

    await assertExpectedColumnsExist(client);
    const discoveredColumns = await discoverPotentialAssignmentColumns(client);
    assertNoUnknownAssignmentColumns(discoveredColumns);
    console.log("ASSIGNMENT_TARGETS");
    for (const target of ASSIGNMENT_TARGETS) {
      console.log(`${target.table}.${target.column}: ${target.reason}`);
    }

    const beforeCounts = await collectCounts(client, fromUser.id);
    printCounts("BEFORE_COUNTS", beforeCounts);
    const backupRows = await collectBackupRows(client, fromUser.id);
    const backupFile = await writeBackup(args.backupDir, args.mode, {
      mode: args.mode,
      generatedAt: new Date().toISOString(),
      fromUser: publicUser(fromUser),
      toUser: publicUser(toUser),
      counts: beforeCounts,
      rows: backupRows,
    });
    console.log(`BACKUP_FILE ${backupFile}`);

    if (args.mode === "dry-run") {
      console.log("DRY_RUN_ONLY no writes performed");
      return;
    }

    await client.query("BEGIN");
    try {
      const updatedCounts = await applyUpdates(client, fromUser.id, toUser.id);
      printCounts("UPDATED_COUNTS", updatedCounts);

      if (totalCount(updatedCounts) !== totalCount(beforeCounts)) {
        throw new Error(`Updated count ${totalCount(updatedCounts)} did not match before count ${totalCount(beforeCounts)}`);
      }

      const remainingCounts = await collectCounts(client, fromUser.id);
      printCounts("REMAINING_KEVIN_COUNTS_IN_TRANSACTION", remainingCounts);
      if (totalCount(remainingCounts) !== 0) {
        throw new Error(`Kevin references remain after update: ${totalCount(remainingCounts)}`);
      }

      if (args.mode === "rollback-check") {
        await client.query("ROLLBACK");
        console.log("ROLLBACK_CHECK_COMPLETE transaction rolled back");
        return;
      }

      await client.query("COMMIT");
      console.log("COMMIT_COMPLETE transaction committed");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }

    const postCommitCounts = await collectCounts(client, fromUser.id);
    printCounts("POST_COMMIT_REMAINING_KEVIN_COUNTS", postCommitCounts);
    if (totalCount(postCommitCounts) !== 0) {
      throw new Error(`Post-commit Kevin references remain: ${totalCount(postCommitCounts)}`);
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
