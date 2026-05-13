import crypto from "node:crypto";
import path from "node:path";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";
import { Client } from "pg";

const scryptAsync = promisify(crypto.scrypt);

const TEMP_PASSWORD_LENGTH = 18;
const INVITE_TTL_HOURS = 72;

const NEW_USERS = [
  { firstName: "Adam", lastName: "Sherwood", email: "asherwood@trockgc.com" },
  { firstName: "Alex", lastName: "Koch", email: "akoch@trockgc.com" },
  { firstName: "Brock", lastName: "Burns", email: "bburns@trockgc.com" },
  { firstName: "Kristy", lastName: "Scheidegger", email: "kscheidegger@trockgc.com" },
  { firstName: "Sidney", lastName: "Gibson", email: "sgibson@trockgc.com" },
  { firstName: "Stephanie", lastName: "Bohen", email: "sbohen@trockgc.com" },
] as const;

const EXISTING_REAL_USER_EMAILS = [
  "admin@trockgc.com",
  "adnaan.iqbal@gmail.com",
  "agreen@trockgc.com",
  "ashaw@trockgc.com",
  "bbell@trockgc.com",
  "cburling@trockgc.com",
  "chigingbotham@trockgc.com",
  "dbarr@trockgc.com",
  "emccarty@trockgc.com",
  "jhelms@trockgc.com",
  "kmarshall@trockgc.com",
  "kscott@trockgc.com",
  "tmitchell@trockgc.com",
  "tyamashita@trockgc.com",
] as const;

type SeedAction = "create_user" | "skip_existing_active" | "blocked_existing_inactive";

interface OfficeRow {
  id: string;
  name: string;
  slug: string;
  is_active: boolean;
}

interface ExistingUserRow {
  id: string;
  email: string;
  display_name: string;
  role: string;
  office_id: string;
  is_active: boolean;
  local_auth_present: boolean;
  local_auth_enabled: boolean | null;
  local_auth_revoked_at: Date | string | null;
}

interface ExistingRealUserAccessRow {
  user_id: string | null;
  email: string;
  role: string | null;
  primary_office_slug: string | null;
  is_active: boolean | null;
  local_auth_present: boolean;
  atl_access_id: string | null;
}

interface NewUserPlanItem {
  firstName: string;
  lastName: string;
  email: string;
  displayName: string;
  action: SeedAction;
  existingUserId: string | null;
}

interface SeededCredential {
  name: string;
  email: string;
  temporaryPassword: string;
  officeAccess: string;
  action: "create_user";
  userId: string;
}

