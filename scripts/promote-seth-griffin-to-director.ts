/**
 * Promote Seth Griffin's existing T-Rock Field account to an active CRM Director account.
 *
 * This is intentionally a one-off operator tool rather than a generic Admin Users escape hatch:
 * normal field_contractor <-> CRM role changes remain blocked in the application because those
 * lifecycles have different invite and audit semantics.  Seth already has the canonical user row,
 * so this preserves its UUID, office, history, assignments, external identities, and local password.
 *
 * Usage:
 *   node --import tsx scripts/promote-seth-griffin-to-director.ts --dry-run --operator-email=admin@trockgc.com
 *   node --import tsx scripts/promote-seth-griffin-to-director.ts --commit --operator-email=admin@trockgc.com
 *
 * The tool makes no password change and never silently re-enables disabled/revoked local auth.  It
 * reports that condition so the operator can use the audited Admin Users “Send Invite” flow after
 * promotion if a fresh CRM credential is needed.
 */
import dotenv from "dotenv";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

const { Client } = pg;

export const SETH_GRIFFIN_EMAIL = "sgriffin@trockgc.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type PromoteMode = "dry-run" | "commit";

export interface PromoteArgs {
  mode: PromoteMode;
  operatorEmail: string;
  backupDir: string;
}

export interface QueryResult<T> {
  rows: T[];
  rowCount?: number | null;
}

export interface QueryableClient {
  query<T = unknown>(
    text: string,
    values?: unknown[],
  ): Promise<QueryResult<T>>;
}

export interface TargetUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
  token_version: number;
  office_id: string;
  office_slug: string;
  local_auth_present: boolean;
  local_auth_enabled: boolean | null;
  local_auth_must_change_password: boolean | null;
  local_auth_revoked_at: string | null;
  local_auth_locked_until: string | null;
  local_auth_invite_expires_at: string | null;
  local_auth_last_login_at: string | null;
}

export interface OperatorRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  is_active: boolean;
}

export interface OfficeAccessRow {
  office_slug: string;
  role_override: string | null;
}

export type PromotionAction = "promote" | "reactivate" | "noop";
export type LoginReadiness =
  | "ready"
  | "password_change_required"
  | "temporarily_locked"
  | "send_invite_required";

export interface PromotionPlan {
  action: PromotionAction;
  loginReadiness: LoginReadiness;
  target: TargetUserRow;
  operator: OperatorRow;
  officeAccess: OfficeAccessRow[];
}

export interface PromotionResult {
  mode: PromoteMode;
  committed: boolean;
  snapshotPath: string | null;
  plan: PromotionPlan;
}

export interface PromotionDeps {
  client: QueryableClient;
  argv: string[];
  logger?: Pick<Console, "log" | "warn">;
  writeSnapshot?: (filePath: string, contents: string) => Promise<void>;
  now?: () => Date;
}

function normalizeEmail(value: string): string {
  const email = value.trim().toLowerCase();
  if (!EMAIL_RE.test(email)) throw new Error(`Invalid email address: ${value}`);
  return email;
}

