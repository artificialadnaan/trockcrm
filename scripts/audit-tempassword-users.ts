import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

type AuditStatus = "ready" | "repairable" | "blocked";

export interface PendingTempPasswordUserRow {
  user_id: string;
  email: string;
  display_name: string;
  role: string | null;
  office_id: string | null;
  office_slug: string | null;
  user_is_active: boolean | null;
  password_hash: string;
  is_enabled: boolean;
  revoked_at: Date | string | null;
  locked_until: Date | string | null;
}

export interface AuditedTempPasswordUser {
  userId: string;
  email: string;
  status: AuditStatus;
  issues: string[];
  repaired: boolean;
}

function parseArgs(argv = process.argv.slice(2)) {
  let execute = false;
  const userIds = new Set<string>();
  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      execute = false;
      continue;
    }
    if (arg.startsWith("--user-id=")) {
      userIds.add(arg.slice("--user-id=".length));
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (execute && userIds.size === 0) {
    throw new Error("--execute requires at least one explicit --user-id=<uuid>");
  }
  return { execute, userIds };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (/railway\.internal/.test(selected)) {
    throw new Error("Database URL points at railway.internal. Use DATABASE_PUBLIC_URL from Railway Postgres.");
  }
  return selected;
}

export function hasValidScryptHashFormat(value: string) {
  const [scheme, saltHex, hashHex] = value.split("$");
  return (
    scheme === "scrypt" &&
    /^[0-9a-f]{32}$/i.test(saltHex ?? "") &&
    /^[0-9a-f]{128}$/i.test(hashHex ?? "")
  );
}

function isLocked(row: PendingTempPasswordUserRow, now = Date.now()) {
  return row.locked_until ? new Date(row.locked_until).getTime() > now : false;
}

export function auditTempPasswordUser(row: PendingTempPasswordUserRow): AuditedTempPasswordUser {
  const issues: string[] = [];

  if (!row.user_is_active) issues.push("user_inactive");
  if (!row.role) issues.push("missing_role");
  if (!row.office_id || !row.office_slug) issues.push("missing_office");
  if (!hasValidScryptHashFormat(row.password_hash)) issues.push("invalid_password_hash_format");
  if (!row.is_enabled) issues.push("local_auth_disabled");
  if (row.revoked_at) issues.push("local_auth_revoked");
  if (isLocked(row)) issues.push("local_auth_locked");

  const repairableIssues = new Set(["local_auth_disabled", "local_auth_locked"]);
  const hasBlockedIssue = issues.some((issue) => !repairableIssues.has(issue));
  const hasRepairableIssue = issues.some((issue) => repairableIssues.has(issue));

  return {
    userId: row.user_id,
    email: row.email,
    status: hasBlockedIssue ? "blocked" : hasRepairableIssue ? "repairable" : "ready",
    issues,
    repaired: false,
  };
}

async function fetchPendingUsers(client: Client) {
  const result = await client.query<PendingTempPasswordUserRow>(`
    SELECT
      u.id AS user_id,
      u.email,
      u.display_name,
      u.role::text AS role,
      u.office_id,
      o.slug AS office_slug,
      u.is_active AS user_is_active,
      ula.password_hash,
      ula.is_enabled,
      ula.revoked_at,
      ula.locked_until
    FROM public.user_local_auth ula
    JOIN public.users u ON u.id = ula.user_id
    LEFT JOIN public.offices o ON o.id = u.office_id
    WHERE ula.must_change_password = true
      AND lower(u.email) NOT LIKE '%@trock.test'
      AND lower(u.email) NOT LIKE '%@trock.dev'
    ORDER BY lower(u.email)
  `);
  return result.rows;
}

async function repairUser(client: Client, userId: string) {
  await client.query(
    `
      UPDATE public.user_local_auth
         SET is_enabled = true,
             locked_until = NULL,
             failed_login_attempts = 0,
             last_failed_login_at = NULL,
             updated_at = NOW()
       WHERE user_id = $1
    `,
    [userId]
  );
}

export function summarizeAudit(users: AuditedTempPasswordUser[]) {
  return {
    pendingFirstLogin: users.length,
    ready: users.filter((user) => user.status === "ready").length,
    repairable: users.filter((user) => user.status === "repairable").length,
    blocked: users.filter((user) => user.status === "blocked").length,
    repaired: users.filter((user) => user.repaired).length,
  };
}

export async function runAuditTempPasswordUsers(argv = process.argv.slice(2)) {
  const { execute, userIds } = parseArgs(argv);
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const rows = await fetchPendingUsers(client);
    const audited = rows.map(auditTempPasswordUser);

    if (execute) {
      await client.query("BEGIN");
      try {
        for (const user of audited) {
          if (user.status !== "repairable") continue;
          if (!userIds.has(user.userId)) continue;
          await repairUser(client, user.userId);
          user.repaired = true;
          user.status = "ready";
          user.issues = [];
        }
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    console.log(JSON.stringify({
      dryRun: !execute,
      summary: summarizeAudit(audited),
      users: audited.map((user) => ({
        userId: user.userId,
        email: user.email,
        status: user.status,
        issues: user.issues,
        repaired: user.repaired,
      })),
    }, null, 2));
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runAuditTempPasswordUsers().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
