import { sql } from "drizzle-orm";
import {
  PROJECT_TYPE_CODE_BY_VALUE,
  isProjectTypeValue,
  normalizeProjectType,
} from "@trock-crm/shared/types";

type WorkflowRoute = "normal" | "service";

export interface ProjectNumberDealInput {
  id: string;
  workflowRoute?: WorkflowRoute | null;
  projectType?: string | null;
  bidBoardProjectNumber?: string | null;
  bidBoardOffice?: string | null;
  regionClassification?: string | null;
  propertyState?: string | null;
  createdAt?: Date | string | null;
}

export interface ProjectNumberBuildInput {
  officeCode: "DFW" | "ATL";
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

export function resolveOfficeCode(location: string | null | undefined): "DFW" | "ATL" {
  const normalized = String(location ?? "").trim().toUpperCase();
  if (normalized.includes("ATL") || normalized.includes("ATLANTA")) return "ATL";
  return "DFW";
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
  return `${officeCode.toUpperCase()}-${PROJECT_TYPE_CODE_BY_VALUE[normalized]}-${julianDate}-${suffix.toLowerCase()}`;
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
  return `${input.officeCode}-${input.projectTypeCode}-${generateJulianDate(input.createdAt)}-${input.suffix}`;
}

export function shouldAssignProjectNumberForStageChange(input: {
  currentStageSlug: string;
  targetStageSlug: string;
  existingProjectNumber?: string | null;
}): boolean {
  return (
    input.targetStageSlug === "opportunity" &&
    input.currentStageSlug !== "opportunity" &&
    !input.existingProjectNumber
  );
}

function parseSuffix(projectNumber: string | null | undefined, julianDate: string): string | null {
  const match = String(projectNumber ?? "").match(new RegExp(`^[A-Z]{2,4}-[1-9]-${julianDate}-([a-z]+)$`, "i"));
  return match?.[1]?.toLowerCase() ?? null;
}

function newestSuffix(projectNumbers: Array<string | null | undefined>, julianDate: string): string | null {
  return projectNumbers
    .map((value) => parseSuffix(value, julianDate))
    .filter((value): value is string => Boolean(value))
    .sort((left, right) => right.localeCompare(left))[0] ?? null;
}

async function findHighestSuffixForDate(
  tenantDb: { execute: (query: any) => Promise<{ rows?: Array<{ bid_board_project_number?: string | null }> } | Array<{ bid_board_project_number?: string | null }>> },
  julianDate: string
): Promise<string | null> {
  const pattern = `%-%-${julianDate}-%`;
  const result = await tenantDb.execute(sql`
    SELECT bid_board_project_number
      FROM deals
     WHERE bid_board_project_number LIKE ${pattern}
     ORDER BY bid_board_project_number DESC
  `);
  const rows = Array.isArray(result) ? result : result.rows ?? [];
  return newestSuffix(rows.map((row) => row.bid_board_project_number), julianDate);
}

export async function generateProjectNumberForDeal(
  tenantDb: { execute: (query: any) => Promise<{ rows?: Array<{ bid_board_project_number?: string | null }> } | Array<{ bid_board_project_number?: string | null }>> },
  deal: ProjectNumberDealInput,
  now = new Date()
): Promise<string> {
  const createdAt = deal.createdAt ? new Date(deal.createdAt) : now;
  const julianDate = generateJulianDate(createdAt);
  const suffix = getNextSuffix(await findHighestSuffixForDate(tenantDb, julianDate));
  const officeCode = resolveOfficeCode(
    deal.bidBoardOffice ?? deal.regionClassification ?? deal.propertyState
  );
  const projectTypeCode = resolveProjectTypeCode({
    projectType: deal.projectType,
    workflowRoute: deal.workflowRoute ?? "normal",
  });

  return buildProjectNumber({ officeCode, projectTypeCode, createdAt, suffix });
}