export function parsePromoteSethArgs(argv: string[]): PromoteArgs {
  let mode: PromoteMode | null = null;
  let operatorEmail: string | null = null;
  let backupDir = os.tmpdir();

  for (const arg of argv) {
    if (arg === "--dry-run" || arg === "--commit") {
      const nextMode: PromoteMode = arg === "--commit" ? "commit" : "dry-run";
      if (mode) throw new Error("Specify exactly one of --dry-run or --commit.");
      mode = nextMode;
      continue;
    }
    if (arg.startsWith("--operator-email=")) {
      if (operatorEmail) throw new Error("Specify --operator-email exactly once.");
      operatorEmail = normalizeEmail(arg.slice("--operator-email=".length));
      continue;
    }
    if (arg.startsWith("--backup-dir=")) {
      backupDir = arg.slice("--backup-dir=".length);
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  if (!mode) throw new Error("Specify exactly one of --dry-run or --commit. No default is assumed.");
  if (!operatorEmail) throw new Error("--operator-email is required so the tenant audit record has a human actor.");
  if (!path.isAbsolute(backupDir)) throw new Error("--backup-dir must be an absolute path.");

  return { mode, operatorEmail, backupDir };
}

function findEnvFile(startDir: string): string | null {
  let current = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(current, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return null;
}

function loadEnvFromNearestFile(): void {
  // Prefer an .env beside the script, but allow a separately-created worktree to be executed
  // with the primary checkout as its working directory. This keeps credentials out of the
  // worktree while still allowing the exact reviewed source to be run.
  const envFile = findEnvFile(path.dirname(fileURLToPath(import.meta.url))) ?? findEnvFile(process.cwd());
  if (envFile) dotenv.config({ path: envFile });
}

function databaseUrl(): string {
  const value = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!value) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required.");
  if (/railway\.internal/i.test(value)) {
    throw new Error("Database URL points at railway.internal; use the externally reachable DATABASE_PUBLIC_URL.");
  }
  return value;
}

function quotedIdentifier(identifier: string): string {
  return pg.escapeIdentifier(identifier);
}

export function tenantSchemaForOfficeSlug(slug: string): string {
  const normalized = slug.trim().toLowerCase();
  if (!/^[a-z][a-z0-9_]*$/.test(normalized)) throw new Error(`Invalid office slug: ${slug}`);
  return `office_${normalized}`;
}

function targetSelectSql(forUpdate: boolean): string {
  return `
    SELECT
      u.id::text AS id,
      u.email,
      u.display_name,
      u.role::text AS role,
      u.is_active,
      u.token_version,
      u.office_id::text AS office_id,
      o.slug AS office_slug,
      (local_auth.user_id IS NOT NULL) AS local_auth_present,
      local_auth.is_enabled AS local_auth_enabled,
      local_auth.must_change_password AS local_auth_must_change_password,
      local_auth.revoked_at::text AS local_auth_revoked_at,
      local_auth.locked_until::text AS local_auth_locked_until,
      local_auth.invite_expires_at::text AS local_auth_invite_expires_at,
      local_auth.last_login_at::text AS local_auth_last_login_at
    FROM public.users u
    INNER JOIN public.offices o ON o.id = u.office_id
    LEFT JOIN public.user_local_auth local_auth ON local_auth.user_id = u.id
    WHERE lower(u.email) = lower($1)
    ORDER BY u.id
    ${forUpdate ? "FOR UPDATE OF u" : ""}
  `;
}

async function resolveTarget(client: QueryableClient, forUpdate: boolean): Promise<TargetUserRow> {
  const result = await client.query<TargetUserRow>(targetSelectSql(forUpdate), [SETH_GRIFFIN_EMAIL]);
  if (result.rows.length !== 1) {
    throw new Error(`Expected exactly one Seth Griffin account at ${SETH_GRIFFIN_EMAIL}; found ${result.rows.length}.`);
  }
  return result.rows[0]!;
}

async function resolveOperator(client: QueryableClient, email: string): Promise<OperatorRow> {
  const result = await client.query<OperatorRow>(`
    SELECT id::text AS id, email, display_name, role::text AS role, is_active
    FROM public.users
    WHERE lower(email) = lower($1)
    ORDER BY id
  `, [email]);
  if (result.rows.length !== 1) {
    throw new Error(`Expected exactly one operator account at ${email}; found ${result.rows.length}.`);
  }
  const operator = result.rows[0]!;
  if (!operator.is_active || operator.role !== "admin") {
    throw new Error(`Operator ${email} must be an active admin; found role=${operator.role} active=${operator.is_active}.`);
  }
  return operator;
}

async function resolveOfficeAccess(client: QueryableClient, userId: string): Promise<OfficeAccessRow[]> {
  const result = await client.query<OfficeAccessRow>(`
    SELECT office.slug AS office_slug, grants.role_override::text AS role_override
    FROM public.user_office_access grants
    INNER JOIN public.offices office ON office.id = grants.office_id
    WHERE grants.user_id = $1::uuid
    ORDER BY office.slug
  `, [userId]);
  return result.rows;
}

function isFutureTimestamp(value: string | null, currentTime: Date): boolean {
  if (!value) return false;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) && timestamp > currentTime.getTime();
}

function isExpiredUnusedInvite(target: TargetUserRow, currentTime: Date): boolean {
  if (target.local_auth_last_login_at || !target.local_auth_invite_expires_at) return false;
  const timestamp = new Date(target.local_auth_invite_expires_at).getTime();
  return Number.isFinite(timestamp) && timestamp <= currentTime.getTime();
}

export function loginReadiness(target: TargetUserRow, currentTime: Date = new Date()): LoginReadiness {
  if (!target.local_auth_present || target.local_auth_enabled !== true || target.local_auth_revoked_at) {
    return "send_invite_required";
  }
  if (isFutureTimestamp(target.local_auth_locked_until, currentTime)) return "temporarily_locked";
  if (isExpiredUnusedInvite(target, currentTime)) return "send_invite_required";
  if (target.local_auth_must_change_password) return "password_change_required";
  return "ready";
}

export function buildPromotionPlan(
  target: TargetUserRow,
  operator: OperatorRow,
  officeAccess: OfficeAccessRow[],
  currentTime: Date = new Date(),
): PromotionPlan {
  let action: PromotionAction;
  if (target.role === "field_contractor") {
    action = "promote";
  } else if (target.role === "director" && !target.is_active) {
    action = "reactivate";
  } else if (target.role === "director" && target.is_active) {
    action = "noop";
  } else {
    throw new Error(
      `Refusing unexpected Seth role ${target.role}; expected field_contractor or director. No account was changed.`,
    );
  }

  return { action, loginReadiness: loginReadiness(target, currentTime), target, operator, officeAccess };
}

function publicTarget(target: TargetUserRow) {
  return {
    id: target.id,
    email: target.email,
    displayName: target.display_name,
    role: target.role,
    isActive: target.is_active,
    tokenVersion: target.token_version,
    officeId: target.office_id,
    officeSlug: target.office_slug,
    localAuth: {
      present: target.local_auth_present,
      enabled: target.local_auth_enabled,
      mustChangePassword: target.local_auth_must_change_password,
      revoked: Boolean(target.local_auth_revoked_at),
      lockedUntil: target.local_auth_locked_until,
      inviteExpiresAt: target.local_auth_invite_expires_at,
      lastLoginAt: target.local_auth_last_login_at,
    },
  };
}

function publicOperator(operator: OperatorRow) {
  return { id: operator.id, email: operator.email, displayName: operator.display_name, role: operator.role };
}

function snapshotFilePath(backupDir: string, now: Date): string {
  const stamp = now.toISOString().replace(/[:.]/g, "-");
  return path.join(backupDir, `promote-seth-griffin-to-director-${stamp}.json`);
}

async function defaultWriteSnapshot(filePath: string, contents: string): Promise<void> {
  await fs.promises.mkdir(path.dirname(filePath), { recursive: true });
  await fs.promises.writeFile(filePath, contents, "utf8");
}

export function buildPromoteUserSql(): string {
  return `
    UPDATE public.users
    SET role = 'director'::user_role,
        is_active = true,
        token_version = token_version + 1,
        updated_at = now()
    WHERE id = $1::uuid
      AND (
        role = 'field_contractor'::user_role
        OR (role = 'director'::user_role AND is_active = false)
      )
    RETURNING id::text AS id, role::text AS role, is_active, token_version
  `;
}

export function buildAuditInsertSql(tenantSchema: string): string {
  return `
    INSERT INTO ${quotedIdentifier(tenantSchema)}.audit_log
      (table_name, record_id, action, changed_by, changes, full_row, created_at)
    VALUES
      ('users', $1::uuid, 'update'::public.audit_action, $2::uuid, $3::jsonb, $4::jsonb, now())
  `;
}

async function assertAuditLogExists(client: QueryableClient, tenantSchema: string): Promise<void> {
  const relation = `${tenantSchema}.audit_log`;
  const result = await client.query<{ relation: string | null }>(
    "SELECT to_regclass($1)::text AS relation",
    [relation],
  );
  if (result.rows[0]?.relation !== relation) {
    throw new Error(`Expected tenant audit log ${relation} before changing a user role.`);
  }
}

function promotionChanges(target: TargetUserRow) {
  return {
    role: { from: target.role, to: "director" },
    is_active: { from: target.is_active, to: true },
    token_version: { from: target.token_version, to: target.token_version + 1 },
  };
}

function snapshotPayload(args: PromoteArgs, plan: PromotionPlan, now: Date) {
  return {
    purpose: "Promote Seth Griffin's existing field account to CRM Director without changing the user UUID or password.",
    mode: args.mode,
    generatedAt: now.toISOString(),
    target: publicTarget(plan.target),
    operator: publicOperator(plan.operator),
    action: plan.action,
    loginReadiness: plan.loginReadiness,
    extraOfficeAccess: plan.officeAccess,
    rollback: {
      role: plan.target.role,
      isActive: plan.target.is_active,
      tokenVersion: plan.target.token_version,
      note: "Do not restore token_version downward; issue a fresh administrative update to invalidate sessions instead.",
    },
  };
}

function logPlan(logger: Pick<Console, "log" | "warn">, plan: PromotionPlan): void {
  logger.log(`TARGET ${JSON.stringify(publicTarget(plan.target))}`);
  logger.log(`OPERATOR ${JSON.stringify(publicOperator(plan.operator))}`);
  logger.log(`ACTION ${plan.action}`);
  logger.log(`LOGIN_READINESS ${plan.loginReadiness}`);
  logger.log(`EXTRA_OFFICE_ACCESS ${JSON.stringify(plan.officeAccess)}`);
  if (plan.loginReadiness === "send_invite_required") {
    logger.warn("LOCAL_AUTH_RECOVERY_REQUIRED: use Admin Users → Send Invite after promotion; this tool will not alter passwords or re-enable revoked/disabled local auth.");
  }
  if (plan.loginReadiness === "temporarily_locked") {
    logger.warn(`LOCAL_AUTH_TEMPORARILY_LOCKED: login remains unavailable until ${plan.target.local_auth_locked_until}; this tool will not clear the security lock.`);
  }
  if (plan.officeAccess.some((access) => access.role_override === "field_contractor")) {
    logger.warn("FIELD_ROLE_OVERRIDE_PRESENT: extra-office role overrides are preserved and may restrict Seth on that office. Review before expecting director access there.");
  }
}

export async function runPromoteSethGriffin(deps: PromotionDeps): Promise<PromotionResult> {
  const args = parsePromoteSethArgs(deps.argv);
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const writeSnapshot = deps.writeSnapshot ?? defaultWriteSnapshot;

  const target = await resolveTarget(deps.client, false);
  const operator = await resolveOperator(deps.client, args.operatorEmail);
  const officeAccess = await resolveOfficeAccess(deps.client, target.id);
  const previewPlan = buildPromotionPlan(target, operator, officeAccess, now());
  logPlan(logger, previewPlan);

  if (args.mode === "dry-run") {
    logger.log("DRY_RUN_ONLY no database writes performed");
    return { mode: args.mode, committed: false, snapshotPath: null, plan: previewPlan };
  }

  await deps.client.query("BEGIN");
  try {
    // Re-read and lock after the dry-run preview. The preflight can never become an authorization to
    // overwrite a concurrently changed account state.
    const lockedTarget = await resolveTarget(deps.client, true);
    const lockedOperator = await resolveOperator(deps.client, args.operatorEmail);
    const lockedOfficeAccess = await resolveOfficeAccess(deps.client, lockedTarget.id);
    const plan = buildPromotionPlan(lockedTarget, lockedOperator, lockedOfficeAccess, now());
    logPlan(logger, plan);

    if (plan.action === "noop") {
      await deps.client.query("ROLLBACK");
      logger.log("NOOP_ALREADY_ACTIVE_DIRECTOR no database writes performed");
      return { mode: args.mode, committed: false, snapshotPath: null, plan };
    }

    const tenantSchema = tenantSchemaForOfficeSlug(plan.target.office_slug);
    await assertAuditLogExists(deps.client, tenantSchema);

    // The snapshot is intentionally persisted before the data writes and before COMMIT. A filesystem
    // failure leaves the transaction rolled back rather than committing an unrecoverable promotion.
    const snapshotPath = snapshotFilePath(args.backupDir, now());
    await writeSnapshot(snapshotPath, `${JSON.stringify(snapshotPayload(args, plan, now()), null, 2)}\n`);

    const updated = await deps.client.query<{
      id: string;
      role: string;
      is_active: boolean;
      token_version: number;
    }>(buildPromoteUserSql(), [plan.target.id]);
    if (updated.rows.length !== 1) {
      throw new Error("Seth's account changed after the lock or no longer has a promotable role; rolled back.");
    }
    const after = updated.rows[0]!;
    if (after.role !== "director" || !after.is_active || after.token_version !== plan.target.token_version + 1) {
      throw new Error("Promotion postcondition failed; rolled back.");
    }

    await deps.client.query(buildAuditInsertSql(tenantSchema), [
      plan.target.id,
      plan.operator.id,
      JSON.stringify(promotionChanges(plan.target)),
      JSON.stringify({ ...publicTarget(plan.target), role: "director", isActive: true, tokenVersion: after.token_version }),
    ]);
    await deps.client.query("COMMIT");
    logger.log(`COMMIT_COMPLETE Seth Griffin is now an active Director; old sessions are invalidated at token version ${after.token_version}.`);
    return { mode: args.mode, committed: true, snapshotPath, plan };
  } catch (error) {
    await deps.client.query("ROLLBACK").catch(() => undefined);
    throw error;
  }
}

async function main(): Promise<void> {
  loadEnvFromNearestFile();
  const client = new Client({ connectionString: databaseUrl(), ssl: { rejectUnauthorized: false } });
  await client.connect();
  try {
    await runPromoteSethGriffin({
      client: client as unknown as QueryableClient,
      argv: process.argv.slice(2),
    });
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  });
}
