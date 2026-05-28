/**
 * Provisions ONE new user — Caleb Stone (cstone@trockgc.com) — as a Dallas sales rep.
 *
 * This script inserts ONLY the rows the in-app admin UI cannot create:
 *   - public.users               (the global user record; role=rep, primary office=Dallas)
 *   - public.user_office_access  (the Atlanta access grant; Dallas is covered by users.office_id)
 *
 * It deliberately does NOT touch:
 *   - public.user_local_auth         <- the operator does this via /admin/users -> Send Invite,
 *                                        which generates the temp password + sends the invite email.
 *   - public.user_external_identities (no HubSpot/Procore identity for Caleb)
 *   - public.user_commission_settings (defaults apply when absent)
 *
 * Defaults to nothing: you must pass exactly one of --dry-run or --commit.
 *
 *   node --import tsx scripts/seed-user-caleb-stone.ts --dry-run   # preview, zero writes
 *   node --import tsx scripts/seed-user-caleb-stone.ts --commit    # single-transaction insert
 *
 * Safety:
 *   - Startup checks refuse to proceed unless the Dallas office matches the expected UUID,
 *     Atlanta exists & is active, the user_role enum has 'rep', and no cstone user exists yet.
 *   - --commit wraps both INSERTs in a single transaction on a single client (no Promise.all).
 *   - A rollback snapshot is written to <os-tmpdir>/seed-user-cstone-<ts>.json BEFORE COMMIT;
 *     if the snapshot write fails the transaction is rolled back (never commit unsnapshotted).
 */
import dotenv from "dotenv";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { Client } from "pg";