function parseArgs(argv = process.argv.slice(2)) {
  let execute = false;
  let sawExecute = false;
  let sawDryRun = false;

  for (const arg of argv) {
    if (arg === "--execute") {
      execute = true;
      sawExecute = true;
      continue;
    }
    if (arg === "--dry-run") {
      execute = false;
      sawDryRun = true;
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

function displayNameFor(input: { firstName: string; lastName: string }) {
  return `${input.firstName} ${input.lastName}`.trim();
}

function computeInviteExpiry(baseDate: Date) {
  return new Date(baseDate.getTime() + INVITE_TTL_HOURS * 60 * 60 * 1000);
}

function generateTemporaryPassword() {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*";
  const bytes = crypto.randomBytes(TEMP_PASSWORD_LENGTH);
  let password = "";
  for (let index = 0; index < TEMP_PASSWORD_LENGTH; index += 1) {
    password += alphabet[bytes[index]! % alphabet.length];
  }
  return password;
}

async function hashPassword(password: string) {
  if (password.length < 12) {
    throw new Error("Temporary password must be at least 12 characters");
  }
  const salt = crypto.randomBytes(16);
  const derivedKey = (await scryptAsync(password, salt, 64)) as Buffer;
  return `scrypt$${salt.toString("hex")}$${derivedKey.toString("hex")}`;
}

function findOffice(offices: OfficeRow[], kind: "dfw" | "atl") {
  const match = offices.find((office) => {
    const slug = office.slug.trim().toLowerCase();
    const name = office.name.trim().toLowerCase();
    if (kind === "dfw") {
      return office.is_active && (slug === "dallas" || name.includes("dallas"));
    }
    return office.is_active && (slug === "atlanta" || slug === "atl" || name.includes("atlanta"));
  });
  if (!match) throw new Error(`Could not resolve active ${kind.toUpperCase()} office`);
  return match;
}

async function fetchOffices(client: Client) {
  const result = await client.query<OfficeRow>(`
    SELECT id, name, slug, is_active
    FROM public.offices
    ORDER BY name
  `);
  return result.rows;
}

async function fetchTargetUsers(client: Client) {
  const emails = NEW_USERS.map((user) => normalizeEmail(user.email));
  const result = await client.query<ExistingUserRow>(`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.role::text AS role,
      u.office_id,
      u.is_active,
      ula.user_id IS NOT NULL AS local_auth_present,
      ula.is_enabled AS local_auth_enabled,
      ula.revoked_at AS local_auth_revoked_at
    FROM public.users u
    LEFT JOIN public.user_local_auth ula ON ula.user_id = u.id
    WHERE lower(u.email) = ANY($1::text[])
    ORDER BY lower(u.email)
  `, [emails]);
  return result.rows;
}

async function fetchExistingRealUserAccess(client: Client, atlOfficeId: string) {
  const result = await client.query<ExistingRealUserAccessRow>(`
    WITH target(email) AS (
      SELECT unnest($1::text[])
    )
    SELECT
      u.id AS user_id,
      target.email,
      u.role::text AS role,
      primary_office.slug AS primary_office_slug,
      u.is_active,
      ula.user_id IS NOT NULL AS local_auth_present,
      atl_access.id AS atl_access_id
    FROM target
    LEFT JOIN public.users u ON lower(u.email) = target.email
    LEFT JOIN public.offices primary_office ON primary_office.id = u.office_id
    LEFT JOIN public.user_local_auth ula ON ula.user_id = u.id
    LEFT JOIN public.user_office_access atl_access
      ON atl_access.user_id = u.id
     AND atl_access.office_id = $2::uuid
    ORDER BY target.email
  `, [EXISTING_REAL_USER_EMAILS, atlOfficeId]);
  return result.rows;
}

function buildNewUserPlan(existingUsers: ExistingUserRow[]): NewUserPlanItem[] {
  const existingByEmail = new Map(existingUsers.map((user) => [normalizeEmail(user.email), user]));

  return NEW_USERS.map((user) => {
    const normalizedEmail = normalizeEmail(user.email);
    const existing = existingByEmail.get(normalizedEmail);
    const action: SeedAction = existing
      ? existing.is_active && existing.local_auth_enabled !== false && !existing.local_auth_revoked_at
        ? "skip_existing_active"
        : "blocked_existing_inactive"
      : "create_user";

    return {
      firstName: user.firstName,
      lastName: user.lastName,
      email: normalizedEmail,
      displayName: displayNameFor(user),
      action,
      existingUserId: existing?.id ?? null,
    };
  });
}

function missingAtlAccessRows(rows: ExistingRealUserAccessRow[]) {
  return rows.filter((row) =>
    row.user_id &&
    row.is_active === true &&
    row.role !== "field_contractor" &&
    !row.atl_access_id
  );
}

async function createUser(
  client: Client,
  item: NewUserPlanItem,
  dfwOfficeId: string,
  atlOfficeId: string,
  now: Date,
) {
  if (item.action !== "create_user") {
    throw new Error(`Refusing to seed ${item.email}: planned action is ${item.action}`);
  }
  const userId = crypto.randomUUID();
  const temporaryPassword = generateTemporaryPassword();
  const passwordHash = await hashPassword(temporaryPassword);
  const inviteExpiresAt = computeInviteExpiry(now);

  await client.query(`
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
      $7::timestamptz
    )
  `, [
    userId,
    item.email,
    item.displayName,
    item.firstName,
    item.lastName,
    dfwOfficeId,
    now,
  ]);

  await client.query(`
    INSERT INTO public.user_local_auth (
      user_id,
      password_hash,
      must_change_password,
      is_enabled,
      invite_sent_at,
      invite_expires_at,
      last_login_at,
      failed_login_attempts,
      last_failed_login_at,
      locked_until,
      password_changed_at,
      revoked_at,
      revoked_by_user_id,
      updated_at
    )
    VALUES (
      $1::uuid,
      $2,
      true,
      true,
      $3::timestamptz,
      $4::timestamptz,
      NULL,
      0,
      NULL,
      NULL,
      NULL,
      NULL,
      NULL,
      $3::timestamptz
    )
    ON CONFLICT (user_id) DO UPDATE
      SET password_hash = EXCLUDED.password_hash,
          must_change_password = true,
          is_enabled = true,
          invite_sent_at = EXCLUDED.invite_sent_at,
          invite_expires_at = EXCLUDED.invite_expires_at,
          last_login_at = NULL,
          failed_login_attempts = 0,
          last_failed_login_at = NULL,
          locked_until = NULL,
          password_changed_at = NULL,
          revoked_at = NULL,
          revoked_by_user_id = NULL,
          updated_at = EXCLUDED.updated_at
  `, [userId, passwordHash, now, inviteExpiresAt]);

  await client.query(`
    INSERT INTO public.user_office_access (user_id, office_id, role_override)
    VALUES
      ($1::uuid, $2::uuid, NULL),
      ($1::uuid, $3::uuid, NULL)
    ON CONFLICT (user_id, office_id) DO NOTHING
  `, [userId, dfwOfficeId, atlOfficeId]);

  await client.query(`
    INSERT INTO public.user_local_auth_events (user_id, event_type, metadata)
    VALUES (
      $1::uuid,
      'password_change_forced'::local_auth_event_type,
      jsonb_build_object(
        'source', 'seed-new-real-users',
        'reason', 'new_user_tomorrow_onboarding',
        'inviteExpiresAt', $2::text,
        'seedAction', $3::text
      )
    )
  `, [userId, inviteExpiresAt.toISOString(), item.action]);

  return {
    name: item.displayName,
    email: item.email,
    temporaryPassword,
    officeAccess: "DFW (primary), ATL",
    action: item.action,
    userId,
  } satisfies SeededCredential;
}

async function grantMissingAtlAccess(client: Client, rows: ExistingRealUserAccessRow[], atlOfficeId: string) {
  const missing = missingAtlAccessRows(rows);
  for (const row of missing) {
    await client.query(`
      INSERT INTO public.user_office_access (user_id, office_id, role_override)
      VALUES ($1::uuid, $2::uuid, NULL)
      ON CONFLICT (user_id, office_id) DO NOTHING
    `, [row.user_id, atlOfficeId]);
  }
  return missing.map((row) => row.email);
}

async function fetchVerification(client: Client, emails: string[], dfwOfficeId: string, atlOfficeId: string) {
  const result = await client.query(`
    SELECT
      u.id,
      u.email,
      u.display_name,
      u.first_name,
      u.last_name,
      u.role::text AS role,
      u.office_id,
      o.slug AS primary_office_slug,
      u.is_active,
      ula.user_id IS NOT NULL AS local_auth_present,
      ula.must_change_password,
      ula.is_enabled,
      ula.invite_expires_at,
      ula.revoked_at,
      EXISTS (
        SELECT 1 FROM public.user_office_access uoa
        WHERE uoa.user_id = u.id AND uoa.office_id = $2::uuid
      ) AS dfw_access_row,
      EXISTS (
        SELECT 1 FROM public.user_office_access uoa
        WHERE uoa.user_id = u.id AND uoa.office_id = $3::uuid
      ) AS atl_access_row,
      EXISTS (
        SELECT 1 FROM public.user_local_auth_events e
        WHERE e.user_id = u.id
          AND e.event_type = 'password_change_forced'::local_auth_event_type
          AND e.metadata->>'source' = 'seed-new-real-users'
      ) AS password_change_forced_event
    FROM public.users u
    JOIN public.offices o ON o.id = u.office_id
    LEFT JOIN public.user_local_auth ula ON ula.user_id = u.id
    WHERE lower(u.email) = ANY($1::text[])
    ORDER BY lower(u.email)
  `, [emails.map(normalizeEmail), dfwOfficeId, atlOfficeId]);
  return result.rows;
}

function markdownCredentialsTable(credentials: SeededCredential[]) {
  const lines = [
    "| Name | Email | Temporary Password | Office Access |",
    "|---|---|---|---|",
    ...credentials.map((credential) =>
      `| ${credential.name} | ${credential.email} | ${credential.temporaryPassword} | ${credential.officeAccess} |`
    ),
  ];
  return lines.join("\n");
}

export async function runSeedNewRealUsers(argv = process.argv.slice(2)) {
  const { execute } = parseArgs(argv);
  const client = new Client({
    connectionString: connectionString(),
    ssl: { rejectUnauthorized: false },
  });
  await client.connect();

  try {
    const offices = await fetchOffices(client);
    const dfwOffice = findOffice(offices, "dfw");
    const atlOffice = findOffice(offices, "atl");
    const existingTargets = await fetchTargetUsers(client);
    const existingRealUsersBefore = await fetchExistingRealUserAccess(client, atlOffice.id);
    const newUserPlan = buildNewUserPlan(existingTargets);
    const blockedTargets = newUserPlan.filter((item) => item.action === "blocked_existing_inactive");
    if (execute && blockedTargets.length > 0) {
      throw new Error(
        `Refusing to modify existing inactive/revoked target users in this one-shot script: ${blockedTargets
          .map((item) => item.email)
          .join(", ")}`
      );
    }
    const usersToSeed = newUserPlan.filter((item) => item.action === "create_user");

    let credentials: SeededCredential[] = [];
    let atlAccessGrantedToExistingUsers: string[] = [];
    if (execute && (usersToSeed.length > 0 || missingAtlAccessRows(existingRealUsersBefore).length > 0)) {
      await client.query("BEGIN");
      try {
        const now = new Date();
        for (const item of usersToSeed) {
          credentials.push(await createUser(client, item, dfwOffice.id, atlOffice.id, now));
        }
        atlAccessGrantedToExistingUsers = await grantMissingAtlAccess(client, existingRealUsersBefore, atlOffice.id);
        await client.query("COMMIT");
      } catch (error) {
        await client.query("ROLLBACK");
        throw error;
      }
    }

    const verification = await fetchVerification(
      client,
      NEW_USERS.map((user) => user.email),
      dfwOffice.id,
      atlOffice.id,
    );
    const existingRealUsersAfter = await fetchExistingRealUserAccess(client, atlOffice.id);

    const summary = {
      dryRun: !execute,
      offices: {
        dfw: dfwOffice,
        atl: atlOffice,
      },
      plan: {
        newUsers: newUserPlan,
        usersToSeedCount: usersToSeed.length,
        blockedExistingInactive: blockedTargets.map((item) => item.email),
        existingRealUsersMissingAtlBefore: missingAtlAccessRows(existingRealUsersBefore).map((row) => row.email),
      },
      executed: {
        seededCount: credentials.length,
        seededUsers: credentials.map(({ temporaryPassword: _temporaryPassword, ...credential }) => credential),
        atlAccessGrantedToExistingUsers,
      },
      verification,
      existingRealUsersAfter: {
        total: existingRealUsersAfter.length,
        missingAtl: missingAtlAccessRows(existingRealUsersAfter).map((row) => row.email),
        missingLocalAuth: existingRealUsersAfter
          .filter((row) => !row.local_auth_present)
          .map((row) => row.email),
      },
    };

    console.log(JSON.stringify(summary, null, 2));
    if (execute && credentials.length > 0) {
      console.log("\nTemporary credentials:");
      console.log(markdownCredentialsTable(credentials));
      console.log("\nAll seeded with rep role. Adjust role via /admin/users as needed. Each user will be forced to change password on first login.");
    }
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  runSeedNewRealUsers().catch((error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exit(1);
  });
}
