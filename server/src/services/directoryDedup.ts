import { and, eq, inArray, sql } from "drizzle-orm";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import {
  activities,
  aiDisconnectCases,
  aiDocumentIndex,
  callRecordings,
  companies,
  contacts,
  deals,
  directoryMergeAudit,
  directoryMergeQueue,
  emailLinks,
  emails,
  fileLinks,
  leads,
  properties,
} from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import { AppError } from "../middleware/error-handler.js";
import { refreshEntityEmailStats } from "../modules/email/stats-service.js";

type TenantDb = NodePgDatabase<typeof schema>;

export type DirectoryEntityKind = "company" | "contact";
export type DirectoryMatchBand = "auto_merge" | "review_queue" | "none";

export interface DirectoryCompanyCandidate {
  id?: string;
  name: string;
  state?: string | null;
  zip?: string | null;
}

export interface DirectoryContactCandidate {
  id?: string;
  firstName: string;
  lastName: string;
  email?: string | null;
  state?: string | null;
}

export interface DirectoryMatchInput {
  kind: DirectoryEntityKind;
  left: DirectoryCompanyCandidate | DirectoryContactCandidate;
  right: DirectoryCompanyCandidate | DirectoryContactCandidate;
}

export interface DirectoryMatchResult {
  band: DirectoryMatchBand;
  score: number;
  reasons: string[];
}

const COMPANY_SUFFIXES = /\b(inc|llc|ltd|co|corp|corporation|company|lp|pllc)\b/g;

