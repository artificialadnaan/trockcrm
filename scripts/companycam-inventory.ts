import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { getAllProjects } from "../server/src/modules/companycam/client.js";

const DEFAULT_TENANT = "office_dallas";
const PROJECT_NUMBER_REGEX = /\b(?:DFW|ATL)-\d+-\d{5}-[a-z]{2}\b/i;
const AUTO_IMPORT_FUZZY_THRESHOLD = 0.9;

export interface CompanyCamProjectForPlan {
  id: string;
  name: string | null; // CompanyCam occasionally returns a null project name
  photoCount: number;
}

export interface DealForCompanyCamPlan {
  id: string;
  name: string;
  dealNumber: string | null;
  projectNumber: string | null;
  companycamProjectId: string | null;
  // Optional so the import script (which does not select on_hold) keeps compiling; the inventory
  // run populates it so the plan can report which matches land on on-hold deals.
  onHold?: boolean | null;
}

export interface CompanyCamImportPlanRow {
  companyCamProjectId: string;
  companyCamProjectName: string;
  photoCount: number;
  matchedDealId: string | null;
  matchedDealName: string | null;
  matchedDealNumber: string | null;
  confidence: number;
  matchReason: string;
  // on_hold status of the matched deal (null when unmatched, or when the caller did not load it).
  matchedDealOnHold?: boolean | null;
}

export function normalizeCompanyCamProjectName(value: string | null | undefined): string {
  if (!value) return "";
  return value
    .toLowerCase()
    .replace(PROJECT_NUMBER_REGEX, " ")
    .replace(/\b(project|photos?)\b/g, " ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function similarity(a: string, b: string): number {
  if (!a || !b) return 0; // empty (e.g. a null/blank or "Project"/"Photos"-only name) is never a match
  if (a === b) return 1;
  const rows = Array.from({ length: a.length + 1 }, (_, i) => [i]);
  for (let j = 1; j <= b.length; j++) rows[0][j] = j;
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      rows[i][j] = a[i - 1] === b[j - 1]
        ? rows[i - 1][j - 1]
        : 1 + Math.min(rows[i - 1][j], rows[i][j - 1], rows[i - 1][j - 1]);
    }
  }
  return 1 - rows[a.length][b.length] / Math.max(a.length, b.length);
}

// ─── Seed disposition (read-only classification of the agreed seed policy) ─────
// Only RELIABLE tiers auto-seed, and never onto an on-hold deal:
//   auto          = existing CompanyCam link, project-number-in-name, OR exact-AND-unique name, AND not on hold
//   manual_review = ambiguous-exact (name maps to >1 deal), sub-1.0 fuzzy, unmatched, OR on-hold
// The seed itself stays behind the gate; this only classifies the plan so the report can show
// how many photos would auto-seed vs. need human linking.
export type CompanyCamPlanDisposition = "auto" | "manual_review";

const AUTO_SEED_MATCH_REASONS = new Set(["existing_companycam_link", "project_number_in_name", "exact_unique_name"]);
const PLAN_TIERS = ["existing_companycam_link", "project_number_in_name", "exact_unique_name", "fuzzy_project_name", "unmatched"] as const;
type PlanTier = (typeof PLAN_TIERS)[number];

export function companyCamPlanDisposition(row: CompanyCamImportPlanRow): CompanyCamPlanDisposition {
  if (AUTO_SEED_MATCH_REASONS.has(row.matchReason) && row.matchedDealOnHold !== true) return "auto";
  return "manual_review";
}

interface PlanBucket {
  projects: number;
  photos: number;
}
const emptyBucket = (): PlanBucket => ({ projects: 0, photos: 0 });
function addToBucket(bucket: PlanBucket, photoCount: number): void {
  bucket.projects += 1;
  bucket.photos += photoCount;
}

export interface CompanyCamPlanSummary {
  totalProjects: number;
  totalPhotos: number;
  matchedProjects: number;
  unmatchedProjects: number;
  byTier: Record<PlanTier, PlanBucket>;
  onHoldExcluded: PlanBucket; // matched to an on-hold deal -> skipped by the seed, routed to manual review
  autoSeed: PlanBucket; // reliable tier (link/number) + not on hold -> safe to auto-seed
  manualReview: PlanBucket; // fuzzy + unmatched + on-hold matches -> human linking
}

export function summarizeCompanyCamPlan(rows: CompanyCamImportPlanRow[]): CompanyCamPlanSummary {
  const summary: CompanyCamPlanSummary = {
    totalProjects: rows.length,
    totalPhotos: 0,
    matchedProjects: 0,
    unmatchedProjects: 0,
    byTier: {
      existing_companycam_link: emptyBucket(),
      project_number_in_name: emptyBucket(),
      exact_unique_name: emptyBucket(),
      fuzzy_project_name: emptyBucket(),
      unmatched: emptyBucket(),
    },
    onHoldExcluded: emptyBucket(),
    autoSeed: emptyBucket(),
    manualReview: emptyBucket(),
  };
  for (const row of rows) {
    summary.totalPhotos += row.photoCount;
    if (row.matchedDealId) summary.matchedProjects += 1;
    else summary.unmatchedProjects += 1;
    const tier: PlanTier = (PLAN_TIERS as readonly string[]).includes(row.matchReason)
      ? (row.matchReason as PlanTier)
      : "unmatched";
    addToBucket(summary.byTier[tier], row.photoCount);
    if (row.matchedDealOnHold === true) addToBucket(summary.onHoldExcluded, row.photoCount);
    addToBucket(companyCamPlanDisposition(row) === "auto" ? summary.autoSeed : summary.manualReview, row.photoCount);
  }
  return summary;
}