// Resolve the nearest .env by walking up from the script directory. This makes the script work
// whether it is run from the main checkout (scripts/../.env) or from a nested git worktree
// (whose own .env is gitignored/absent) — in the worktree case it finds the parent repo's .env.
// An ambient DATABASE_PUBLIC_URL/DATABASE_URL (e.g. via `railway run`) still takes precedence,
// because dotenv does not override values already present in process.env.
function findEnvFile(startDir: string): string | null {
  let dir = startDir;
  for (let depth = 0; depth < 8; depth += 1) {
    const candidate = path.join(dir, ".env");
    if (fs.existsSync(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

const ENV_FILE = findEnvFile(path.dirname(fileURLToPath(import.meta.url)));
if (ENV_FILE) {
  dotenv.config({ path: ENV_FILE });
}

// The Dallas office is the ACTIVE "Dallas Office" (slug=dallas). The inactive "DFW Office"
// (slug=dfw) is a known trap and must never be used. If this UUID ever stops matching the
// active slug=dallas office, the script refuses rather than silently using a different office.
const EXPECTED_DALLAS_OFFICE_ID = "802f4260-983b-4f4a-b538-9cc2c7740703";

const TARGET_USER = {
  email: "cstone@trockgc.com",
  displayName: "Caleb Stone",
  firstName: "Caleb",
  lastName: "Stone",
  role: "rep" as const,
} as const;

// Operator accounts tried (in priority order) for users.created_by_user_id. First active match
// wins; if none are found the column is left NULL and a warning is emitted.
const OPERATOR_EMAIL_CANDIDATES = [
  "adnaan@trockgc.com",
  "admin@trockgc.com",
  "adnaan.iqbal@gmail.com",
] as const;

export interface SeedCalebArgs {
  commit: boolean;
}

export interface OfficeRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
}

export interface ExistingUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  office_id: string;
  is_active: boolean;
}

export interface OperatorRow {
  id: string;
  email: string;
  is_active: boolean;
}

export interface SqlStatement {
  text: string;
  values: unknown[];
}

// --- Pure helpers (unit-tested without a database) ----------------------------------------

export function parseSeedCalebArgs(argv: string[]): SeedCalebArgs {
  let commit = false;
  let dryRun = false;
  for (const arg of argv) {
    if (arg === "--commit") {
      commit = true;
      continue;
    }
    if (arg === "--dry-run") {
      dryRun = true;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }
  if (commit && dryRun) {
    throw new Error("Use either --dry-run or --commit, not both");
  }
  if (!commit && !dryRun) {
    throw new Error("Specify --dry-run (preview) or --commit (write). No default is assumed.");
  }
  return { commit };
}

export function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/**
 * Resolves the Dallas (primary) and Atlanta (extra-access) offices from the offices table,
 * refusing on any mismatch. Pure: takes already-fetched rows.
 */
export function resolveProvisioningOffices(
  offices: OfficeRow[],
  expectedDallasOfficeId: string = EXPECTED_DALLAS_OFFICE_ID
): { dallas: OfficeRow; atlanta: OfficeRow } {
  const dallas = offices.find((office) => office.slug.trim().toLowerCase() === "dallas");
  if (!dallas) {
    throw new Error("Dallas office (slug=dallas) not found in public.offices — refusing.");
  }
  if (!dallas.is_active) {
    throw new Error(`Dallas office (slug=dallas, id=${dallas.id}) is not active — refusing.`);
  }
  if (dallas.id !== expectedDallasOfficeId) {
    throw new Error(
      `Dallas office UUID mismatch: expected ${expectedDallasOfficeId} but slug=dallas resolved to ${dallas.id}. ` +
        "Refusing to proceed (will not silently use a different office). " +
        "If the office UUID legitimately changed, update EXPECTED_DALLAS_OFFICE_ID after verifying."
    );
  }

  const atlanta = offices.find((office) => office.slug.trim().toLowerCase() === "atlanta");
  if (!atlanta) {
    throw new Error("Atlanta office (slug=atlanta) not found in public.offices — refusing.");
  }
  if (!atlanta.is_active) {
    throw new Error(`Atlanta office (slug=atlanta, id=${atlanta.id}) is not active — refusing.`);
  }

  return { dallas, atlanta };
}

export function assertUserRoleEnumHasRep(labels: string[]): void {
  if (!labels.includes("rep")) {
    throw new Error(
      `user_role enum does not include 'rep' (found: ${labels.join(", ") || "none"}) — refusing.`
    );
  }
}

export function assertNoExistingUser(rows: ExistingUserRow[]): void {
  if (rows.length > 0) {
    const existing = rows[0]!;
    throw new Error(
      `A user with email ${TARGET_USER.email} already exists — refusing to overwrite. ` +
        `id=${existing.id} display_name="${existing.display_name}" role=${existing.role} ` +
        `office_id=${existing.office_id} is_active=${existing.is_active}`
    );
  }
}

export function resolveCreatedByUserId(rows: OperatorRow[]): string | null {
  for (const candidate of OPERATOR_EMAIL_CANDIDATES) {
    const match = rows.find((row) => row.is_active && row.email.trim().toLowerCase() === candidate);
    if (match) return match.id;
  }
  return null;
}

/**
 * Builds the public.users INSERT. role is hard-pinned to 'rep'; email is lowercased.
 * Note: this statement contains NO reference to user_local_auth.
 */
export function buildUsersInsert(input: {
  userId: string;
  email: string;
  displayName: string;
  firstName: string;
  lastName: string;
  dallasOfficeId: string;
  createdByUserId: string | null;
}): SqlStatement {
  return {
    text: `
      INSERT INTO public.users (
        id,
        email,
        display_name,
        first_name,
        last_name,
        role,
        office_id,
        is_active,
        notification_prefs,
        created_by_user_id,
        updated_at
      )
      VALUES (
        $1::uuid,
        $2,
        $3,
        $4,
        $5,
        'rep'::user_role,
        $6::uuid,
        true,
        '{}'::jsonb,
        $7::uuid,
        now()
      )
      RETURNING
        id::text AS id,
        email,
        display_name,
        first_name,
        last_name,
        role::text AS role,
        office_id::text AS office_id,
        is_active,
        notification_prefs,
        created_by_user_id::text AS created_by_user_id,
        created_at,
        updated_at
    `,
    values: [
      input.userId,
      normalizeEmail(input.email),
      input.displayName,
      input.firstName,
      input.lastName,
      input.dallasOfficeId,
      input.createdByUserId,
    ],
  };
}

/** Builds the single Atlanta access grant. Dallas access is covered by users.office_id. */
export function buildOfficeAccessInsert(input: {
  userId: string;
  atlantaOfficeId: string;
}): SqlStatement {
  return {
    text: `
      INSERT INTO public.user_office_access (user_id, office_id, role_override)
      VALUES ($1::uuid, $2::uuid, NULL)
      RETURNING
        id::text AS id,
        user_id::text AS user_id,
        office_id::text AS office_id,
        role_override
    `,
    values: [input.userId, input.atlantaOfficeId],
  };
}

// --- SQL read statements ------------------------------------------------------------------

const OFFICES_SQL = "SELECT id::text AS id, name, slug, is_active FROM public.offices ORDER BY slug";

const USER_ROLE_ENUM_SQL = `
  SELECT e.enumlabel AS label
  FROM pg_enum e
  JOIN pg_type t ON t.oid = e.enumtypid
  WHERE t.typname = 'user_role'
  ORDER BY e.enumsortorder
`;

const EXISTING_USER_SQL = `
  SELECT
    id::text AS id,
    email,
    display_name,
    role::text AS role,
    office_id::text AS office_id,
    is_active
  FROM public.users
  WHERE lower(email) = lower($1)
  LIMIT 1
`;

const OPERATOR_LOOKUP_SQL = `
  SELECT id::text AS id, email, is_active
  FROM public.users
  WHERE lower(email) = ANY($1::text[]) AND is_active = true
`;

const VERIFY_SQL = `
  SELECT
    u.id::text AS id,
    u.email,
    u.display_name,
    u.first_name,
    u.last_name,
    u.role::text AS role,
    u.office_id::text AS office_id,
    u.is_active,
    u.created_by_user_id::text AS created_by_user_id,
    u.created_at,
    u.updated_at,
    (SELECT count(*)::int FROM public.user_office_access uoa WHERE uoa.user_id = u.id) AS office_access_count,
    EXISTS (
      SELECT 1 FROM public.user_office_access uoa
      WHERE uoa.user_id = u.id AND uoa.office_id = $2::uuid
    ) AS has_atlanta_access
  FROM public.users u
  WHERE u.id = $1::uuid
`;

// --- Minimal client/logger contracts (lets tests inject a fake client) --------------------

export interface QueryableClient {
  query: (text: string, values?: unknown[]) => Promise<{ rows: any[]; rowCount?: number | null }>;
}

export interface SeedCalebDeps {
  client: QueryableClient;
  argv: string[];
  now?: () => Date;
  logger?: Pick<Console, "log" | "warn" | "error">;
  tmpDir?: string;
  writeSnapshot?: (filePath: string, contents: string) => void;
}

export interface SeedCalebResult {
  mode: "DRY-RUN" | "COMMIT";
  dallasOfficeId: string;
  atlantaOfficeId: string;
  createdByUserId: string | null;
  plannedUserId: string;
  committed: boolean;
  snapshotPath: string | null;
  insertedUser: Record<string, unknown> | null;
  insertedOfficeAccess: Record<string, unknown> | null;
}

function defaultWriteSnapshot(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents);
}

/**
 * Orchestrates the provisioning. Pure of process concerns (no dotenv, no real connection):
 * a connected client is injected so it can be exercised against a mock in tests.
 */
export async function runSeedCalebStone(deps: SeedCalebDeps): Promise<SeedCalebResult> {
  const logger = deps.logger ?? console;
  const now = deps.now ?? (() => new Date());
  const tmpDir = deps.tmpDir ?? os.tmpdir();
  const writeSnapshot = deps.writeSnapshot ?? defaultWriteSnapshot;
  const client = deps.client;

  const { commit } = parseSeedCalebArgs(deps.argv);
  const mode: "DRY-RUN" | "COMMIT" = commit ? "COMMIT" : "DRY-RUN";
  logger.log(`[${mode}] seed-user-caleb-stone — target ${TARGET_USER.email} (role=${TARGET_USER.role})`);

  // ---- Startup checks (refuse on any failure) --------------------------------------------
  const offices = (await client.query(OFFICES_SQL)).rows as OfficeRow[];
  const { dallas, atlanta } = resolveProvisioningOffices(offices, EXPECTED_DALLAS_OFFICE_ID);
  logger.log(`Resolved Dallas (primary): ${dallas.name} [${dallas.id}] slug=${dallas.slug}`);
  logger.log(`Resolved Atlanta (extra access): ${atlanta.name} [${atlanta.id}] slug=${atlanta.slug}`);

  const enumLabels = (await client.query(USER_ROLE_ENUM_SQL)).rows.map((r: { label: string }) => r.label);
  assertUserRoleEnumHasRep(enumLabels);

  const existing = (await client.query(EXISTING_USER_SQL, [TARGET_USER.email])).rows as ExistingUserRow[];
  if (existing.length > 0) {
    const e = existing[0]!;
    logger.error(
      `Existing user found: id=${e.id} display_name="${e.display_name}" role=${e.role} ` +
        `office_id=${e.office_id} is_active=${e.is_active}`
    );
  }
  assertNoExistingUser(existing);

  const operatorCandidates = OPERATOR_EMAIL_CANDIDATES.map((email) => email.toLowerCase());
  const operatorRows = (await client.query(OPERATOR_LOOKUP_SQL, [operatorCandidates])).rows as OperatorRow[];
  const createdByUserId = resolveCreatedByUserId(operatorRows);
  if (createdByUserId) {
    logger.log(`created_by_user_id resolved to operator ${createdByUserId}`);
  } else {
    logger.warn(
      `No active operator user found among ${OPERATOR_EMAIL_CANDIDATES.join(", ")} — ` +
        "created_by_user_id will be left NULL."
    );
  }

  // ---- Build the plan (no writes yet) ----------------------------------------------------
  const plannedUserId = crypto.randomUUID();
  const usersInsert = buildUsersInsert({
    userId: plannedUserId,
    email: TARGET_USER.email,
    displayName: TARGET_USER.displayName,
    firstName: TARGET_USER.firstName,
    lastName: TARGET_USER.lastName,
    dallasOfficeId: dallas.id,
    createdByUserId,
  });
  const officeAccessInsert = buildOfficeAccessInsert({
    userId: plannedUserId,
    atlantaOfficeId: atlanta.id,
  });

  logger.log("Planned operations:");
  logger.log(`  1) INSERT public.users  id=${plannedUserId}`);
  logger.log(
    `       email=${usersInsert.values[1]} display_name="${TARGET_USER.displayName}" ` +
      `role=rep office_id=${dallas.id} is_active=true created_by_user_id=${createdByUserId ?? "NULL"}`
  );
  logger.log(`  2) INSERT public.user_office_access  user_id=${plannedUserId} office_id=${atlanta.id} (Atlanta) role_override=NULL`);

  const result: SeedCalebResult = {
    mode,
    dallasOfficeId: dallas.id,
    atlantaOfficeId: atlanta.id,
    createdByUserId,
    plannedUserId,
    committed: false,
    snapshotPath: null,
    insertedUser: null,
    insertedOfficeAccess: null,
  };

  if (!commit) {
    logger.log("\nDRY-RUN complete. No writes performed. Re-run with --commit to apply.");
    return result;
  }

  // ---- Commit path -----------------------------------------------------------------------
  await client.query("BEGIN");
  try {
    const insertedUser = (await client.query(usersInsert.text, usersInsert.values)).rows[0] ?? null;
    const insertedOfficeAccess = (await client.query(officeAccessInsert.text, officeAccessInsert.values)).rows[0] ?? null;
    if (!insertedUser || !insertedOfficeAccess) {
      throw new Error("INSERT did not return a row — rolling back to avoid a half-provisioned state.");
    }

    const verifyRow = (await client.query(VERIFY_SQL, [plannedUserId, atlanta.id])).rows[0] ?? null;
    logger.log("Inserted (verified inside transaction):");
    logger.log(JSON.stringify(verifyRow, null, 2));
    // Expect exactly one office-access row (the Atlanta grant); Dallas is the primary
    // office_id and is intentionally NOT an access row. Anything else is unexpected state.
    if (!verifyRow || verifyRow.has_atlanta_access !== true || Number(verifyRow.office_access_count) !== 1) {
      throw new Error(
        "Post-insert verification failed (expected exactly one office-access row, the Atlanta grant) — rolling back."
      );
    }

    // Persist the rollback snapshot BEFORE COMMIT. If this write fails we ROLLBACK and never
    // end up with a committed-but-unsnapshotted change.
    const ranAt = now();
    const ts = ranAt.toISOString().replace(/[:.]/g, "-");
    const snapshotPath = path.join(tmpDir, `seed-user-cstone-${ts}.json`);
    writeSnapshot(
      snapshotPath,
      JSON.stringify(
        {
          ranAt: ranAt.toISOString(),
          target: TARGET_USER.email,
          dallasOfficeId: dallas.id,
          atlantaOfficeId: atlanta.id,
          insertedUser,
          insertedOfficeAccess,
        },
        null,
        2
      )
    );

    await client.query("COMMIT");

    result.committed = true;
    result.snapshotPath = snapshotPath;
    result.insertedUser = insertedUser;
    result.insertedOfficeAccess = insertedOfficeAccess;

    logger.log(`\nCOMMIT complete. Provisioned ${TARGET_USER.email} (id=${plannedUserId}).`);
    logger.log(`Rollback snapshot: ${snapshotPath}`);
    logger.log(
      "\nNEXT STEP (operator): open the CRM, go to /admin/users, find " +
        `${TARGET_USER.email} in the list, and click "Send Invite". That provisions the ` +
        "user_local_auth row (temp password) and emails the invite. If Resend is misconfigured, " +
        'use "Preview Invite" to read the temp password and hand it over manually.'
    );
    return result;
  } catch (error) {
    // Roll back; if ROLLBACK itself fails (e.g. dropped connection — Postgres aborts the
    // transaction server-side anyway), log it but surface the ORIGINAL error, not the rollback's.
    try {
      await client.query("ROLLBACK");
    } catch (rollbackError) {
      logger.error(
        `ROLLBACK failed after error (transaction is aborted server-side regardless): ${
          rollbackError instanceof Error ? rollbackError.message : String(rollbackError)
        }`
      );
    }
    throw error;
  }
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Set DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

export async function main(argv: string[] = process.argv.slice(2)): Promise<void> {
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    await runSeedCalebStone({ client, argv });
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
