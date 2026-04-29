import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const ACTIVE_TASK_STATUSES = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"];
const ORG_CHART_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/org-chart.json");
const MIGRATION_0070 = "0070_add_construction_user_role.sql";
const MIGRATIONS_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "../migrations");

type CrmRole = "admin" | "director" | "rep" | "construction";

export interface OrgChartUser {
  name: string;
  email: string;
  role: string;
  officeCode: string;
  manager: string | null;
  crmRole?: CrmRole;
  status?: "active" | "inactive";
  flags?: string[];
  notes?: string;
  mergeSources?: string[];
}

export interface DbUser {
  id: string;
  email: string;
  displayName: string;
  role: CrmRole;
  officeSlug: string | null;
  reportsTo: string | null;
  isActive: boolean;
}

export interface OwnershipCounts {
  deals: number;
  leads: number;
  tasks: number;
}

export interface UserCleanupPlan {
  wouldSoftDelete: Array<DbUser & { managerEmail: string | null }>;
  wouldCreate: Array<OrgChartUser & { crmRole: CrmRole; officeSlug: string }>;
  managerMismatches: Array<{
    email: string;
    currentManagerEmail: string | null;
    nextManagerEmail: string | null;
    status: "would_update" | "blocked_user_missing" | "blocked_manager_missing";
  }>;
  roleMismatches: Array<{
    email: string;
    currentRole: CrmRole;
    nextRole: CrmRole;
    status: "would_update";
  }>;
  reassignmentPlan: Array<{
    email: string;
    displayName: string;
    reassignToEmail: string | null;
    deals: number;
    leads: number;
    tasks: number;
  }>;
  mergePlan: Array<{
    sourceEmail: string;
    sourceDisplayName: string;
    targetEmail: string;
    targetExists: boolean;
    targetWillBeCreated: boolean;
    deals: number;
    leads: number;
    tasks: number;
    afterMergeAction: "soft_delete_source";
  }>;
  inactiveReviewUsers: Array<{
    email: string;
    displayName: string;
    existsInDb: boolean;
    isActive: boolean | null;
    managerEmail: string | null;
    notes: string | null;
    flags: string[];
  }>;
}

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function stripEmailNumericSuffix(localPart: string): string {
  return localPart.replace(/\d+$/, "");
}

function expectedEmailLocalPart(name: string): string {
  const cleaned = name.toLowerCase().replace(/[^a-z\s-]/g, " ").trim();
  const parts = cleaned.split(/[\s-]+/).filter(Boolean);
  if (parts.length < 2 || !parts[0]) return cleaned.replace(/\s+/g, "");
  return `${parts[0][0]}${parts[parts.length - 1]}`;
}

export function detectEmailConventionCollisions(orgUsers: OrgChartUser[]) {
  const byConvention = new Map<string, string[]>();
  for (const user of orgUsers) {
    const emailLocal = normalizeEmail(user.email).split("@")[0] ?? "";
    const conventionKey = stripEmailNumericSuffix(emailLocal) || expectedEmailLocalPart(user.name);
    const users = byConvention.get(conventionKey) ?? [];
    users.push(`${user.name} <${normalizeEmail(user.email)}>`);
    byConvention.set(conventionKey, users);
  }

  return [...byConvention.entries()]
    .filter(([_, users]) => users.length > 1)
    .map(([conventionKey, users]) => ({ conventionKey, users: users.sort() }))
    .sort((a, b) => a.conventionKey.localeCompare(b.conventionKey));
}

export function inferCrmRole(orgRole: string): CrmRole {
  const role = orgRole.toLowerCase();
  if (role === "ceo" || role === "cfo" || role.includes("founder") || role.includes("super admin")) return "admin";
  if (role.includes("project manager") || role.includes("superintendent") || role.includes("service super")) return "construction";
  if (role.includes("vp") || role.includes("director")) return "director";
  return "rep";
}

function resolveCrmRole(user: Pick<OrgChartUser, "role" | "crmRole">): CrmRole {
  return user.crmRole ?? inferCrmRole(user.role);
}

export function resolveOfficeSlug(officeCode: string): string {
  const normalized = officeCode.trim().toLowerCase();
  if (normalized === "dfw") return "dallas";
  if (normalized === "atl") return "atlanta";
  return normalized;
}