export function buildCompanyCamImportPlan(projects: CompanyCamProjectForPlan[], deals: DealForCompanyCamPlan[]) {
  // How many deals share each normalized name — an exact (similarity 1) name match is reliable ONLY when
  // that name maps to exactly one deal; a name shared by 2+ deals is an ambiguous collision (manual review).
  const dealsByNormalizedName = new Map<string, number>();
  for (const deal of deals) {
    const normalized = normalizeCompanyCamProjectName(deal.name);
    if (normalized) dealsByNormalizedName.set(normalized, (dealsByNormalizedName.get(normalized) ?? 0) + 1);
  }
  const rows: CompanyCamImportPlanRow[] = projects.map((project) => {
    const projectName = project.name ?? "";
    const embeddedProjectNumber = projectName.match(PROJECT_NUMBER_REGEX)?.[0]?.toLowerCase() ?? null;
    const linked = deals.find((deal) => deal.companycamProjectId === project.id);
    const projectNumberMatch = embeddedProjectNumber
      ? deals.find((deal) => deal.projectNumber?.toLowerCase() === embeddedProjectNumber)
      : null;
    const normalizedProject = normalizeCompanyCamProjectName(projectName);
    // A null/blank or strippable-only ("Project"/"Photos") name normalizes to "" — never fuzzy-match it
    // (otherwise it would tie at confidence 1 with any deal whose name also normalizes to "").
    const fuzzy = normalizedProject
      ? deals
          .map((deal) => ({ deal, score: similarity(normalizedProject, normalizeCompanyCamProjectName(deal.name)) }))
          .sort((a, b) => b.score - a.score)[0]
      : null;
    // Exact normalized-name match (similarity 1) is reliable ONLY if exactly one deal carries that name;
    // if 2+ deals share it the best match is ambiguous and stays fuzzy (manual review).
    const exactUnique = !!fuzzy && fuzzy.score === 1 && (dealsByNormalizedName.get(normalizedProject) ?? 0) === 1;
    const match =
      linked ? { deal: linked, confidence: 1, reason: "existing_companycam_link" }
        : projectNumberMatch ? { deal: projectNumberMatch, confidence: 1, reason: "project_number_in_name" }
          : exactUnique ? { deal: fuzzy!.deal, confidence: 1, reason: "exact_unique_name" }
            : fuzzy && fuzzy.score >= AUTO_IMPORT_FUZZY_THRESHOLD ? { deal: fuzzy.deal, confidence: Number(fuzzy.score.toFixed(3)), reason: "fuzzy_project_name" }
              : null;
    return {
      companyCamProjectId: project.id,
      companyCamProjectName: projectName,
      photoCount: project.photoCount,
      matchedDealId: match?.deal.id ?? null,
      matchedDealName: match?.deal.name ?? null,
      matchedDealNumber: match?.deal.dealNumber ?? null,
      confidence: match?.confidence ?? 0,
      matchReason: match?.reason ?? "unmatched",
      matchedDealOnHold: match?.deal.onHold ?? null,
    };
  });
  return { rows, totals: summarizeCompanyCamPlan(rows) };
}

function quoteIdent(value: string): string {
  if (!/^office_[a-z0-9_]+$/.test(value)) throw new Error(`Invalid tenant schema: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function getConnectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (selected.includes("railway.internal") && !process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_PROJECT_ID) {
    throw new Error("Use DATABASE_PUBLIC_URL or railway run.");
  }
  return selected;
}

export async function loadDeals(client: pg.Client, tenant: string): Promise<DealForCompanyCamPlan[]> {
  const schema = quoteIdent(tenant);
  const { rows } = await client.query(`
    SELECT id::text, name, deal_number, project_number, companycam_project_id,
           COALESCE(on_hold, false) AS on_hold
    FROM ${schema}.deals
    WHERE is_active = true
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    dealNumber: row.deal_number,
    projectNumber: row.project_number,
    companycamProjectId: row.companycam_project_id,
    onHold: row.on_hold,
  }));
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

export function writeCompanyCamPlanCsv(rows: CompanyCamImportPlanRow[], outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const csvRows = [
    ["companycam_project_id", "project_name", "photo_count", "matched_deal_id", "matched_deal_number", "matched_deal_name", "confidence", "match_reason", "matched_deal_on_hold", "disposition"],
    ...rows.map((row) => [
      row.companyCamProjectId,
      row.companyCamProjectName,
      String(row.photoCount),
      row.matchedDealId ?? "unmatched",
      row.matchedDealNumber ?? "",
      row.matchedDealName ?? "",
      String(row.confidence),
      row.matchReason,
      row.matchedDealOnHold == null ? "" : String(row.matchedDealOnHold),
      companyCamPlanDisposition(row),
    ]),
  ];
  fs.writeFileSync(outputPath, csvRows.map((row) => row.map(csvEscape).join(",")).join("\n"));
}

export async function runCompanyCamInventory(argv = process.argv.slice(2)) {
  const tenant = argv.find((arg) => arg.startsWith("--tenant="))?.split("=").slice(1).join("=") || DEFAULT_TENANT;
  const output = argv.find((arg) => arg.startsWith("--output="))?.split("=").slice(1).join("=");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = output || `docs/audit/companycam-import-plan-${timestamp}.csv`;
  const client = new pg.Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    const [projects, deals] = await Promise.all([getAllProjects(), loadDeals(client, tenant)]);
    const plan = buildCompanyCamImportPlan(
      projects.map((project) => ({ id: project.id, name: project.name, photoCount: project.photo_count ?? 0 })),
      deals
    );
    writeCompanyCamPlanCsv(plan.rows, outputPath);
    console.log(JSON.stringify({ tenant, outputPath, ...plan.totals }, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runCompanyCamInventory().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
