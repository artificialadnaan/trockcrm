import "dotenv/config";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import pg from "pg";

const DEFAULT_TENANT = "office_dallas";

type ObjectType = "contacts" | "companies" | "deals";

export interface HubSpotCsvRecord {
  id: string;
  name: string;
  stage?: string | null;
  amount?: string | null;
  owner?: string | null;
  closeDate?: string | null;
}

export interface CrmRecord {
  id: string;
  hubspotId: string | null;
  name: string;
  stage?: string | null;
  amount?: string | null;
  owner?: string | null;
  closeDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

export interface HubSpotReconciliationInput {
  hubspot: Record<ObjectType, HubSpotCsvRecord[]>;
  crm: Record<ObjectType, CrmRecord[]>;
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

export function parseCsvText(text: string): Record<string, string>[] {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let inQuotes = false;
  for (let i = 0; i < source.length; i++) {
    const char = source[i];
    const next = source[i + 1];
    if (char === '"' && inQuotes && next === '"') {
      cell += '"';
      i++;
    } else if (char === '"') {
      inQuotes = !inQuotes;
    } else if (char === "," && !inQuotes) {
      row.push(cell);
      cell = "";
    } else if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && next === "\n") i++;
      row.push(cell);
      if (row.some((value) => value.trim() !== "")) rows.push(row);
      row = [];
      cell = "";
    } else {
      cell += char;
    }
  }
  row.push(cell);
  if (row.some((value) => value.trim() !== "")) rows.push(row);
  const [headers = [], ...data] = rows;
  return data.map((values) =>
    Object.fromEntries(headers.map((header, index) => [header.replace(/^\uFEFF/, "").trim(), values[index]?.trim() ?? ""]))
  );
}

function first(row: Record<string, string>, names: string[]) {
  for (const name of names) {
    const value = row[name];
    if (value != null && value.trim() !== "") return value.trim();
  }
  return "";
}

function normalizeHubSpotRows(type: ObjectType, rows: Record<string, string>[]): HubSpotCsvRecord[] {
  return rows
    .map((row) => {
      const id = first(row, ["Record ID", "ID", "Contact ID", "Company ID", "Deal ID", "hs_object_id"]);
      if (!id) return null;
      if (type === "contacts") {
        const name = [first(row, ["First Name", "First name", "firstname"]), first(row, ["Last Name", "Last name", "lastname"])]
          .filter(Boolean)
          .join(" ") || first(row, ["Name", "Email"]);
        return { id, name };
      }
      if (type === "companies") {
        return { id, name: first(row, ["Company name", "Company Name", "Name", "name"]) };
      }
      return {
        id,
        name: first(row, ["Deal Name", "Deal name", "Name", "dealname"]),
        stage: first(row, ["Deal Stage", "Deal stage", "Stage", "dealstage"]) || null,
        amount: first(row, ["Amount", "amount"]) || null,
        owner: first(row, ["HubSpot Owner ID", "hubspot_owner_id", "Owner"]) || null,
        closeDate: first(row, ["Close Date", "Close date", "closedate"]) || null,
      };
    })
    .filter((row): row is HubSpotCsvRecord => Boolean(row));
}

interface ReconcileWarning {
  type: "invalid_date";
  objectType: ObjectType;
  hubspotId: string;
  name: string;
  field: "closeDate";
  source: "hubspot" | "crm";
  value: string;
}

interface DuplicateCrmRow {
  id: string;
  name: string;
  stage?: string | null;
  amount?: string | null;
  owner?: string | null;
  closeDate?: string | null;
  createdAt?: string | null;
  updatedAt?: string | null;
}

interface DuplicateCrmGroup {
  hubspotId: string;
  canonicalCrmId: string;
  rows: DuplicateCrmRow[];
}