function managerEmailForDbUser(user: DbUser, dbById: Map<string, DbUser>): string | null {
  if (!user.reportsTo) return null;
  return dbById.get(user.reportsTo)?.email ?? null;
}

function chooseReassignmentTarget(
  softDeletedUser: DbUser,
  orgByEmail: Map<string, OrgChartUser>,
  dbByEmail: Map<string, DbUser>,
  dbById: Map<string, DbUser>
): DbUser | null {
  const currentManager = softDeletedUser.reportsTo ? dbById.get(softDeletedUser.reportsTo) : null;
  if (currentManager?.isActive && orgByEmail.has(normalizeEmail(currentManager.email))) return currentManager;

  const ceo = dbByEmail.get("ashaw@trockgc.com");
  if (ceo?.isActive) return ceo;

  const firstActiveOrgUser = [...orgByEmail.keys()]
    .map((email) => dbByEmail.get(email))
    .find((user): user is DbUser => Boolean(user?.isActive));
  return firstActiveOrgUser ?? null;
}

export function buildUserCleanupPlan(args: {
  orgUsers: OrgChartUser[];
  dbUsers: DbUser[];
  ownershipCountsByUserId?: Map<string, OwnershipCounts>;
}): UserCleanupPlan {
  const orgByEmail = new Map(args.orgUsers.map((user) => [normalizeEmail(user.email), {
    ...user,
    email: normalizeEmail(user.email),
    manager: user.manager ? normalizeEmail(user.manager) : null,
    status: user.status ?? "active",
    flags: user.flags ?? [],
    notes: user.notes ?? null,
    crmRole: resolveCrmRole(user),
    mergeSources: (user.mergeSources ?? []).map(normalizeEmail),
  }]));
  const dbByEmail = new Map(args.dbUsers.map((user) => [normalizeEmail(user.email), { ...user, email: normalizeEmail(user.email) }]));
  const dbById = new Map(args.dbUsers.map((user) => [user.id, { ...user, email: normalizeEmail(user.email) }]));
  const ownershipCountsByUserId = args.ownershipCountsByUserId ?? new Map<string, OwnershipCounts>();

  const mergeSourceEmails = new Set<string>();
  for (const orgUser of orgByEmail.values()) {
    for (const sourceEmail of orgUser.mergeSources ?? []) mergeSourceEmails.add(sourceEmail);
  }

  const inactiveOrgEmails = new Set(
    [...orgByEmail.values()]
      .filter((user) => user.status === "inactive")
      .map((user) => user.email)
  );

  const wouldSoftDelete = args.dbUsers
    .filter((user) => {
      const email = normalizeEmail(user.email);
      return user.isActive && !orgByEmail.has(email) && !mergeSourceEmails.has(email) && !inactiveOrgEmails.has(email);
    })
    .map((user) => ({ ...user, email: normalizeEmail(user.email), managerEmail: managerEmailForDbUser(user, dbById) }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const wouldCreate = args.orgUsers
    .filter((user) => !dbByEmail.has(normalizeEmail(user.email)))
    .map((user) => ({
      ...user,
      email: normalizeEmail(user.email),
      manager: user.manager ? normalizeEmail(user.manager) : null,
      status: user.status ?? "active",
      flags: user.flags ?? [],
      notes: user.notes ?? null,
      mergeSources: (user.mergeSources ?? []).map(normalizeEmail),
      crmRole: resolveCrmRole(user),
      officeSlug: resolveOfficeSlug(user.officeCode),
    }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const managerMismatches: UserCleanupPlan["managerMismatches"] = [];
  for (const orgUser of args.orgUsers) {
    const orgEmail = normalizeEmail(orgUser.email);
    const dbUser = dbByEmail.get(orgEmail);
    const nextManagerEmail = orgUser.manager ? normalizeEmail(orgUser.manager) : null;
    const managerDbUser = nextManagerEmail ? dbByEmail.get(nextManagerEmail) : null;
    const currentManagerEmail = dbUser ? managerEmailForDbUser(dbUser, dbById) : null;

    if (!dbUser) {
      managerMismatches.push({
        email: orgEmail,
        currentManagerEmail: null,
        nextManagerEmail,
        status: "blocked_user_missing",
      });
      continue;
    }

    if (nextManagerEmail && !managerDbUser) {
      managerMismatches.push({
        email: orgEmail,
        currentManagerEmail,
        nextManagerEmail,
        status: "blocked_manager_missing",
      });
      continue;
    }

    const nextManagerId = managerDbUser?.id ?? null;
    if ((dbUser.reportsTo ?? null) !== nextManagerId) {
      managerMismatches.push({
        email: orgEmail,
        currentManagerEmail,
        nextManagerEmail,
        status: "would_update",
      });
    }
  }
  managerMismatches.sort((a, b) => a.email.localeCompare(b.email));

  const roleMismatches: UserCleanupPlan["roleMismatches"] = [];
  for (const orgUser of orgByEmail.values()) {
    const dbUser = dbByEmail.get(orgUser.email);
    if (!dbUser) continue;
    const nextRole = orgUser.crmRole ?? inferCrmRole(orgUser.role);
    if (dbUser.role !== nextRole) {
      roleMismatches.push({
        email: orgUser.email,
        currentRole: dbUser.role,
        nextRole,
        status: "would_update",
      });
    }
  }
  roleMismatches.sort((a, b) => a.email.localeCompare(b.email));

  const reassignmentPlan = wouldSoftDelete.map((user) => {
    const counts = ownershipCountsByUserId.get(user.id) ?? { deals: 0, leads: 0, tasks: 0 };
    const target = chooseReassignmentTarget(user, orgByEmail, dbByEmail, dbById);
    return {
      email: user.email,
      displayName: user.displayName,
      reassignToEmail: target?.email ?? null,
      deals: counts.deals,
      leads: counts.leads,
      tasks: counts.tasks,
    };
  });

  const mergePlan = [...orgByEmail.values()]
    .flatMap((targetUser) => (targetUser.mergeSources ?? []).map((sourceEmail) => {
      const source = dbByEmail.get(sourceEmail);
      const target = dbByEmail.get(targetUser.email);
      const counts = source ? ownershipCountsByUserId.get(source.id) ?? { deals: 0, leads: 0, tasks: 0 } : { deals: 0, leads: 0, tasks: 0 };
      return {
        sourceEmail,
        sourceDisplayName: source?.displayName ?? "MISSING_SOURCE_USER",
        targetEmail: targetUser.email,
        targetExists: Boolean(target),
        targetWillBeCreated: !target,
        deals: counts.deals,
        leads: counts.leads,
        tasks: counts.tasks,
        afterMergeAction: "soft_delete_source" as const,
      };
    }))
    .sort((a, b) => a.sourceEmail.localeCompare(b.sourceEmail));

  const inactiveReviewUsers = [...orgByEmail.values()]
    .filter((user) => user.status === "inactive")
    .map((user) => {
      const dbUser = dbByEmail.get(user.email);
      return {
        email: user.email,
        displayName: dbUser?.displayName ?? user.name,
        existsInDb: Boolean(dbUser),
        isActive: dbUser?.isActive ?? null,
        managerEmail: user.manager ?? null,
        notes: user.notes ?? null,
        flags: user.flags ?? [],
      };
    })
    .sort((a, b) => a.email.localeCompare(b.email));

  return { wouldSoftDelete, wouldCreate, managerMismatches, roleMismatches, reassignmentPlan, mergePlan, inactiveReviewUsers };
}

function loadOrgChart(): OrgChartUser[] {
  const parsed = JSON.parse(fs.readFileSync(ORG_CHART_PATH, "utf8"));
  if (!Array.isArray(parsed)) throw new Error("docs/org-chart.json must contain an array");
  return parsed.map((row, index) => {
    for (const field of ["name", "email", "role", "officeCode"] as const) {
      if (typeof row[field] !== "string" || row[field].trim() === "") {
        throw new Error(`Invalid org-chart row ${index + 1}: missing ${field}`);
      }
    }
    if (row.manager !== null && typeof row.manager !== "string") {
      throw new Error(`Invalid org-chart row ${index + 1}: manager must be email or null`);
    }
    return {
      name: row.name.trim(),
      email: normalizeEmail(row.email),
      role: row.role.trim(),
      officeCode: row.officeCode.trim().toLowerCase(),
      manager: row.manager ? normalizeEmail(row.manager) : null,
      crmRole: typeof row.crmRole === "string" ? row.crmRole : undefined,
      status: row.status === "inactive" ? "inactive" : "active",
      flags: Array.isArray(row.flags) ? row.flags.map(String) : [],
      notes: typeof row.notes === "string" ? row.notes : undefined,
      mergeSources: Array.isArray(row.mergeSources) ? row.mergeSources.map((value: unknown) => normalizeEmail(String(value))) : [],
    };
  });
}

function connectionString(): string {
  const publicUrl = process.env.DATABASE_PUBLIC_URL?.trim();
  const privateUrl = process.env.DATABASE_URL?.trim();
  const selected = publicUrl || privateUrl;
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (!publicUrl && /railway\.internal/.test(selected)) {
    throw new Error("DATABASE_URL points at railway.internal. Export DATABASE_PUBLIC_URL in .env and retry.");
  }
  return selected;
}

async function fetchDbUsers(client: pg.Client): Promise<DbUser[]> {
  const result = await client.query(`
    SELECT u.id,
           lower(u.email) AS email,
           u.display_name,
           u.role,
           o.slug AS office_slug,
           u.reports_to,
           u.is_active
      FROM public.users u
      LEFT JOIN public.offices o ON o.id = u.office_id
     ORDER BY lower(u.email)
  `);
  return result.rows.map((row) => ({
    id: row.id,
    email: row.email,
    displayName: row.display_name,
    role: row.role,
    officeSlug: row.office_slug,
    reportsTo: row.reports_to,
    isActive: row.is_active,
  }));
}

async function fetchOfficeSlugs(client: pg.Client): Promise<string[]> {
  const result = await client.query(`SELECT slug FROM public.offices WHERE is_active = true ORDER BY slug`);
  return result.rows.map((row) => row.slug).filter((slug) => /^[a-z0-9_]+$/.test(slug));
}

async function addOwnershipCounts(
  client: pg.Client,
  userIds: string[],
  schemaName: string,
  counts: Map<string, OwnershipCounts>
): Promise<void> {
  if (userIds.length === 0) return;
  const ensure = (userId: string) => {
    const current = counts.get(userId) ?? { deals: 0, leads: 0, tasks: 0 };
    counts.set(userId, current);
    return current;
  };

  const deals = await client.query(
    `SELECT assigned_rep_id AS user_id, count(*)::int AS count
       FROM ${schemaName}.deals
      WHERE assigned_rep_id = ANY($1::uuid[])
        AND is_active = true
      GROUP BY assigned_rep_id`,
    [userIds]
  );
  for (const row of deals.rows) ensure(row.user_id).deals += Number(row.count ?? 0);

  const leads = await client.query(
    `SELECT assigned_rep_id AS user_id, count(*)::int AS count
       FROM ${schemaName}.leads
      WHERE assigned_rep_id = ANY($1::uuid[])
        AND is_active = true
      GROUP BY assigned_rep_id`,
    [userIds]
  );
  for (const row of leads.rows) ensure(row.user_id).leads += Number(row.count ?? 0);

  const tasks = await client.query(
    `SELECT assigned_to AS user_id, count(*)::int AS count
       FROM ${schemaName}.tasks
      WHERE assigned_to = ANY($1::uuid[])
        AND status = ANY($2::task_status[])
      GROUP BY assigned_to`,
    [userIds, ACTIVE_TASK_STATUSES]
  );
  for (const row of tasks.rows) ensure(row.user_id).tasks += Number(row.count ?? 0);
}

async function fetchOwnershipCounts(client: pg.Client, userIds: string[]): Promise<Map<string, OwnershipCounts>> {
  const counts = new Map<string, OwnershipCounts>();
  const officeSlugs = await fetchOfficeSlugs(client);
  for (const slug of officeSlugs) {
    const schemaName = `office_${slug}`;
    if (!/^office_[a-z0-9_]+$/.test(schemaName)) continue;
    await addOwnershipCounts(client, userIds, schemaName, counts);
  }
  return counts;
}

function formatRows<T>(rows: T[], render: (row: T, index: number) => string): string {
  if (rows.length === 0) return "  (none)";
  return rows.map((row, index) => render(row, index)).join("\n");
}

export function renderDryRun(plan: UserCleanupPlan, collisions: ReturnType<typeof detectEmailConventionCollisions>): string {
  const lines: string[] = [];
  lines.push("USER RECONCILIATION DRY RUN");
  lines.push("");
  lines.push("Email convention collisions / flags:");
  lines.push(formatRows(collisions, (row) => `  - ${row.conventionKey}: ${row.users.join("; ")}`));
  lines.push("");
  lines.push(`Users in DB not in org chart → would soft-delete (${plan.wouldSoftDelete.length}):`);
  lines.push(formatRows(plan.wouldSoftDelete, (row) => `  - ${row.displayName} <${row.email}> role=${row.role} office=${row.officeSlug ?? "unknown"} manager=${row.managerEmail ?? "null"}`));
  lines.push("");
  lines.push(`Users in org chart not in DB → would create (${plan.wouldCreate.length}):`);
  lines.push(formatRows(plan.wouldCreate, (row) => `  - ${row.name} <${row.email}> orgRole="${row.role}" crmRole=${row.crmRole} office=${row.officeSlug} manager=${row.manager ?? "null"} status=${row.status ?? "active"}${row.flags?.length ? ` flags=${row.flags.join(",")}` : ""}`));
  lines.push("");
  lines.push(`Inactive / needs-review users → would keep discoverable (${plan.inactiveReviewUsers.length}):`);
  lines.push(formatRows(plan.inactiveReviewUsers, (row) => `  - ${row.displayName} <${row.email}> existsInDb=${row.existsInDb} isActive=${row.isActive} manager=${row.managerEmail ?? "null"}${row.flags.length ? ` flags=${row.flags.join(",")}` : ""}${row.notes ? ` note="${row.notes}"` : ""}`));
  lines.push("");
  lines.push(`Manager mismatches → would update (${plan.managerMismatches.length}):`);
  lines.push(formatRows(plan.managerMismatches, (row) => `  - ${row.email}: ${row.currentManagerEmail ?? "null"} -> ${row.nextManagerEmail ?? "null"} [${row.status}]`));
  lines.push("");
  lines.push(`Role updates planned (${plan.roleMismatches.length}):`);
  lines.push(formatRows(plan.roleMismatches, (row) => `  - ${row.email}: ${row.currentRole ?? "null"} -> ${row.nextRole} [${row.status}]`));
  lines.push("");
  lines.push("Owned-record reassignment plan for soft-deleted users:");
  lines.push(formatRows(plan.reassignmentPlan, (row) => `  - ${row.displayName} <${row.email}> -> ${row.reassignToEmail ?? "UNRESOLVED"}; deals=${row.deals}, leads=${row.leads}, tasks=${row.tasks}`));
  lines.push("");
  lines.push(`Merge plan → reassign ownership then soft-delete source (${plan.mergePlan.length}):`);
  lines.push(formatRows(plan.mergePlan, (row) => `  - ${row.sourceDisplayName} <${row.sourceEmail}> -> ${row.targetEmail}; targetExists=${row.targetExists}, targetWillBeCreated=${row.targetWillBeCreated}; deals=${row.deals}, leads=${row.leads}, tasks=${row.tasks}; after=${row.afterMergeAction}`));
  return lines.join("\n");
}


interface AuditRow {
  timestamp: string;
  step: string;
  action: string;
  entityType: string;
  entityId: string;
  email: string;
  before: string;
  after: string;
  details: string;
}

function nowIso(): string {
  return new Date().toISOString();
}

function csvEscape(value: unknown): string {
  const raw = String(value ?? "");
  if (!/[",\n]/.test(raw)) return raw;
  return `"${raw.replace(/"/g, '""')}"`;
}

function writeAuditCsv(pathname: string, rows: AuditRow[]) {
  const header = ["timestamp", "step", "action", "entityType", "entityId", "email", "before", "after", "details"];
  const lines = [header.join(",")];
  for (const row of rows) {
    lines.push(header.map((key) => csvEscape(row[key as keyof AuditRow])).join(","));
  }
  fs.writeFileSync(pathname, `${lines.join("\n")}\n`);
}

async function ensureMigration0070(client: pg.Client, auditRows: AuditRow[]) {
  await client.query(`
    CREATE TABLE IF NOT EXISTS public._migrations (
      id SERIAL PRIMARY KEY,
      name VARCHAR(255) UNIQUE NOT NULL,
      executed_at TIMESTAMPTZ DEFAULT NOW()
    )
  `);
  const existing = await client.query("SELECT id FROM public._migrations WHERE name = $1", [MIGRATION_0070]);
  const before = await client.query("select enumlabel from pg_enum join pg_type on pg_enum.enumtypid=pg_type.oid where typname='user_role' and enumlabel='construction'");
  const sqlText = fs.readFileSync(path.join(MIGRATIONS_DIR, MIGRATION_0070), "utf8");
  await client.query(sqlText);
  if (existing.rowCount === 0) {
    await client.query("INSERT INTO public._migrations (name) VALUES ($1) ON CONFLICT (name) DO NOTHING", [MIGRATION_0070]);
  }
  const after = await client.query("select enumlabel from pg_enum join pg_type on pg_enum.enumtypid=pg_type.oid where typname='user_role' and enumlabel='construction'");
  auditRows.push({
    timestamp: nowIso(),
    step: "1",
    action: existing.rowCount ? "migration_confirmed" : "migration_applied",
    entityType: "migration",
    entityId: MIGRATION_0070,
    email: "",
    before: String(before.rowCount ?? 0),
    after: String(after.rowCount ?? 0),
    details: "ALTER TYPE user_role ADD VALUE IF NOT EXISTS construction",
  });
}

async function getOfficeIdBySlug(client: pg.Client, slug: string): Promise<string> {
  const result = await client.query("SELECT id FROM public.offices WHERE slug = $1 AND is_active = true", [slug]);
  const id = result.rows[0]?.id;
  if (!id) throw new Error(`Missing active office slug ${slug}`);
  return id;
}

function notificationPrefsPatch(extra: Record<string, unknown>) {
  return JSON.stringify({ userCleanup: extra });
}

async function createMissingUsers(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const dbUsers = await fetchDbUsers(client);
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers });
  for (const user of plan.wouldCreate) {
    const officeId = await getOfficeIdBySlug(client, user.officeSlug);
    const inserted = await client.query(
      `INSERT INTO public.users (email, display_name, role, office_id, is_active, notification_prefs, updated_at)
       VALUES ($1, $2, $3::user_role, $4, $5, COALESCE($6::jsonb, '{}'::jsonb), NOW())
       RETURNING id, email, role, is_active`,
      [user.email, user.name, user.crmRole, officeId, user.status !== "inactive", notificationPrefsPatch({ flags: user.flags ?? [], notes: user.notes ?? null, source: "org_chart_cleanup" })]
    );
    auditRows.push({
      timestamp: nowIso(),
      step: "2",
      action: "create_user",
      entityType: "user",
      entityId: inserted.rows[0].id,
      email: user.email,
      before: "missing",
      after: `${inserted.rows[0].role};active=${inserted.rows[0].is_active}`,
      details: `name=${user.name};office=${user.officeSlug};manager=${user.manager ?? "null"}`,
    });
  }
}

function validateSchemaName(schemaName: string): string {
  if (!/^office_[a-z0-9_]+$/.test(schemaName)) throw new Error(`Invalid schema name ${schemaName}`);
  return schemaName;
}

async function tenantSchemas(client: pg.Client): Promise<string[]> {
  const slugs = await fetchOfficeSlugs(client);
  return slugs.map((slug) => validateSchemaName(`office_${slug}`));
}

async function reassignOwnerRecords(client: pg.Client, fromUserId: string, toUserId: string, email: string, step: string, auditRows: AuditRow[]) {
  for (const schemaName of await tenantSchemas(client)) {
    const deals = await client.query(
      `UPDATE ${schemaName}.deals SET assigned_rep_id = $2, updated_at = NOW() WHERE assigned_rep_id = $1 AND is_active = true RETURNING id, deal_number`,
      [fromUserId, toUserId]
    );
    for (const row of deals.rows) auditRows.push({ timestamp: nowIso(), step, action: "reassign_deal", entityType: `${schemaName}.deal`, entityId: row.id, email, before: fromUserId, after: toUserId, details: row.deal_number ?? "" });

    const leads = await client.query(
      `UPDATE ${schemaName}.leads SET assigned_rep_id = $2, updated_at = NOW() WHERE assigned_rep_id = $1 AND is_active = true RETURNING id, name`,
      [fromUserId, toUserId]
    );
    for (const row of leads.rows) auditRows.push({ timestamp: nowIso(), step, action: "reassign_lead", entityType: `${schemaName}.lead`, entityId: row.id, email, before: fromUserId, after: toUserId, details: row.name ?? "" });

    const tasks = await client.query(
      `UPDATE ${schemaName}.tasks SET assigned_to = $2, updated_at = NOW() WHERE assigned_to = $1 RETURNING id, title, status`,
      [fromUserId, toUserId]
    );
    for (const row of tasks.rows) auditRows.push({ timestamp: nowIso(), step, action: "reassign_task", entityType: `${schemaName}.task`, entityId: row.id, email, before: fromUserId, after: toUserId, details: `${row.status}:${row.title ?? ""}` });
  }
}

async function applyMergePlan(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const dbUsers = await fetchDbUsers(client);
  const dbByEmail = new Map(dbUsers.map((user) => [user.email, user]));
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers, ownershipCountsByUserId: await fetchOwnershipCounts(client, dbUsers.map((user) => user.id)) });
  for (const row of plan.mergePlan) {
    const source = dbByEmail.get(row.sourceEmail);
    const target = dbByEmail.get(row.targetEmail);
    if (!source) throw new Error(`Merge source missing: ${row.sourceEmail}`);
    if (!target) throw new Error(`Merge target missing: ${row.targetEmail}`);
    await client.query("BEGIN");
    try {
      await reassignOwnerRecords(client, source.id, target.id, source.email, "3", auditRows);
      const updated = await client.query(
        `UPDATE public.users
            SET is_active = false,
                notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || $2::jsonb,
                updated_at = NOW()
          WHERE id = $1
          RETURNING id, email, is_active`,
        [source.id, notificationPrefsPatch({ mergedInto: target.email, source: "org_chart_cleanup" })]
      );
      auditRows.push({ timestamp: nowIso(), step: "3", action: "soft_delete_merge_source", entityType: "user", entityId: source.id, email: source.email, before: "active", after: String(updated.rows[0]?.is_active), details: `mergedInto=${target.email}` });
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    }
  }
}

async function applyRoleUpdates(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers: await fetchDbUsers(client) });
  for (const row of plan.roleMismatches) {
    const updated = await client.query(
      `UPDATE public.users SET role = $2::user_role, updated_at = NOW() WHERE lower(email) = lower($1) RETURNING id, email, role`,
      [row.email, row.nextRole]
    );
    auditRows.push({ timestamp: nowIso(), step: "4", action: "update_role", entityType: "user", entityId: updated.rows[0]?.id ?? "", email: row.email, before: row.currentRole, after: row.nextRole, details: row.status });
  }
}

