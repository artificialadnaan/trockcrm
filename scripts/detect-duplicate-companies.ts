import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DEFAULT_TENANT = "office_dallas";
const COMPANY_SUFFIXES = /\b(inc|llc|ltd|co|corp|corporation|company|lp|pllc)\b/g;

export interface DuplicateCompanyInput {
  id: string;
  name: string;
  domain?: string | null;
  website?: string | null;
  address?: string | null;
  city?: string | null;
  state?: string | null;
  zip?: string | null;
  contactDomains?: string[];
}

export interface DuplicateCompanyCluster {
  companyIds: string[];
  companyNames: string[];
  confidenceScore: number;
  reasons: string[];
}

interface CliOptions {
  tenant: string;
  execute: boolean;
  populateMergeQueue: boolean;
  output?: string;
}

function quoteIdent(value: string): string {
  if (!/^office_[a-z0-9_]+$/.test(value)) throw new Error(`Invalid tenant schema: ${value}`);
  return `"${value.replace(/"/g, '""')}"`;
}

function getConnectionString() {
  const selected = process.env.DATABASE_PUBLIC_URL?.trim() || process.env.DATABASE_URL?.trim();
  if (!selected) throw new Error("DATABASE_PUBLIC_URL or DATABASE_URL is required");
  if (selected.includes("railway.internal") && !process.env.RAILWAY_ENVIRONMENT_ID && !process.env.RAILWAY_PROJECT_ID) {
    throw new Error("DATABASE_URL points at railway.internal. Use DATABASE_PUBLIC_URL or railway run.");
  }
  return selected;
}

