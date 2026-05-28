import { sql } from "drizzle-orm";
import {
  PROJECT_TYPE_CODE_BY_VALUE,
  isProjectTypeValue,
  normalizeProjectType,
} from "@trock-crm/shared/types";
import { isStrictCanonicalProjectNumber } from "../modules/deals/project-number-validation.js";

type WorkflowRoute = "normal" | "service";
export type ProjectNumberOfficeCode = "DFW" | "ATL" | "dfw" | "atl";

export interface ProjectNumberDealInput {
  id: string;
  workflowRoute?: WorkflowRoute | null;
  officeCode?: string | null;
  projectType?: string | null;
  createdAt?: Date | string | null;
}

export interface ProjectNumberBuildInput {
  officeCode: ProjectNumberOfficeCode;
  projectTypeCode: string;
  createdAt: Date;
  suffix: string;
}

export function generateJulianDate(createDate: Date): string {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Chicago",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(createDate);
  const year = Number(parts.find((part) => part.type === "year")?.value);
  const month = Number(parts.find((part) => part.type === "month")?.value);
  const day = Number(parts.find((part) => part.type === "day")?.value);
  const dayOfYear =
    Math.floor((Date.UTC(year, month - 1, day) - Date.UTC(year, 0, 1)) / 86_400_000) + 1;

  return `${String(dayOfYear).padStart(3, "0")}${String(year).slice(-2)}`;
}

export function resolveOfficeCode(location: string | null | undefined): "dfw" | "atl" {
  const normalized = String(location ?? "").trim().toUpperCase();
  if (normalized === "ATL" || normalized.includes("ATLANTA")) return "atl";
  return "dfw";
}

function formatProjectNumberOfficePrefix(officeCode: ProjectNumberOfficeCode | string): string {
  return officeCode.trim().toUpperCase();
}

export function resolveProjectTypeCode(input: {
  projectTypes?: string | null;
  projectType?: string | null;
  workflowRoute?: WorkflowRoute | null;
}): string {
  const projectType = String(input.projectType ?? "").trim();
  if (projectType) {
    const normalized = normalizeProjectType(projectType);
    if (isProjectTypeValue(normalized)) return PROJECT_TYPE_CODE_BY_VALUE[normalized];
  }

  const explicit = String(input.projectTypes ?? "").trim();
  if (/^[1-9]$/.test(explicit)) return explicit;
  if (input.workflowRoute === "service") return "4";
  return "9";
}

export function buildIntendedProjectNumber(
  currentProjectNumber: string | null | undefined,
  projectType: string
): string | null {
  const normalized = normalizeProjectType(projectType);
  if (!isProjectTypeValue(normalized)) return null;

  const match = String(currentProjectNumber ?? "").match(/^([A-Z]{2,4})-[1-9]-(\d{5})-([a-z]+)$/i);
  if (!match) return null;

  const [, officeCode, julianDate, suffix] = match;
  return `${formatProjectNumberOfficePrefix(officeCode)}-${PROJECT_TYPE_CODE_BY_VALUE[normalized]}-${julianDate}-${suffix.toLowerCase()}`;
}

export function getNextSuffix(existingSuffix: string | null | undefined): string {
  if (!existingSuffix) return "aa";
  const chars = existingSuffix.toLowerCase().split("");
  let index = chars.length - 1;
  while (index >= 0) {
    if (chars[index] < "z") {
      chars[index] = String.fromCharCode(chars[index].charCodeAt(0) + 1);
      return chars.join("");
    }
    chars[index] = "a";
    index -= 1;
  }
  return `a${chars.join("")}`;
}

export function buildProjectNumber(input: ProjectNumberBuildInput): string {
  const result = `${formatProjectNumberOfficePrefix(input.officeCode)}-${input.projectTypeCode}-${generateJulianDate(input.createdAt)}-${input.suffix.toLowerCase()}`;
  // Defensive: newly-generated project numbers must satisfy the strict canonical
  // form. If the inputs ever drift (e.g., a malformed projectTypeCode), surface it
  // here instead of leaking a non-canonical value into the DB.
  if (!isStrictCanonicalProjectNumber(result)) {
    throw new Error(`buildProjectNumber produced non-canonical project number: ${result}`);
  }
  return result;
}

export function parseProjectNumberSuffix(projectNumber: string | null | undefined, julianDate: string): string | null {
  const match = String(projectNumber ?? "").match(new RegExp(`^[a-z]{3}-[1-9]-${julianDate}-([a-z]+)$`, "i"));
  return match?.[1]?.toLowerCase() ?? null;
}

function newestSuffix(projectNumbers: Array<string | null | undefined>, julianDate: string): string | null {
  return projectNumbers
    .map((value) => parseProjectNumberSuffix(value, julianDate))
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

async function findHighestSuffixForDate(
  tenantDb: {
    execute: (query: any) => Promise<{ rows?: Array<{ deal_number?: string | null }> } | Array<{ deal_number?: string | null }>>;
  },
  julianDate: string
): Promise<string | null> {
  const pattern = `%-%-${julianDate}-%`;
  const result = await tenantDb.execute(sql`
    SELECT deal_number
      FROM deals
     WHERE deal_number LIKE ${pattern}
     ORDER BY deal_number DESC
  `);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  return newestSuffix(rows.map((row) => row.deal_number), julianDate);
}

async function reserveDailySuffix(
  tenantDb: {
    execute: (query: any) => Promise<{ rows?: Array<{ last_suffix?: string | null }> } | Array<{ last_suffix?: string | null }>>;
  },
  julianDate: string,
  fallbackHighestSuffix: string | null
): Promise<string> {
  await tenantDb.execute(sql`
    INSERT INTO public.deal_number_daily_sequences (day_key, last_suffix)
    VALUES (${julianDate}, ${fallbackHighestSuffix ?? ""})
    ON CONFLICT (day_key) DO NOTHING
  `);
  const locked = await tenantDb.execute(sql`
    SELECT last_suffix
      FROM public.deal_number_daily_sequences
     WHERE day_key = ${julianDate}
     FOR UPDATE
  `);
  const rows = Array.isArray(locked) ? locked : locked.rows ?? [];
  const nextSuffix = getNextSuffix(rows[0]?.last_suffix || fallbackHighestSuffix);
  await tenantDb.execute(sql`
    UPDATE public.deal_number_daily_sequences
       SET last_suffix = ${nextSuffix},
           updated_at = NOW()
     WHERE day_key = ${julianDate}
  `);
  return nextSuffix;
}

export async function generateDealNumberForProject(
  tenantDb: {
    execute: (query: any) => Promise<{ rows?: Array<{ deal_number?: string | null; last_suffix?: string | null }> } | Array<{ deal_number?: string | null; last_suffix?: string | null }>>;
  },
  deal: ProjectNumberDealInput,
  now = new Date()
): Promise<string> {
  const createdAt = deal.createdAt ? new Date(deal.createdAt) : now;
  const julianDate = generateJulianDate(createdAt);
  const suffix = await reserveDailySuffix(
    tenantDb,
    julianDate,
    await findHighestSuffixForDate(tenantDb, julianDate)
  );
  const officeCode = resolveOfficeCode(deal.officeCode);
  const projectTypeCode = resolveProjectTypeCode({
    projectType: deal.projectType,
    workflowRoute: deal.workflowRoute ?? "normal",
  });

  return buildProjectNumber({ officeCode, projectTypeCode, createdAt, suffix });
}