async function applyManagerUpdates(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers: await fetchDbUsers(client) });
  const dbUsers = await fetchDbUsers(client);
  const dbByEmail = new Map(dbUsers.map((user) => [user.email, user]));
  for (const row of plan.managerMismatches) {
    const user = dbByEmail.get(row.email);
    const manager = row.nextManagerEmail ? dbByEmail.get(row.nextManagerEmail) : null;
    if (!user || (row.nextManagerEmail && !manager)) {
      auditRows.push({ timestamp: nowIso(), step: "5", action: "skip_manager_update", entityType: "user", entityId: user?.id ?? "", email: row.email, before: row.currentManagerEmail ?? "null", after: row.nextManagerEmail ?? "null", details: row.status });
      continue;
    }
    const updated = await client.query(
      `UPDATE public.users SET reports_to = $2, updated_at = NOW() WHERE id = $1 RETURNING id, email, reports_to`,
      [user.id, manager?.id ?? null]
    );
    auditRows.push({ timestamp: nowIso(), step: "5", action: "update_manager", entityType: "user", entityId: updated.rows[0].id, email: row.email, before: row.currentManagerEmail ?? "null", after: row.nextManagerEmail ?? "null", details: "" });
  }
}

async function applySoftDeleteReassignments(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const dbUsers = await fetchDbUsers(client);
  const dbByEmail = new Map(dbUsers.map((user) => [user.email, user]));
  const fallback = dbByEmail.get("ashaw@trockgc.com");
  if (!fallback?.isActive) throw new Error("Fallback owner ashaw@trockgc.com does not exist or is inactive");
  const initialPlan = buildUserCleanupPlan({ orgUsers, dbUsers });
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers, ownershipCountsByUserId: await fetchOwnershipCounts(client, initialPlan.wouldSoftDelete.map((user) => user.id)) });
  for (const user of plan.wouldSoftDelete) {
    await reassignOwnerRecords(client, user.id, fallback.id, user.email, "6", auditRows);
  }
}