export function normalizeDirectoryName(value: string | null | undefined): string {
  return (value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function normalizeZip(value: string | null | undefined): string | null {
  const digits = (value ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

export function normalizeEmailDomain(value: string | null | undefined): string | null {
  const email = (value ?? "").trim().toLowerCase();
  const at = email.lastIndexOf("@");
  if (at < 1 || at === email.length - 1) return null;
  return email.slice(at + 1);
}

// ---------------------------------------------------------------------------
// Company merge -- pure planning logic (no IO; unit-tested)
//
// A company merge must re-point EVERY reference to the loser's id, not just the
// company_id FKs. The .audit/company-dedup-discovery.md mapping is encoded once
// here and consumed by the merge, the un-merge, and the dry-run preview so the
// three can never drift apart. Three of the targets are polymorphic
// (entity_type + entity_id) and only hold a company id when the discriminator
// equals 'company'.
// ---------------------------------------------------------------------------

export interface CompanyRepointTarget {
  /** stable identifier used in the audit blob and the preview output */
  key: string;
  /** physical table name (for preview/count SQL) */
  table: string;
  /** column holding the company id */
  column: string;
  /** for polymorphic pointers: the discriminator column ... */
  discriminatorColumn?: string;
  /** ... and the value that means "this id is a company id" */
  discriminatorValue?: string;
}

export const COMPANY_REPOINT_TARGETS: readonly CompanyRepointTarget[] = [
  { key: "deals", table: "deals", column: "company_id" },
  { key: "contacts", table: "contacts", column: "company_id" },
  { key: "leads", table: "leads", column: "company_id" },
  { key: "properties", table: "properties", column: "company_id" },
  { key: "activities", table: "activities", column: "company_id" },
  {
    key: "activities_source_entity",
    table: "activities",
    column: "source_entity_id",
    discriminatorColumn: "source_entity_type",
    discriminatorValue: "company",
  },
  { key: "ai_document_index", table: "ai_document_index", column: "company_id" },
  { key: "ai_disconnect_cases", table: "ai_disconnect_cases", column: "company_id" },
  {
    key: "emails_assigned_entity",
    table: "emails",
    column: "assigned_entity_id",
    discriminatorColumn: "assigned_entity_type",
    discriminatorValue: "company",
  },
  {
    key: "call_recordings_entity",
    table: "call_recordings",
    column: "entity_id",
    discriminatorColumn: "entity_type",
    discriminatorValue: "company",
  },
  {
    key: "email_links_entity",
    table: "email_links",
    column: "entity_id",
    discriminatorColumn: "entity_type",
    discriminatorValue: "company",
  },
  {
    key: "file_links_entity",
    table: "file_links",
    column: "entity_id",
    discriminatorColumn: "entity_type",
    discriminatorValue: "company",
  },
] as const;

/** A company row plus the attachment counts needed to plan a merge. */
export interface CompanyMergeMember {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  phone: string | null;
  website: string | null;
  domain: string | null;
  hubspotId: string | null;
  hubspotCompanyId: string | null;
  procoreId: string | null;
  industry: string | null;
  region: string | null;
  createdAt: string | Date | null;
  dealCount: number;
  contactCount: number;
}

/** Fields reconciled onto the winner (address handled as a unit, see below). */
const RECONCILE_SCALAR_FIELDS = [
  "phone",
  "website",
  "domain",
  "hubspotId",
  "hubspotCompanyId",
  "procoreId",
  "industry",
  "region",
] as const;

const ZIP_PLACEHOLDERS = new Set(["unknown", "n/a", "na", "none", "null", "00000", "-"]);

function hasText(value: string | null | undefined): boolean {
  return Boolean(value && value.trim());
}

function toTimeAsc(value: string | Date | null): number {
  if (!value) return Number.POSITIVE_INFINITY;
  const t = new Date(value).getTime();
  return Number.isNaN(t) ? Number.POSITIVE_INFINITY : t;
}

// Best-record-first ordering: most deals, then has-address, then most contacts,
// then oldest, then lowest id. Used for winner selection and for choosing which
// loser supplies a reconciled field.
function compareMergeRank(a: CompanyMergeMember, b: CompanyMergeMember): number {
  if (b.dealCount !== a.dealCount) return b.dealCount - a.dealCount;
  const aAddr = hasText(a.address) ? 1 : 0;
  const bAddr = hasText(b.address) ? 1 : 0;
  if (bAddr !== aAddr) return bAddr - aAddr;
  const aContacts = a.contactCount ?? 0;
  const bContacts = b.contactCount ?? 0;
  if (bContacts !== aContacts) return bContacts - aContacts;
  const at = toTimeAsc(a.createdAt);
  const bt = toTimeAsc(b.createdAt);
  if (at !== bt) return at - bt;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

export function selectMergeWinner(members: CompanyMergeMember[]): string {
  if (members.length === 0) throw new Error("selectMergeWinner: empty cluster");
  return [...members].sort(compareMergeRank)[0]!.id;
}

export function clusterCompaniesByName(companies: CompanyMergeMember[]): CompanyMergeMember[][] {
  // Group by EXACT name (matches the discovery's name-only clustering). Unlike the
  // legacy zip-keyed matcher this catches the deal-bearing NULL-zip dups (Mack &
  // co). Intentional limitation: this does NOT normalize like
  // normalizeDirectoryName / the merge-queue matcher, so suffix/case variants
  // ('X' vs 'X, LLC') are NOT grouped here -- they surface via the normalized
  // queue and need human review. Treat the dry-run as a floor, not a ceiling.
  const byName = new Map<string, CompanyMergeMember[]>();
  for (const company of companies) {
    const key = company.name;
    const bucket = byName.get(key);
    if (bucket) bucket.push(company);
    else byName.set(key, [company]);
  }
  return [...byName.values()].filter((group) => group.length > 1);
}

function normalizeWebsiteDomain(value: string | null): string | null {
  if (!hasText(value)) return null;
  const s = value!
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/^www\./, "")
    .replace(/\/+$/, "");
  return s || null;
}

function normalizePhoneDigits(value: string | null): string | null {
  if (!hasText(value)) return null;
  const digits = value!.replace(/\D/g, "");
  return digits.length ? digits : null;
}

function addressTupleKey(member: CompanyMergeMember): string | null {
  const parts = [member.address, member.city, member.state, member.zip].map((part) =>
    hasText(part) ? part!.trim().toLowerCase() : ""
  );
  return parts.some((part) => part) ? parts.join("|") : null;
}

export interface ClusterClassification {
  classification: "clearly_safe" | "review";
  reasons: string[];
}

// Clearly-safe = no conflicting distinguishing data (identical/normalizable
// website, at most one distinct real address, at most one distinct phone, no
// placeholder zip). Any conflict -> review (a human decides). Mirrors Section 4
// of the discovery (Harbor Group / Cushman / branch-vs-dup -> review;
// import dups and NULL-address-sibling clusters -> safe).
export function classifyNameCluster(members: CompanyMergeMember[]): ClusterClassification {
  const reasons: string[] = [];

  // Web-identity divergence: collect EVERY normalized web identity present across
  // the cluster -- each member contributes its website AND its domain. More than
  // one distinct identity in the whole set means the rows may be different
  // entities. This catches websites-differ, domains-differ, AND the mixed case
  // (one row's website vs another row's domain-only). Errs toward review.
  const webIdentities = new Set<string>();
  for (const m of members) {
    const w = normalizeWebsiteDomain(m.website);
    if (w) webIdentities.add(w);
    const d = normalizeWebsiteDomain(m.domain);
    if (d) webIdentities.add(d);
  }
  if (webIdentities.size > 1) reasons.push("divergent_website");

  const phones = new Set(members.map((m) => normalizePhoneDigits(m.phone)).filter(Boolean));
  if (phones.size > 1) reasons.push("divergent_phone");

  const addresses = new Set(members.map(addressTupleKey).filter(Boolean));
  if (addresses.size > 1) reasons.push("divergent_address");

  const hasPlaceholderZip = members.some(
    (m) => hasText(m.zip) && ZIP_PLACEHOLDERS.has(m.zip!.trim().toLowerCase())
  );
  if (hasPlaceholderZip) reasons.push("placeholder_zip");

  return { classification: reasons.length > 0 ? "review" : "clearly_safe", reasons };
}

export interface FieldReconciliationPlan {
  /** fields to set on the winner (only where the winner was empty) */
  updates: Record<string, string | null>;
  /** the winner's prior values for those fields (for exact un-merge) */
  winnerBefore: Record<string, string | null>;
}

// The winner inherits the loser's non-null fields ONLY where the winner is
// empty -- never overwriting data the winner already holds. The address is
// copied as a unit from the single best loser that has one (so we never stitch a
// street from one record onto a city from another). Captures winnerBefore so the
// reconciliation is exactly reversible.
export function planFieldReconciliation(
  winner: CompanyMergeMember,
  losers: CompanyMergeMember[]
): FieldReconciliationPlan {
  const updates: Record<string, string | null> = {};
  const winnerBefore: Record<string, string | null> = {};
  const ordered = [...losers].sort(compareMergeRank);

  // Address is an atomic unit: copy it from the single best loser ONLY when the
  // winner has NO address component at all. Never stitch (e.g. a loser's street
  // onto a city the winner already has) and never overwrite a partial winner.
  const winnerHasAddress =
    hasText(winner.address) || hasText(winner.city) || hasText(winner.state) || hasText(winner.zip);
  if (!winnerHasAddress) {
    const src = ordered.find(
      (l) => hasText(l.address) || hasText(l.city) || hasText(l.state) || hasText(l.zip)
    );
    if (src) {
      for (const field of ["address", "city", "state", "zip"] as const) {
        if (hasText(src[field])) {
          updates[field] = src[field];
          winnerBefore[field] = winner[field] ?? null;
        }
      }
    }
  }

  for (const field of RECONCILE_SCALAR_FIELDS) {
    if (hasText(winner[field])) continue;
    const src = ordered.find((l) => hasText(l[field]));
    if (src) {
      updates[field] = src[field];
      winnerBefore[field] = winner[field] ?? null;
    }
  }

  return { updates, winnerBefore };
}

// ---------------------------------------------------------------------------
// Dry-run preview (read-only): what a per-cluster merge WOULD do. Pure assembly
// of the planning helpers above plus the caller-supplied moved-row tallies (the
// caller runs the read-only COUNT/id queries against each COMPANY_REPOINT_TARGETS
// table). No IO here -- the preview never writes.
// ---------------------------------------------------------------------------

export interface TargetMove {
  /** matches a COMPANY_REPOINT_TARGETS key */
  key: string;
  table: string;
  count: number;
  /** sample of moved row ids (may be capped / empty depending on caller) */
  ids: string[];
}

export interface LoserMovePlan {
  loserId: string;
  moves: TargetMove[];
  totalRows: number;
}

export interface ClusterMergePlan {
  name: string;
  classification: "clearly_safe" | "review";
  reasons: string[];
  winnerId: string;
  winner: CompanyMergeMember;
  losers: CompanyMergeMember[];
  reconciliation: FieldReconciliationPlan;
  loserPlans: LoserMovePlan[];
  totalMovedRows: number;
}

export function buildClusterMergePlan(
  members: CompanyMergeMember[],
  movesByCompanyId: Record<string, TargetMove[]>
): ClusterMergePlan {
  const winnerId = selectMergeWinner(members);
  const winner = members.find((m) => m.id === winnerId)!;
  const losers = members.filter((m) => m.id !== winnerId);
  const { classification, reasons } = classifyNameCluster(members);
  const reconciliation = planFieldReconciliation(winner, losers);
  const loserPlans: LoserMovePlan[] = losers.map((loser) => {
    const moves = movesByCompanyId[loser.id] ?? [];
    return { loserId: loser.id, moves, totalRows: moves.reduce((sum, m) => sum + m.count, 0) };
  });
  return {
    name: winner.name,
    classification,
    reasons,
    winnerId,
    winner,
    losers,
    reconciliation,
    loserPlans,
    totalMovedRows: loserPlans.reduce((sum, p) => sum + p.totalRows, 0),
  };
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] =
        a[i - 1] === b[j - 1]
          ? rows[i - 1][j - 1]
          : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  const distance = rows[a.length][b.length];
  return 1 - distance / Math.max(a.length, b.length);
}

function sameState(left: { state?: string | null }, right: { state?: string | null }): boolean {
  const a = left.state?.trim().toUpperCase();
  const b = right.state?.trim().toUpperCase();
  return Boolean(a && b && a === b);
}

function contactName(candidate: DirectoryContactCandidate): string {
  return normalizeDirectoryName(`${candidate.firstName} ${candidate.lastName}`);
}

export function classifyDirectoryMatch(input: DirectoryMatchInput): DirectoryMatchResult {
  const reasons: string[] = [];
  let score = 0;

  if (input.kind === "company") {
    const left = input.left as DirectoryCompanyCandidate;
    const right = input.right as DirectoryCompanyCandidate;
    const leftName = normalizeDirectoryName(left.name);
    const rightName = normalizeDirectoryName(right.name);
    const leftZip = normalizeZip(left.zip);
    const rightZip = normalizeZip(right.zip);
    const nameScore = similarity(leftName, rightName);

    if (leftName && rightName && leftName === rightName && leftZip && leftZip === rightZip) {
      reasons.push("exact_normalized_name_zip");
      score = 0.99;
    } else if (sameState(left, right) && nameScore >= 0.9) {
      reasons.push("fuzzy_name_same_state");
      score = Math.min(0.94, Math.max(0.8, nameScore));
    }
  } else {
    const left = input.left as DirectoryContactCandidate;
    const right = input.right as DirectoryContactCandidate;
    const leftDomain = normalizeEmailDomain(left.email);
    const rightDomain = normalizeEmailDomain(right.email);
    const nameScore = similarity(contactName(left), contactName(right));

    if (left.email && right.email && left.email.trim().toLowerCase() === right.email.trim().toLowerCase()) {
      reasons.push("exact_email");
      score = 0.99;
    } else if (leftDomain && rightDomain && leftDomain === rightDomain) {
      reasons.push("domain_match");
      score = Math.max(score, 0.86);
    }

    if (sameState(left, right) && nameScore >= 0.9) {
      reasons.push("fuzzy_name_same_state");
      score = Math.max(score, Math.min(0.94, nameScore));
    }
  }

  return {
    band: score >= 0.95 ? "auto_merge" : score >= 0.8 ? "review_queue" : "none",
    score: Number(score.toFixed(3)),
    reasons,
  };
}

function orderedPair(a: string, b: string): [string, string] {
  return a < b ? [a, b] : [b, a];
}

function directoryPairLockKey(entityType: DirectoryEntityKind, a: string, b: string): string {
  const [entityAId, entityBId] = orderedPair(a, b);
  return `directory-dedup:${entityType}:${entityAId}:${entityBId}`;
}

async function tryAcquireDirectoryPairLock(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  a: string,
  b: string
): Promise<boolean> {
  const lockKey = directoryPairLockKey(entityType, a, b);
  const result = await tenantDb.execute(sql`
    SELECT pg_try_advisory_xact_lock(hashtext(${lockKey})) AS locked
  `);
  const rows = (result as any).rows ?? result;
  return Boolean(rows[0]?.locked);
}

async function upsertQueueEntry(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  a: string,
  b: string,
  match: DirectoryMatchResult,
  status: "pending" | "auto_merged" = "pending"
) {
  const [entityAId, entityBId] = orderedPair(a, b);
  await tenantDb
    .insert(directoryMergeQueue)
    .values({
      entityType,
      entityAId,
      entityBId,
      confidenceScore: String(match.score),
      matchReasons: match.reasons,
      status,
    })
    .onConflictDoUpdate({
      target: [directoryMergeQueue.entityType, directoryMergeQueue.entityAId, directoryMergeQueue.entityBId],
      set: {
        confidenceScore: String(match.score),
        matchReasons: match.reasons,
        updatedAt: new Date(),
      },
    });
}

export async function scanDirectoryDuplicates(
  tenantDb: TenantDb,
  options: { autoMerge?: boolean; limit?: number } = {}
) {
  const autoMerge = options.autoMerge ?? false;
  const limit = options.limit ?? 1000;
  const companyRows = await tenantDb.select().from(companies).where(eq(companies.isActive, true)).limit(limit);
  const contactRows = await tenantDb.select().from(contacts).where(eq(contacts.isActive, true)).limit(limit);
  let queued = 0;
  let autoMerged = 0;

  for (let i = 0; i < companyRows.length; i++) {
    for (let j = i + 1; j < companyRows.length; j++) {
      const match = classifyDirectoryMatch({ kind: "company", left: companyRows[i], right: companyRows[j] });
      if (match.band === "none") continue;
      if (!(await tryAcquireDirectoryPairLock(tenantDb, "company", companyRows[i].id, companyRows[j].id))) {
        continue;
      }
      if (match.band === "auto_merge" && autoMerge) {
        await mergeDirectoryEntities(tenantDb, "company", companyRows[i].id, companyRows[j].id, {
          mode: "auto",
          confidenceScore: match.score,
          matchReasons: match.reasons,
        });
        await upsertQueueEntry(tenantDb, "company", companyRows[i].id, companyRows[j].id, match, "auto_merged");
        autoMerged += 1;
      } else {
        await upsertQueueEntry(tenantDb, "company", companyRows[i].id, companyRows[j].id, match);
        queued += 1;
      }
    }
  }

  for (let i = 0; i < contactRows.length; i++) {
    for (let j = i + 1; j < contactRows.length; j++) {
      const match = classifyDirectoryMatch({ kind: "contact", left: contactRows[i], right: contactRows[j] });
      if (match.band === "none") continue;
      if (!(await tryAcquireDirectoryPairLock(tenantDb, "contact", contactRows[i].id, contactRows[j].id))) {
        continue;
      }
      if (match.band === "auto_merge" && autoMerge) {
        await mergeDirectoryEntities(tenantDb, "contact", contactRows[i].id, contactRows[j].id, {
          mode: "auto",
          confidenceScore: match.score,
          matchReasons: match.reasons,
        });
        await upsertQueueEntry(tenantDb, "contact", contactRows[i].id, contactRows[j].id, match, "auto_merged");
        autoMerged += 1;
      } else {
        await upsertQueueEntry(tenantDb, "contact", contactRows[i].id, contactRows[j].id, match);
        queued += 1;
      }
    }
  }

  return { scannedCompanies: companyRows.length, scannedContacts: contactRows.length, queued, autoMerged };
}

export async function listDirectoryMergeQueue(tenantDb: TenantDb, status = "pending") {
  const entries = await tenantDb
    .select()
    .from(directoryMergeQueue)
    .where(eq(directoryMergeQueue.status, status as any))
    .orderBy(sql`${directoryMergeQueue.confidenceScore} DESC`, directoryMergeQueue.createdAt)
    .limit(100);

  const result = [];
  for (const entry of entries) {
    const table = entry.entityType === "company" ? companies : contacts;
    const entityA = await tenantDb.select().from(table as any).where(eq((table as any).id, entry.entityAId)).limit(1);
    const entityB = await tenantDb.select().from(table as any).where(eq((table as any).id, entry.entityBId)).limit(1);
    result.push({ ...entry, entityA: entityA[0] ?? null, entityB: entityB[0] ?? null });
  }
  return result;
}

// Build the merge-planning view of a company row. Counts default to 0; they only
// affect ordering when reconciling against multiple losers, and the merge runs
// exactly one loser at a time, so ordering is moot here.
function toMergeMember(row: Record<string, any>): CompanyMergeMember {
  return {
    id: row.id,
    name: row.name,
    address: row.address ?? null,
    city: row.city ?? null,
    state: row.state ?? null,
    zip: row.zip ?? null,
    phone: row.phone ?? null,
    website: row.website ?? null,
    domain: row.domain ?? null,
    hubspotId: row.hubspotId ?? null,
    hubspotCompanyId: row.hubspotCompanyId ?? null,
    procoreId: row.procoreId ?? null,
    industry: row.industry ?? null,
    region: row.region ?? null,
    createdAt: row.createdAt ?? null,
    dealCount: 0,
    contactCount: 0,
  };
}

// Re-point loser -> winner for one target via UPDATE ... RETURNING, so the
// captured ids are EXACTLY the rows moved (no select-then-update race where a
// concurrently-inserted loser row would be moved but missing from the audit).
// Extra set columns (e.g. contacts.company_name) are applied in the same write.
async function moveRef(
  tenantDb: TenantDb,
  table: any,
  idColumn: any,
  refColumnName: string,
  winnerId: string,
  whereCond: any,
  extraSet: Record<string, unknown> = {}
): Promise<string[]> {
  const rows = await (tenantDb as any)
    .update(table)
    .set({ [refColumnName]: winnerId, ...extraSet })
    .where(whereCond)
    .returning({ id: idColumn });
  return rows.map((r: any) => String(r.id));
}

// Re-point EVERY company reference from loser -> winner (the complete map encoded
// in COMPANY_REPOINT_TARGETS), capturing the exact row ids moved per target so the
// merge can be reversed precisely. deals.company_id is re-pointed ALONE -- no
// value/date/stage column is ever written, so the Won basis stays invariant. The
// returned keys match COMPANY_REPOINT_TARGETS keys one-for-one.
async function repointCompanyReferences(
  tenantDb: TenantDb,
  winnerId: string,
  loserId: string,
  winnerName: string
): Promise<Record<string, string[]>> {
  const moved: Record<string, string[]> = {};

  moved.deals = await moveRef(tenantDb, deals, deals.id, "companyId", winnerId, eq(deals.companyId, loserId));
  // contacts: re-point + refresh the denormalized company_name snapshot.
  moved.contacts = await moveRef(tenantDb, contacts, contacts.id, "companyId", winnerId, eq(contacts.companyId, loserId), {
    companyName: winnerName,
  });
  moved.leads = await moveRef(tenantDb, leads, leads.id, "companyId", winnerId, eq(leads.companyId, loserId));
  moved.properties = await moveRef(tenantDb, properties, properties.id, "companyId", winnerId, eq(properties.companyId, loserId));
  moved.activities = await moveRef(tenantDb, activities, activities.id, "companyId", winnerId, eq(activities.companyId, loserId));
  // Polymorphic: activities.source_entity_id is a SEPARATE column from company_id.
  moved.activities_source_entity = await moveRef(
    tenantDb,
    activities,
    activities.id,
    "sourceEntityId",
    winnerId,
    and(eq(activities.sourceEntityType, "company"), eq(activities.sourceEntityId, loserId))
  );
  moved.ai_document_index = await moveRef(tenantDb, aiDocumentIndex, aiDocumentIndex.id, "companyId", winnerId, eq(aiDocumentIndex.companyId, loserId));
  moved.ai_disconnect_cases = await moveRef(tenantDb, aiDisconnectCases, aiDisconnectCases.id, "companyId", winnerId, eq(aiDisconnectCases.companyId, loserId));
  moved.emails_assigned_entity = await moveRef(
    tenantDb,
    emails,
    emails.id,
    "assignedEntityId",
    winnerId,
    and(eq(emails.assignedEntityType, "company"), eq(emails.assignedEntityId, loserId))
  );
  moved.call_recordings_entity = await moveRef(
    tenantDb,
    callRecordings,
    callRecordings.id,
    "entityId",
    winnerId,
    and(eq(callRecordings.entityType, "company"), eq(callRecordings.entityId, loserId))
  );
  // Polymorphic association tables. NOTE: these carry UNIQUE(parent, entity_type,
  // entity_id), so if the SAME file/email were linked to BOTH the winner and loser
  // company, re-pointing would violate it and the whole merge aborts (fail-safe --
  // no corruption). Not reachable today (zero company-typed rows in prod); full
  // de-duplicating conflict handling is a documented follow-up if they ever appear.
  moved.email_links_entity = await moveRef(
    tenantDb,
    emailLinks,
    emailLinks.id,
    "entityId",
    winnerId,
    and(eq(emailLinks.entityType, "company"), eq(emailLinks.entityId, loserId))
  );
  moved.file_links_entity = await moveRef(
    tenantDb,
    fileLinks,
    fileLinks.id,
    "entityId",
    winnerId,
    and(eq(fileLinks.entityType, "company"), eq(fileLinks.entityId, loserId))
  );

  return moved;
}

// A company merge issues many writes (re-point every reference, reconcile the
// winner, deactivate the loser, write the audit row). It MUST run inside a
// transaction so a mid-merge failure rolls back atomically -- all current callers
// provide one: the tenant middleware wraps each request in BEGIN..COMMIT and
// scripts/consolidateDirectory.ts wraps each tenant in BEGIN..COMMIT.
export async function mergeDirectoryEntities(
  tenantDb: TenantDb,
  entityType: DirectoryEntityKind,
  winnerId: string,
  loserId: string,
  options: {
    queueEntryId?: string;
    mergedBy?: string | null;
    mode: "auto" | "manual";
    confidenceScore: number;
    matchReasons: string[];
  }
) {
  if (winnerId === loserId) throw new AppError(400, "Cannot merge an entity with itself");

  let auditFieldChanges: Record<string, unknown> = { loserIsActive: false, winnerId };

  if (entityType === "company") {
    const [winnerRow] = await tenantDb.select().from(companies).where(eq(companies.id, winnerId)).limit(1);
    const [loserRow] = await tenantDb.select().from(companies).where(eq(companies.id, loserId)).limit(1);
    if (!winnerRow) throw new AppError(404, "Merge winner company not found");
    if (!loserRow) throw new AppError(404, "Merge loser company not found");

    // Re-point every reference (capturing moved ids) BEFORE deactivating the loser.
    const movedRows = await repointCompanyReferences(tenantDb, winnerId, loserId, (winnerRow as any).name);

    // Winner inherits the loser's non-null fields only where the winner is empty.
    // Apply each field with a concurrent-safe guard: only fill it if the winner
    // column is STILL NULL at write time, so a value populated by another request
    // between our read and this write is preserved (keeps the "only where empty"
    // rule atomic).
    const reconciliation = planFieldReconciliation(toMergeMember(winnerRow as any), [
      toMergeMember(loserRow as any),
    ]);
    for (const [field, value] of Object.entries(reconciliation.updates)) {
      const column = (companies as any)[field];
      if (!column) continue;
      await tenantDb
        .update(companies)
        .set({ [field]: value } as any)
        .where(and(eq(companies.id, winnerId), sql`${column} IS NULL`));
    }

    // Loser is soft-deactivated and stamped with merged_into -- NEVER deleted.
    await tenantDb
      .update(companies)
      .set({
        isActive: false,
        sourceRefs: sql`COALESCE(source_refs, '{}'::jsonb) || jsonb_build_object('merged_into', ${winnerId})`,
      } as any)
      .where(eq(companies.id, loserId));

    // The emails just moved to the winner -- refresh the denormalized
    // companies.email_count / last_email_at for both so the company UI is accurate.
    await refreshEntityEmailStats(tenantDb, "company", winnerId);
    await refreshEntityEmailStats(tenantDb, "company", loserId);

    auditFieldChanges = {
      loserIsActive: false,
      winnerId,
      movedRows,
      reconciled: reconciliation.updates,
      winnerBefore: reconciliation.winnerBefore,
    };
  } else {
    await tenantDb
      .update(contacts)
      .set({
        isActive: false,
        sourceRefs: sql`COALESCE(source_refs, '{}'::jsonb) || jsonb_build_object('merged_into', ${winnerId})`,
      } as any)
      .where(eq(contacts.id, loserId));
  }

  await tenantDb.insert(directoryMergeAudit).values({
    queueEntryId: options.queueEntryId ?? null,
    entityType,
    winnerId,
    loserId,
    confidenceScore: String(options.confidenceScore),
    matchReasons: options.matchReasons,
    mode: options.mode,
    mergedBy: options.mergedBy ?? null,
    fieldChanges: auditFieldChanges,
  });

  if (options.queueEntryId) {
    await tenantDb
      .update(directoryMergeQueue)
      .set({
        status: options.mode === "auto" ? "auto_merged" : "merged",
        resolvedBy: options.mergedBy ?? null,
        resolvedAt: new Date(),
        updatedAt: new Date(),
      })
      .where(eq(directoryMergeQueue.id, options.queueEntryId));
  }

  return { winnerId, loserId, entityType };
}

// Re-point the captured rows back to the loser, but ONLY rows that STILL point at
// the winner -- a row independently re-pointed elsewhere after the merge is left
// untouched (no blind clobber). The discriminator is re-asserted for polymorphic
// targets so a row whose type changed is not dragged back.
async function restoreLoserRefIds(
  tenantDb: TenantDb,
  table: any,
  idColumn: any,
  refColumn: any,
  refColumnName: string,
  ids: string[] | undefined,
  winnerId: string,
  loserId: string,
  discriminator?: { column: any; value: string }
): Promise<void> {
  if (!ids || ids.length === 0) return;
  const conditions = [inArray(idColumn, ids), eq(refColumn, winnerId)];
  if (discriminator) conditions.push(eq(discriminator.column, discriminator.value));
  await (tenantDb as any)
    .update(table)
    .set({ [refColumnName]: loserId })
    .where(and(...conditions));
}

// Exact reversal of a company merge using the moved-row ids captured in the audit
// row. Every reference still on the winner is re-pointed back to the loser, the
// winner's reconciled fields are restored to their pre-merge values (compare-and-
// swap: only if unchanged since the merge), and the loser is reactivated
// (merged_into cleared). The loser row was never deleted, so the un-merge is
// always possible. A reversal audit row is written for traceability. Like the
// merge, this MUST run inside a transaction (the caller wraps one); no production
// caller is wired yet.
export async function unmergeDirectoryEntities(tenantDb: TenantDb, auditId: string) {
  const [audit] = await tenantDb
    .select()
    .from(directoryMergeAudit)
    .where(eq(directoryMergeAudit.id, auditId))
    .limit(1);
  if (!audit) throw new AppError(404, "Merge audit record not found");
  if ((audit as any).entityType !== "company") {
    throw new AppError(400, "Un-merge is only supported for company merges");
  }
  // Only a forward merge is reversible. Real merges are written with mode 'auto'
  // or 'manual' (the values mergeDirectoryEntities' callers pass); a reversal row
  // has mode 'unmerge' and must never be reversed again.
  if ((audit as any).mode !== "auto" && (audit as any).mode !== "manual") {
    throw new AppError(400, "Audit row is not a reversible company merge");
  }
  // Legacy audits (pre reversible-merge) carry no captured moved rows -- reversing
  // one would reactivate the loser without re-pointing anything. Reject them.
  const fieldChanges = ((audit as any).fieldChanges ?? {}) as {
    movedRows?: Record<string, string[]>;
    winnerBefore?: Record<string, string | null>;
    reconciled?: Record<string, string | null>;
  };
  if (!fieldChanges.movedRows) {
    throw new AppError(400, "Audit predates reversible merges (no captured moved rows)");
  }
  // Refuse to reverse a merge that has already been reversed once.
  const [existingReversal] = await tenantDb
    .select()
    .from(directoryMergeAudit)
    .where(
      and(
        eq(directoryMergeAudit.mode, "unmerge"),
        sql`${directoryMergeAudit.fieldChanges} ->> 'reversedAuditId' = ${auditId}`
      )
    )
    .limit(1);
  if (existingReversal) {
    throw new AppError(409, "This merge has already been reversed");
  }

  const winnerId = (audit as any).winnerId as string;
  const loserId = (audit as any).loserId as string;
  const movedRows = fieldChanges.movedRows ?? {};
  const winnerBefore = fieldChanges.winnerBefore ?? {};
  const reconciled = fieldChanges.reconciled ?? {};

  const [winnerRow] = await tenantDb.select().from(companies).where(eq(companies.id, winnerId)).limit(1);
  const [loserRow] = await tenantDb.select().from(companies).where(eq(companies.id, loserId)).limit(1);
  if (!loserRow) throw new AppError(404, "Merge loser company not found");
  const loserName = (loserRow as any)?.name ?? null;

  // Stale-reversal guard: the loser must still be merged into THIS winner. If it
  // was since re-merged into a different company (its merged_into points
  // elsewhere) or already reactivated, reversing this older audit would resurrect
  // it and clobber the newer state -- refuse.
  const loserMergedInto = ((loserRow as any)?.sourceRefs ?? {}).merged_into;
  if (loserMergedInto !== winnerId) {
    throw new AppError(409, "Loser is no longer merged into this winner (stale un-merge)");
  }

  await restoreLoserRefIds(tenantDb, deals, deals.id, deals.companyId, "companyId", movedRows.deals, winnerId, loserId);
  if (movedRows.contacts && movedRows.contacts.length > 0) {
    await tenantDb
      .update(contacts)
      .set({ companyId: loserId, companyName: loserName })
      .where(and(inArray(contacts.id, movedRows.contacts), eq(contacts.companyId, winnerId)));
  }
  await restoreLoserRefIds(tenantDb, leads, leads.id, leads.companyId, "companyId", movedRows.leads, winnerId, loserId);
  await restoreLoserRefIds(tenantDb, properties, properties.id, properties.companyId, "companyId", movedRows.properties, winnerId, loserId);
  await restoreLoserRefIds(tenantDb, activities, activities.id, activities.companyId, "companyId", movedRows.activities, winnerId, loserId);
  await restoreLoserRefIds(
    tenantDb,
    activities,
    activities.id,
    activities.sourceEntityId,
    "sourceEntityId",
    movedRows.activities_source_entity,
    winnerId,
    loserId,
    { column: activities.sourceEntityType, value: "company" }
  );
  await restoreLoserRefIds(
    tenantDb,
    aiDocumentIndex,
    aiDocumentIndex.id,
    aiDocumentIndex.companyId,
    "companyId",
    movedRows.ai_document_index,
    winnerId,
    loserId
  );
  await restoreLoserRefIds(
    tenantDb,
    aiDisconnectCases,
    aiDisconnectCases.id,
    aiDisconnectCases.companyId,
    "companyId",
    movedRows.ai_disconnect_cases,
    winnerId,
    loserId
  );
  await restoreLoserRefIds(
    tenantDb,
    emails,
    emails.id,
    emails.assignedEntityId,
    "assignedEntityId",
    movedRows.emails_assigned_entity,
    winnerId,
    loserId,
    { column: emails.assignedEntityType, value: "company" }
  );
  await restoreLoserRefIds(
    tenantDb,
    callRecordings,
    callRecordings.id,
    callRecordings.entityId,
    "entityId",
    movedRows.call_recordings_entity,
    winnerId,
    loserId,
    { column: callRecordings.entityType, value: "company" }
  );
  await restoreLoserRefIds(
    tenantDb,
    emailLinks,
    emailLinks.id,
    emailLinks.entityId,
    "entityId",
    movedRows.email_links_entity,
    winnerId,
    loserId,
    { column: emailLinks.entityType, value: "company" }
  );
  await restoreLoserRefIds(
    tenantDb,
    fileLinks,
    fileLinks.id,
    fileLinks.entityId,
    "entityId",
    movedRows.file_links_entity,
    winnerId,
    loserId,
    { column: fileLinks.entityType, value: "company" }
  );

  // Restore the winner's reconciled fields, but only where the value still equals
  // what the merge set -- a field edited after the merge is left as-is. This is a
  // true compare-and-swap: the read-time check skips obviously-edited fields, and
  // the per-field WHERE re-asserts the merged value at write time so a concurrent
  // edit between the read and the write cannot be clobbered.
  for (const field of Object.keys(winnerBefore)) {
    const current = (winnerRow as any)?.[field] ?? null;
    const mergedValue = reconciled[field] ?? null;
    if (current !== mergedValue) continue;
    const column = (companies as any)[field];
    if (!column) continue;
    await tenantDb
      .update(companies)
      .set({ [field]: winnerBefore[field] } as any)
      .where(and(eq(companies.id, winnerId), sql`${column} IS NOT DISTINCT FROM ${mergedValue}`));
  }

  // Reactivate the loser and drop merged_into.
  await tenantDb
    .update(companies)
    .set({
      isActive: true,
      sourceRefs: sql`COALESCE(source_refs, '{}'::jsonb) - 'merged_into'`,
    } as any)
    .where(eq(companies.id, loserId));

  // Emails moved back to the loser -- refresh both denormalized email counters.
  await refreshEntityEmailStats(tenantDb, "company", winnerId);
  await refreshEntityEmailStats(tenantDb, "company", loserId);

  await tenantDb.insert(directoryMergeAudit).values({
    queueEntryId: (audit as any).queueEntryId ?? null,
    entityType: "company",
    winnerId,
    loserId,
    confidenceScore: (audit as any).confidenceScore,
    matchReasons: (audit as any).matchReasons,
    mode: "unmerge",
    mergedBy: null,
    fieldChanges: { reversedAuditId: auditId, restoredWinnerFields: winnerBefore, movedRowsRestored: movedRows },
  });

  return { winnerId, loserId, reversedAuditId: auditId };
}

export async function resolveDirectoryMergeQueueEntry(
  tenantDb: TenantDb,
  queueEntryId: string,
  action: "merge" | "dismiss",
  actorUserId: string,
  winnerId?: string
) {
  const [entry] = await tenantDb.select().from(directoryMergeQueue).where(eq(directoryMergeQueue.id, queueEntryId)).limit(1);
  if (!entry || entry.status !== "pending") throw new AppError(404, "Directory merge queue entry not found");

  if (action === "dismiss") {
    await tenantDb
      .update(directoryMergeQueue)
      .set({ status: "dismissed", resolvedBy: actorUserId, resolvedAt: new Date(), updatedAt: new Date() })
      .where(eq(directoryMergeQueue.id, queueEntryId));
    return { dismissed: true };
  }

  const chosenWinnerId = winnerId ?? entry.entityAId;
  const loserId = chosenWinnerId === entry.entityAId ? entry.entityBId : entry.entityAId;
  return mergeDirectoryEntities(tenantDb, entry.entityType, chosenWinnerId, loserId, {
    queueEntryId,
    mergedBy: actorUserId,
    mode: "manual",
    confidenceScore: Number(entry.confidenceScore),
    matchReasons: entry.matchReasons,
  });
}