function isValidUtcDate(year: number, month: number, day: number) {
  const date = new Date(Date.UTC(year, month - 1, day));
  return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

function formatIsoDate(year: number, month: number, day: number) {
  return `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

function normalizeDateValue(value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (text === "") return { value: null, invalid: false };
  const iso = text.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/);
  if (iso) {
    const year = Number(iso[1]);
    const month = Number(iso[2]);
    const day = Number(iso[3]);
    return isValidUtcDate(year, month, day)
      ? { value: formatIsoDate(year, month, day), invalid: false }
      : { value: text, invalid: true };
  }
  const slash = text.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slash) {
    // HubSpot's US export format is MM/DD/YYYY; parse it manually to avoid timezone-dependent Date.parse shifts.
    const month = Number(slash[1]);
    const day = Number(slash[2]);
    const year = Number(slash[3]);
    return isValidUtcDate(year, month, day)
      ? { value: formatIsoDate(year, month, day), invalid: false }
      : { value: text, invalid: true };
  }
  return { value: text, invalid: true };
}

function normalizeComparable(field: "stage" | "amount" | "owner" | "closeDate", value: string | null | undefined) {
  const text = String(value ?? "").trim();
  if (text === "") return null;
  if (field === "amount") {
    const numeric = Number(text.replace(/[$,]/g, ""));
    return Number.isFinite(numeric) ? numeric.toFixed(2) : text;
  }
  if (field === "closeDate") {
    return normalizeDateValue(text).value;
  }
  return text.toLowerCase().replace(/\s+/g, " ");
}

function canonicalCrmRow(rows: CrmRecord[]) {
  return [...rows].sort((left, right) => {
    const leftCreated = left.createdAt ? Date.parse(left.createdAt) : Number.NaN;
    const rightCreated = right.createdAt ? Date.parse(right.createdAt) : Number.NaN;
    if (Number.isFinite(leftCreated) && Number.isFinite(rightCreated) && leftCreated !== rightCreated) {
      return leftCreated - rightCreated;
    }
    if (Number.isFinite(leftCreated) !== Number.isFinite(rightCreated)) {
      return Number.isFinite(leftCreated) ? -1 : 1;
    }
    return left.id.localeCompare(right.id);
  })[0];
}

function groupCrmRows(rows: CrmRecord[]) {
  const groups = new Map<string, CrmRecord[]>();
  for (const row of rows) {
    if (!row.hubspotId) continue;
    groups.set(row.hubspotId, [...(groups.get(row.hubspotId) ?? []), row]);
  }
  const canonicalRows = new Map<string, CrmRecord>();
  const duplicates: DuplicateCrmGroup[] = [];
  for (const [hubspotId, groupedRows] of groups) {
    const canonical = canonicalCrmRow(groupedRows);
    if (!canonical) continue;
    canonicalRows.set(hubspotId, canonical);
    if (groupedRows.length > 1) {
      duplicates.push({
        hubspotId,
        canonicalCrmId: canonical.id,
        rows: groupedRows.map((row) => ({
          id: row.id,
          name: row.name,
          stage: row.stage,
          amount: row.amount,
          owner: row.owner,
          closeDate: row.closeDate,
          createdAt: row.createdAt,
          updatedAt: row.updatedAt,
        })),
      });
    }
  }
  return { canonicalRows, duplicates };
}

export function buildHubSpotReconciliationReport(input: HubSpotReconciliationInput) {
  const missing: Record<ObjectType, Array<{ hubspotId: string; name: string }>> = {
    contacts: [],
    companies: [],
    deals: [],
  };
  const mismatches: { deals: Array<{ hubspotId: string; name: string; field: string; hubspotValue: string | null; crmValue: string | null }> } = {
    deals: [],
  };
  const crmOnly: Record<ObjectType, Array<{ id: string; name: string }>> = {
    contacts: [],
    companies: [],
    deals: [],
  };
  const duplicateCrm: Record<ObjectType, DuplicateCrmGroup[]> = {
    contacts: [],
    companies: [],
    deals: [],
  };
  const warnings: ReconcileWarning[] = [];

  for (const type of ["contacts", "companies", "deals"] as const) {
    const grouped = groupCrmRows(input.crm[type]);
    duplicateCrm[type] = grouped.duplicates;
    const crmByHubSpot = grouped.canonicalRows;
    const seenHubSpotIds = new Set<string>();
    for (const hubspotRow of input.hubspot[type]) {
      seenHubSpotIds.add(hubspotRow.id);
      const crmRow = crmByHubSpot.get(hubspotRow.id);
      if (!crmRow) {
        missing[type].push({ hubspotId: hubspotRow.id, name: hubspotRow.name });
        continue;
      }
      if (type === "deals") {
        for (const field of ["stage", "amount", "owner", "closeDate"] as const) {
          const hubspotValue = normalizeComparable(field, hubspotRow[field]);
          const crmValue = normalizeComparable(field, crmRow[field]);
          if (field === "closeDate") {
            const hubspotDate = normalizeDateValue(hubspotRow[field]);
            const crmDate = normalizeDateValue(crmRow[field]);
            if (hubspotDate.invalid) {
              warnings.push({ type: "invalid_date", objectType: "deals", hubspotId: hubspotRow.id, name: hubspotRow.name, field, source: "hubspot", value: String(hubspotRow[field] ?? "") });
            }
            if (crmDate.invalid) {
              warnings.push({ type: "invalid_date", objectType: "deals", hubspotId: hubspotRow.id, name: hubspotRow.name, field, source: "crm", value: String(crmRow[field] ?? "") });
            }
          }
          if (hubspotValue !== crmValue) {
            mismatches.deals.push({ hubspotId: hubspotRow.id, name: hubspotRow.name, field, hubspotValue, crmValue });
          }
        }
      }
    }
    crmOnly[type] = input.crm[type]
      .filter((row) => !row.hubspotId || !seenHubSpotIds.has(row.hubspotId))
      .map((row) => ({ id: row.id, name: row.name }));
  }

  return {
    totals: {
      hubspot: {
        contacts: input.hubspot.contacts.length,
        companies: input.hubspot.companies.length,
        deals: input.hubspot.deals.length,
      },
      crm: {
        contacts: input.crm.contacts.length,
        companies: input.crm.companies.length,
        deals: input.crm.deals.length,
      },
    },
    missing,
    mismatches,
    crmOnly,
    duplicateCrm,
    warnings,
  };
}

async function loadCrm(client: pg.Client, tenant: string): Promise<Record<ObjectType, CrmRecord[]>> {
  const schema = quoteIdent(tenant);
  const contacts = await client.query(`SELECT id::text, hubspot_contact_id AS hubspot_id, trim(first_name || ' ' || last_name) AS name, created_at::text, updated_at::text FROM ${schema}.contacts WHERE is_active = true`);
  const companies = await client.query(`SELECT id::text, COALESCE(hubspot_company_id, hubspot_id) AS hubspot_id, name, created_at::text, updated_at::text FROM ${schema}.companies WHERE is_active = true`);
  const deals = await client.query(`
      SELECT d.id::text,
             d.hubspot_deal_id AS hubspot_id,
             d.name,
             psc.name AS stage,
             COALESCE(d.awarded_amount::text, d.bid_estimate::text, d.dd_estimate::text) AS amount,
             COALESCE(d.hubspot_owner_id, d.assigned_rep_id::text) AS owner,
             d.expected_close_date::text AS close_date,
             d.created_at::text,
             d.updated_at::text
      FROM ${schema}.deals d
      LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
      WHERE d.is_active = true
    `);
  return {
    contacts: contacts.rows.map((row) => ({ id: row.id, hubspotId: row.hubspot_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at })),
    companies: companies.rows.map((row) => ({ id: row.id, hubspotId: row.hubspot_id, name: row.name, createdAt: row.created_at, updatedAt: row.updated_at })),
    deals: deals.rows.map((row) => ({
      id: row.id,
      hubspotId: row.hubspot_id,
      name: row.name,
      stage: row.stage,
      amount: row.amount,
      owner: row.owner,
      closeDate: row.close_date,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    })),
  };
}

function sectionList(title: string, rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return `### ${title}\n\nNone.\n`;
  return `### ${title}\n\n${rows.map((row) => `- ${Object.entries(row).map(([key, value]) => `${key}: ${typeof value === "object" && value !== null ? JSON.stringify(value) : value ?? ""}`).join("; ")}`).join("\n")}\n`;
}

function writeMarkdown(report: ReturnType<typeof buildHubSpotReconciliationReport>, outputPath: string) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const markdown = [
    "# HubSpot Reconciliation Report",
    "",
    `Generated: ${new Date().toISOString()}`,
    "",
    "## Totals",
    "",
    `- HubSpot contacts: ${report.totals.hubspot.contacts}`,
    `- CRM contacts: ${report.totals.crm.contacts}`,
    `- HubSpot companies: ${report.totals.hubspot.companies}`,
    `- CRM companies: ${report.totals.crm.companies}`,
    `- HubSpot deals: ${report.totals.hubspot.deals}`,
    `- CRM deals: ${report.totals.crm.deals}`,
    "",
    sectionList("Missing Contacts In CRM", report.missing.contacts),
    sectionList("Missing Companies In CRM", report.missing.companies),
    sectionList("Missing Deals In CRM", report.missing.deals),
    "## Duplicate CRM HubSpot IDs",
    "",
    "Canonical row selection uses the earliest created_at value, with CRM ID as the deterministic fallback.",
    "",
    sectionList("Duplicate CRM Contacts", report.duplicateCrm.contacts),
    sectionList("Duplicate CRM Companies", report.duplicateCrm.companies),
    sectionList("Duplicate CRM Deals", report.duplicateCrm.deals),
    sectionList("Deal Field Mismatches", report.mismatches.deals),
    sectionList("Warnings", report.warnings),
    sectionList("CRM Native Contacts", report.crmOnly.contacts),
    sectionList("CRM Native Companies", report.crmOnly.companies),
    sectionList("CRM Native Deals", report.crmOnly.deals),
  ].join("\n");
  fs.writeFileSync(outputPath, markdown);
}

