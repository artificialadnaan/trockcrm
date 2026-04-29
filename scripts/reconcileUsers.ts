import dotenv from "dotenv";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import pg from "pg";

dotenv.config({ path: path.join(path.dirname(fileURLToPath(import.meta.url)), "../.env") });

const ACTIVE_TASK_STATUSES = ["pending", "scheduled", "in_progress", "waiting_on", "blocked"];
const ORG_CHART_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "../docs/org-chart.json");

type CrmRole = "admin" | "director" | "rep";

export interface OrgChartUser {
  name: string;
  email: string;
  role: string;
  officeCode: string;
  manager: string | null;
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
  reassignmentPlan: Array<{
    email: string;
    displayName: string;
    reassignToEmail: string | null;
    deals: number;
    leads: number;
    tasks: number;
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
  if (role === "ceo" || role === "cfo") return "admin";
  if (role.includes("vp") || role.includes("director")) return "director";
  return "rep";
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
  const orgByEmail = new Map(args.orgUsers.map((user) => [normalizeEmail(user.email), { ...user, email: normalizeEmail(user.email), manager: user.manager ? normalizeEmail(user.manager) : null }]));
  const dbByEmail = new Map(args.dbUsers.map((user) => [normalizeEmail(user.email), { ...user, email: normalizeEmail(user.email) }]));
  const dbById = new Map(args.dbUsers.map((user) => [user.id, { ...user, email: normalizeEmail(user.email) }]));
  const ownershipCountsByUserId = args.ownershipCountsByUserId ?? new Map<string, OwnershipCounts>();

  const wouldSoftDelete = args.dbUsers
    .filter((user) => user.isActive && !orgByEmail.has(normalizeEmail(user.email)))
    .map((user) => ({ ...user, email: normalizeEmail(user.email), managerEmail: managerEmailForDbUser(user, dbById) }))
    .sort((a, b) => a.email.localeCompare(b.email));

  const wouldCreate = args.orgUsers
    .filter((user) => !dbByEmail.has(normalizeEmail(user.email)))
    .map((user) => ({
      ...user,
      email: normalizeEmail(user.email),
      manager: user.manager ? normalizeEmail(user.manager) : null,
      crmRole: inferCrmRole(user.role),
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

  return { wouldSoftDelete, wouldCreate, managerMismatches, reassignmentPlan };
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
  lines.push(formatRows(plan.wouldCreate, (row) => `  - ${row.name} <${row.email}> orgRole="${row.role}" crmRole=${row.crmRole} office=${row.officeSlug} manager=${row.manager ?? "null"}`));
  lines.push("");
  lines.push(`Manager mismatches → would update (${plan.managerMismatches.length}):`);
  lines.push(formatRows(plan.managerMismatches, (row) => `  - ${row.email}: ${row.currentManagerEmail ?? "null"} -> ${row.nextManagerEmail ?? "null"} [${row.status}]`));
  lines.push("");
  lines.push("Owned-record reassignment plan for soft-deleted users:");
  lines.push(formatRows(plan.reassignmentPlan, (row) => `  - ${row.displayName} <${row.email}> -> ${row.reassignToEmail ?? "UNRESOLVED"}; deals=${row.deals}, leads=${row.leads}, tasks=${row.tasks}`));
  return lines.join("\n");
}

async function main() {
  const apply = process.argv.includes("--apply");
  if (apply) {
    throw new Error("--apply is intentionally blocked until dry-run output is approved in the workflow.");
  }

  const orgUsers = loadOrgChart();
  const collisions = detectEmailConventionCollisions(orgUsers);
  const client = new pg.Client({ connectionString: connectionString() });
  await client.connect();
  try {
    const dbUsers = await fetchDbUsers(client);
    const initialPlan = buildUserCleanupPlan({ orgUsers, dbUsers });
    const ownershipCounts = await fetchOwnershipCounts(client, initialPlan.wouldSoftDelete.map((user) => user.id));
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