export function normalizeCompanyNameForDuplicateDetection(value: string | null | undefined): string {
  return String(value ?? "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .replace(COMPANY_SUFFIXES, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function normalizeDomain(value: string | null | undefined): string | null {
  const text = String(value ?? "").trim().toLowerCase();
  if (!text) return null;
  try {
    const url = text.startsWith("http") ? new URL(text) : new URL(`https://${text}`);
    return url.hostname.replace(/^www\./, "");
  } catch {
    return text.replace(/^https?:\/\//, "").replace(/^www\./, "").split("/")[0] || null;
  }
}

function normalizeZip(value: string | null | undefined): string | null {
  const digits = String(value ?? "").replace(/\D/g, "");
  return digits.length >= 5 ? digits.slice(0, 5) : null;
}

function normalizeAddress(company: DuplicateCompanyInput): string | null {
  const address = String(company.address ?? "")
    .toLowerCase()
    .replace(/\bstreet\b/g, "st")
    .replace(/\bavenue\b/g, "ave")
    .replace(/\broad\b/g, "rd")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
  const zip = normalizeZip(company.zip);
  const state = company.state?.trim().toUpperCase();
  if (!address || !zip || !state) return null;
  return [address, company.city?.trim().toLowerCase(), state, zip].filter(Boolean).join("|");
}

function similarity(a: string, b: string): number {
  if (a === b) return 1;
  if (!a || !b) return 0;
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

function scorePair(left: DuplicateCompanyInput, right: DuplicateCompanyInput) {
  const reasons: string[] = [];
  const leftName = normalizeCompanyNameForDuplicateDetection(left.name);
  const rightName = normalizeCompanyNameForDuplicateDetection(right.name);
  const nameScore = similarity(leftName, rightName);
  const leftDomain = normalizeDomain(left.domain ?? left.website);
  const rightDomain = normalizeDomain(right.domain ?? right.website);
  const leftAddress = normalizeAddress(left);
  const rightAddress = normalizeAddress(right);
  const leftContactDomains = new Set((left.contactDomains ?? []).map(normalizeDomain).filter(Boolean));
  const rightContactDomains = new Set((right.contactDomains ?? []).map(normalizeDomain).filter(Boolean));

  if (leftName && leftName === rightName) reasons.push("exact_normalized_name");
  else if (nameScore >= 0.86) reasons.push("fuzzy_name");
  if (leftDomain && rightDomain && leftDomain === rightDomain) reasons.push("same_company_domain");
  if ([...leftContactDomains].some((domain) => rightContactDomains.has(domain))) reasons.push("same_contact_domain");
  if (leftAddress && leftAddress === rightAddress) reasons.push("same_primary_address");

  let score = 0;
  if (reasons.includes("exact_normalized_name")) score = Math.max(score, 0.82);
  if (reasons.includes("fuzzy_name")) score = Math.max(score, Math.min(0.9, nameScore));
  if (reasons.includes("same_company_domain")) score += 0.12;
  if (reasons.includes("same_contact_domain")) score += 0.08;
  if (reasons.includes("same_primary_address")) score += 0.1;
  score = Math.min(0.99, score);

  return { score: Number(score.toFixed(3)), reasons };
}

export function buildDuplicateCompanyClusters(companies: DuplicateCompanyInput[]): DuplicateCompanyCluster[] {
  const clusters: DuplicateCompanyCluster[] = [];
  const seenPairs = new Set<string>();
  for (let i = 0; i < companies.length; i++) {
    for (let j = i + 1; j < companies.length; j++) {
      const left = companies[i];
      const right = companies[j];
      const { score, reasons } = scorePair(left, right);
      if (score < 0.8) continue;
      const ids = [left.id, right.id].sort();
      const pairKey = ids.join(":");
      if (seenPairs.has(pairKey)) continue;
      seenPairs.add(pairKey);
      clusters.push({
        companyIds: ids,
        companyNames: ids[0] === left.id ? [left.name, right.name] : [right.name, left.name],
        confidenceScore: score,
        reasons,
      });
    }
  }
  return clusters.sort((a, b) => b.confidenceScore - a.confidenceScore);
}

function parseArgs(argv: string[]): CliOptions {
  return {
    tenant: argv.find((arg) => arg.startsWith("--tenant="))?.split("=").slice(1).join("=") || DEFAULT_TENANT,
    execute: argv.includes("--execute"),
    populateMergeQueue: argv.includes("--populate-merge-queue"),
    output: argv.find((arg) => arg.startsWith("--output="))?.split("=").slice(1).join("="),
  };
}

async function loadCompanies(client: pg.Client, tenant: string): Promise<DuplicateCompanyInput[]> {
  const schema = quoteIdent(tenant);
  const { rows } = await client.query(`
    SELECT
      c.id::text,
      c.name,
      c.domain,
      c.website,
      c.address,
      c.city,
      c.state,
      c.zip,
      COALESCE(array_agg(DISTINCT lower(split_part(ct.email, '@', 2))) FILTER (WHERE ct.email LIKE '%@%'), '{}') AS contact_domains
    FROM ${schema}.companies c
    LEFT JOIN ${schema}.contacts ct ON ct.company_id = c.id AND ct.is_active = true
    WHERE c.is_active = true
    GROUP BY c.id
    ORDER BY c.name
  `);
  return rows.map((row) => ({
    id: row.id,
    name: row.name,
    domain: row.domain,
    website: row.website,
    address: row.address,
    city: row.city,
    state: row.state,
    zip: row.zip,
    contactDomains: row.contact_domains ?? [],
  }));
}

function csvEscape(value: unknown) {
  return `"${String(value ?? "").replace(/"/g, '""')}"`;
}

function writeCsv(clusters: DuplicateCompanyCluster[], outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const rows = [
    ["cluster_id", "confidence_score", "company_ids", "company_names", "match_reasons"],
    ...clusters.map((cluster, index) => [
      String(index + 1),
      String(cluster.confidenceScore),
      cluster.companyIds.join("|"),
      cluster.companyNames.join("|"),
      cluster.reasons.join("|"),
    ]),
  ];
  fs.writeFileSync(outputPath, rows.map((row) => row.map(csvEscape).join(",")).join("\n"));
}

async function populateMergeQueue(client: pg.Client, tenant: string, clusters: DuplicateCompanyCluster[]) {
  const schema = quoteIdent(tenant);
  for (const cluster of clusters) {
    const [a, b] = cluster.companyIds;
    await client.query(
      `
        INSERT INTO ${schema}.directory_merge_queue
          (entity_type, entity_a_id, entity_b_id, confidence_score, match_reasons, status)
        VALUES ('company', $1::uuid, $2::uuid, $3, $4::jsonb, 'pending')
        ON CONFLICT (entity_type, entity_a_id, entity_b_id)
        DO UPDATE SET
          confidence_score = EXCLUDED.confidence_score,
          match_reasons = EXCLUDED.match_reasons,
          updated_at = now()
      `,
      [a, b, cluster.confidenceScore, JSON.stringify(cluster.reasons)]
    );
  }
}

export async function runDuplicateCompanyDetection(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = options.output || `docs/audit/duplicate-companies-${timestamp}.csv`;
  const client = new pg.Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    const companies = await loadCompanies(client, options.tenant);
    const clusters = buildDuplicateCompanyClusters(companies);
    writeCsv(clusters, outputPath);
    if (options.populateMergeQueue && options.execute) {
      await populateMergeQueue(client, options.tenant, clusters);
    }
    console.log(JSON.stringify({
      tenant: options.tenant,
      scannedCompanies: companies.length,
      duplicateClusters: clusters.length,
      outputPath,
      mergeQueuePopulated: options.populateMergeQueue && options.execute,
      dryRun: !options.execute,
    }, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runDuplicateCompanyDetection().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