async function applySoftDeletes(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const dbUsers = await fetchDbUsers(client);
  const plan = buildUserCleanupPlan({ orgUsers, dbUsers });
  for (const user of plan.wouldSoftDelete) {
    const updated = await client.query(
      `UPDATE public.users
          SET is_active = false,
              notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || $2::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, is_active`,
      [user.id, notificationPrefsPatch({ softDeletedBy: "org_chart_cleanup" })]
    );
    auditRows.push({ timestamp: nowIso(), step: "7", action: "soft_delete_user", entityType: "user", entityId: user.id, email: user.email, before: "active", after: String(updated.rows[0]?.is_active), details: "not_in_org_chart" });
  }
}

async function applyInactiveReviewUsers(client: pg.Client, orgUsers: OrgChartUser[], auditRows: AuditRow[]) {
  const inactiveUsers = orgUsers.filter((user) => user.status === "inactive");
  const dbUsers = await fetchDbUsers(client);
  const dbByEmail = new Map(dbUsers.map((user) => [user.email, user]));
  for (const orgUser of inactiveUsers) {
    const user = dbByEmail.get(normalizeEmail(orgUser.email));
    if (!user) continue;
    const manager = orgUser.manager ? dbByEmail.get(normalizeEmail(orgUser.manager)) : null;
    const updated = await client.query(
      `UPDATE public.users
          SET is_active = false,
              role = $2::user_role,
              reports_to = $3,
              notification_prefs = COALESCE(notification_prefs, '{}'::jsonb) || $4::jsonb,
              updated_at = NOW()
        WHERE id = $1
        RETURNING id, email, role, is_active`,
      [user.id, resolveCrmRole(orgUser), manager?.id ?? null, notificationPrefsPatch({ flags: orgUser.flags ?? [], notes: orgUser.notes ?? null, inactiveReason: "needs_review" })]
    );
    auditRows.push({ timestamp: nowIso(), step: "8", action: "mark_inactive_review", entityType: "user", entityId: user.id, email: user.email, before: `${user.role};active=${user.isActive}`, after: `${updated.rows[0].role};active=${updated.rows[0].is_active}`, details: orgUser.notes ?? "" });
  }
}

