import path from "node:path";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const SMOKE_EMAILS = new Set([
  "test-sales@trock.test",
  "test-admin@trock.test",
  "test-director@trock.test",
]);

const LOCAL_AUTH_ROLES = new Set(["admin", "director", "rep", "construction"]);

export interface RealUserLocalAuthRow {
  user_id: string;
  email: string;
  display_name: string | null;
  role: string | null;
  office_slug: string | null;
  user_is_active: boolean | null;
  must_change_password: boolean;
  is_enabled: boolean;
  revoked_at: Date | string | null;
  invite_expires_at: Date | string | null;
  last_login_at: Date | string | null;
}

export interface ForcePasswordChangePlanItem {
  userId: string;
  email: string;
  displayName: string | null;
  role: string;
  office: string | null;
  action: "force_password_change";
  clearInviteExpiresAt: boolean;
  inviteExpiresAt: string | null;
  lastLoginAt: string | null;
}

export function parseForcePasswordChangeArgs(argv = process.argv.slice(2)) {
  let execute = false;
  let sawExecute = false;
  let sawDryRun = false;
  for (const arg of argv) {
    if (arg === "--execute") {
      sawExecute = true;
      execute = true;
      continue;
    }
    if (arg === "--dry-run") {
      sawDryRun = true;
      execute = false;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (sawExecute && sawDryRun) {
    throw new Error("Use either --dry-run or --execute, not both");
  }
  return { execute };
}

function connectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (/railway\.internal/.test(selected)) {
    throw new Error("Database URL points at railway.internal. Use DATABASE_PUBLIC_URL from Railway Postgres.");
  }
  return selected;
}

function normalizeEmail(email: string) {
  return email.trim().toLowerCase();
}

function isTestOrSmokeEmail(email: string) {
  const normalized = normalizeEmail(email);
  return normalized.endsWith("@trock.test") ||
    normalized.endsWith("@trock.dev") ||
    SMOKE_EMAILS.has(normalized);
}

function toIsoString(value: Date | string | null) {
  if (!value) return null;
  return new Date(value).toISOString();
}

function hasExpiredInviteWithoutLogin(row: RealUserLocalAuthRow, now: Date) {
  return Boolean(
    !row.last_login_at &&
    row.invite_expires_at &&
    new Date(row.invite_expires_at).getTime() <= now.getTime()
  );
}

export function buildForcePasswordChangePlan(
  rows: RealUserLocalAuthRow[],
  now = new Date()
): ForcePasswordChangePlanItem[] {
  return rows
    .filter((row) => {
      if (isTestOrSmokeEmail(row.email)) return false;
      if (!row.user_is_active) return false;
      if (!row.is_enabled) return false;
      if (row.revoked_at) return false;
      if (!row.role || !LOCAL_AUTH_ROLES.has(row.role)) return false;
      return !row.must_change_password;
    })
    .map((row) => ({
      userId: row.user_id,
      email: row.email,
      displayName: row.display_name,
      role: row.role!,
      office: row.office_slug,
      action: "force_password_change" as const,
      clearInviteExpiresAt: hasExpiredInviteWithoutLogin(row, now),
      inviteExpiresAt: toIsoString(row.invite_expires_at),
      lastLoginAt: toIsoString(row.last_login_at),
    }))
    .sort((left, right) => left.email.localeCompare(right.email));
}

export function summarizeForcePasswordPlan(plan: ForcePasswordChangePlanItem[]) {
  return {
    affected: plan.length,
    clearInviteExpiresAt: plan.filter((item) => item.clearInviteExpiresAt).length,
  };
}

function summarizeCurrentRows(rows: RealUserLocalAuthRow[]) {
  const eligible = rows.filter((row) => (
    !isTestOrSmokeEmail(row.email) &&
    row.user_is_active &&
    row.is_enabled &&
    !row.revoked_at &&
    row.role !== null &&
    LOCAL_AUTH_ROLES.has(row.role)
  ));
  return {
    eligibleRealUsers: eligible.length,
    currentlyMustChangeTrue: eligible.filter((row) => row.must_change_password).length,
    currentlyMustChangeFalse: eligible.filter((row) => !row.must_change_password).length,
    skippedFieldContractor: rows.filter((row) => row.role === "field_contractor").length,
  };
}

async function fetchRealLocalAuthRows(client: Client) {
  const result = await client.query<RealUserLocalAuthRow>(`
    SELECT
      u.id AS user_id,
      u.email,
      u.display_name,
      u.role::text AS role,
      o.slug AS office_slug,
      u.is_active AS user_is_active,
      ula.must_change_password,
      ula.is_enabled,
      ula.revoked_at,
      ula.invite_expires_at,
      ula.last_login_at
    FROM public.user_local_auth ula
    JOIN public.users u ON u.id = ula.user_id
    LEFT JOIN public.offices o ON o.id = u.office_id
    WHERE lower(u.email) NOT LIKE '%@trock.test'
      AND lower(u.email) NOT LIKE '%@trock.dev'
    ORDER BY lower(u.email)
  `);
  return result.rows;
}

export function buildForcePasswordChangeUpdate(plan: ForcePasswordChangePlanItem[]) {
  const userIds = plan.map((item) => item.userId);
  const clearInviteUserIds = plan
    .filter((item) => item.clearInviteExpiresAt)
    .map((item) => item.userId);

  if (userIds.length === 0) return null;

  return {
    text: `
      WITH eligible AS (
        SELECT
          ula.user_id,
          ula.invite_expires_at,
          u.id = ANY($2::uuid[]) AS clear_invite_expires_at
        FROM public.user_local_auth ula
        JOIN public.users u ON u.id = ula.user_id
        WHERE ula.user_id = ANY($1::uuid[])
          AND ula.must_change_password = false
          AND ula.is_enabled = true
          AND ula.revoked_at IS NULL
          AND u.is_active = true
          AND u.role::text = ANY($3::text[])
          AND lower(u.email) NOT LIKE '%@trock.test'
          AND lower(u.email) NOT LIKE '%@trock.dev'
      ), updated AS (
        UPDATE public.user_local_auth ula
           SET must_change_password = true,
               invite_expires_at = CASE
                 WHEN eligible.clear_invite_expires_at THEN NULL
                 ELSE ula.invite_expires_at
               END,
               updated_at = NOW()
          FROM eligible
         WHERE ula.user_id = eligible.user_id
         RETURNING ula.user_id, eligible.clear_invite_expires_at
      )
      INSERT INTO public.user_local_auth_events (user_id, event_type, metadata)
      SELECT
        user_id,
        'password_change_forced'::local_auth_event_type,
        jsonb_build_object(
          'source', 'force-password-change-real-users',
          'reason', 'go_live_reenable',
          'clearedInviteExpiresAt', clear_invite_expires_at
        )
      FROM updated
    `,
    values: [userIds, clearInviteUserIds, Array.from(LOCAL_AUTH_ROLES)],
  };
}

async function applyPlan(client: Client, plan: ForcePasswordChangePlanItem[]) {
  const update = buildForcePasswordChangeUpdate(plan);
  if (!update) return;

  await client.query(update.text, update.values);
}

export async function runForcePasswordChangeRealUsers(argv = process.argv.slice(2)) {
  const { execute } = parseForcePasswordChangeArgs(argv);
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const beforeRows = await fetchRealLocalAuthRows(client);
    const plan = buildForcePasswordChangePlan(beforeRows);

    if (execute) {
      await client.query("BEGIN");
      try {
        await applyPlan(client, plan);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const afterRows = execute ? await fetchRealLocalAuthRows(client) : beforeRows;

    console.log(JSON.stringify({
      dryRun: !execute,
      before: summarizeCurrentRows(beforeRows),
      plan: summarizeForcePasswordPlan(plan),
      after: summarizeCurrentRows(afterRows),
      affectedUsers: plan.map((item) => ({
        email: item.email,
        role: item.role,
        office: item.office,
        clearInviteExpiresAt: item.clearInviteExpiresAt,
      })),
    }, null, 2));
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runForcePasswordChangeRealUsers().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