function readRequiredPath(argv: string[], name: string) {
  const index = argv.indexOf(name);
  if (index === -1 || !argv[index + 1]) throw new Error(`${name} <path> is required`);
  return argv[index + 1];
}

export async function runHubSpotCsvReconciliation(argv = process.argv.slice(2)) {
  const tenant = argv.find((arg) => arg.startsWith("--tenant="))?.split("=").slice(1).join("=") || DEFAULT_TENANT;
  const contactsPath = readRequiredPath(argv, "--contacts");
  const companiesPath = readRequiredPath(argv, "--companies");
  const dealsPath = readRequiredPath(argv, "--deals");
  const output = argv.find((arg) => arg.startsWith("--output="))?.split("=").slice(1).join("=");
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
  const outputPath = output || `docs/audit/hubspot-reconciliation-${timestamp}.md`;
  const hubspot = {
    contacts: normalizeHubSpotRows("contacts", parseCsvText(fs.readFileSync(contactsPath, "utf8"))),
    companies: normalizeHubSpotRows("companies", parseCsvText(fs.readFileSync(companiesPath, "utf8"))),
    deals: normalizeHubSpotRows("deals", parseCsvText(fs.readFileSync(dealsPath, "utf8"))),
  };
  const client = new pg.Client({ connectionString: getConnectionString() });
  await client.connect();
  try {
    const crm = await loadCrm(client, tenant);
    const report = buildHubSpotReconciliationReport({ hubspot, crm });
    writeMarkdown(report, outputPath);
    console.log(JSON.stringify({ tenant, outputPath, totals: report.totals }, null, 2));
  } finally {
    await client.end();
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || "").href) {
  runHubSpotCsvReconciliation().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