async function applyUserCleanup(client: pg.Client, orgUsers: OrgChartUser[], auditPath: string) {
  const auditRows: AuditRow[] = [];
  await ensureMigration0070(client, auditRows);
  await createMissingUsers(client, orgUsers, auditRows);
  await applyMergePlan(client, orgUsers, auditRows);
  await applyRoleUpdates(client, orgUsers, auditRows);
  await applyManagerUpdates(client, orgUsers, auditRows);
  await applySoftDeleteReassignments(client, orgUsers, auditRows);
  await applySoftDeletes(client, orgUsers, auditRows);
  await applyInactiveReviewUsers(client, orgUsers, auditRows);
  writeAuditCsv(auditPath, auditRows);
  return auditRows;
}

async function main() {
  const apply = process.argv.includes("--apply");
  const auditPathArg = process.argv.find((arg) => arg.startsWith("--audit-file="));
  const auditPath = auditPathArg?.split("=").slice(1).join("=") || `/tmp/user-cleanup-${new Date().toISOString().replace(/[-:T.Z]/g, "").slice(0, 14)}.csv`;

  const orgUsers = loadOrgChart();
  const collisions = detectEmailConventionCollisions(orgUsers);
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    if (apply) {
      const auditRows = await applyUserCleanup(client, orgUsers, auditPath);
      console.log(`APPLY COMPLETE auditCsv=${auditPath} rows=${auditRows.length}`);
      return;
    }

    const dbUsers = await fetchDbUsers(client);
    const initialPlan = buildUserCleanupPlan({ orgUsers, dbUsers });
    const dbByEmail = new Map(dbUsers.map((user) => [normalizeEmail(user.email), user]));
    const mergeSourceIds = initialPlan.mergePlan
      .map((row) => dbByEmail.get(row.sourceEmail)?.id)
      .filter((id): id is string => Boolean(id));
    const ownershipUserIds = [...new Set([...initialPlan.wouldSoftDelete.map((user) => user.id), ...mergeSourceIds])];
    const ownershipCounts = await fetchOwnershipCounts(client, ownershipUserIds);
    const plan = buildUserCleanupPlan({ orgUsers, dbUsers, ownershipCountsByUserId: ownershipCounts });
    console.log(renderDryRun(plan, collisions));
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
