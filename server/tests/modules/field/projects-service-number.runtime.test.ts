import { beforeEach, describe, expect, it, vi } from "vitest";

// The field projects list must DISPLAY the canonical DFW/ATL project number, never the meaningless
// HubSpot id that deals.deal_number holds for HubSpot-imported deals. The server resolves the display
// number into `projectNumber` (raw deal_number stays under `dealNumber` for internal keys) using the
// shared resolver. These tests pin that contract + the SQL wiring (project_number selected + searchable).

const fileServiceMocks = vi.hoisted(() => ({
  buildFileDownloadUrlFromRecord: vi.fn(),
  getDealPhotoTimeline: vi.fn(),
  getFileDownloadUrl: vi.fn(),
  searchPhotoUploadTargets: vi.fn(),
}));
const dealServiceMocks = vi.hoisted(() => ({ getDealById: vi.fn() }));

vi.mock("../../../src/modules/files/service.js", () => fileServiceMocks);
vi.mock("../../../src/modules/deals/service.js", () => dealServiceMocks);

const { listFieldProjects, listStarredFieldProjects } = await import(
  "../../../src/modules/field/projects-service.js"
);

function tenantDb(rows: unknown[][]) {
  return { execute: vi.fn(async () => ({ rows: rows.shift() ?? [] })) } as any;
}

function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  return "";
}

const access = { userId: "field-1", userRole: "field_contractor" as const };

function listRow(overrides: Record<string, unknown>) {
  return {
    id: "deal-1",
    name: "Project",
    deal_number: "HS-318900588242",
    project_number: null,
    property_name: "Project",
    property_address: null,
    stage_name: "Estimating",
    last_activity_at: new Date("2026-05-05T12:00:00.000Z"),
    photo_count: 0,
    starred: false,
    ...overrides,
  };
}

async function resolveOne(row: Record<string, unknown>) {
  const db = tenantDb([[{ total: 1 }], [listRow(row)]]);
  const result = await listFieldProjects(db, access);
  return result.projects[0];
}

describe("field projects — canonical project-number resolution", () => {
  beforeEach(() => vi.clearAllMocks());

  it("HubSpot-imported deal: displays project_number, never the HS- deal_number", async () => {
    const project = await resolveOne({ deal_number: "HS-318900588242", project_number: "DFW-1-09026-af" });
    expect(project.projectNumber).toBe("DFW-1-09026-af");
    // Raw deal_number is preserved for internal keys (e.g. the photo-report storage path) but is the HS id.
    expect(project.dealNumber).toBe("HS-318900588242");
  });

  it("bid-board-owned deal: project_number empty → falls back to the canonical deal_number", async () => {
    const project = await resolveOne({ deal_number: "DFW-3-16726-aa", project_number: null });
    expect(project.projectNumber).toBe("DFW-3-16726-aa");
    expect(project.dealNumber).toBe("DFW-3-16726-aa");
  });

  it("null-edge deal: HS- deal_number and no canonical project_number → projectNumber is null (pending), HS id never leaks", async () => {
    const project = await resolveOne({ deal_number: "HS-204627995347", project_number: null });
    expect(project.projectNumber).toBeNull();
    expect(project.dealNumber).toBe("HS-204627995347");
  });

  it("conflict (both columns canonical): project_number wins — matches the CRM resolver", async () => {
    const project = await resolveOne({ deal_number: "DFW-9-13226-aw", project_number: "DFW-1-13226-aa" });
    expect(project.projectNumber).toBe("DFW-1-13226-aa");
  });

  it("blank/whitespace project_number with an HS- deal_number still resolves to pending (null)", async () => {
    const project = await resolveOne({ deal_number: "HS-9999", project_number: "   " });
    expect(project.projectNumber).toBeNull();
  });

  it("the starred list resolves projectNumber the same way", async () => {
    const db = tenantDb([[listRow({ deal_number: "HS-318900588242", project_number: "ATL-4-16326-ab", starred: true })]]);
    const result = await listStarredFieldProjects(db, access);
    expect(result.projects[0].projectNumber).toBe("ATL-4-16326-ab");
    expect(result.projects[0].dealNumber).toBe("HS-318900588242");
  });
});

describe("field projects — is_change_order is selected and surfaced", () => {
  beforeEach(() => vi.clearAllMocks());

  // The field clients move "Change Order N" to the FRONT of a change-order child's name (it is STORED as
  // "<Parent> — Change Order N", which truncates to look like its parent on a phone). `deals.is_change_order`
  // is the AUTHORITY for that decision — without it the clients had to infer it from the name's shape,
  // which mislabels a deal a human happened to name "Lobby — Change Order 1".
  it("surfaces the flag as a real boolean, for both true and false rows", async () => {
    expect((await resolveOne({ is_change_order: true })).isChangeOrder).toBe(true);
    expect((await resolveOne({ is_change_order: false })).isChangeOrder).toBe(false);
  });

  it("defaults to false rather than undefined when the column is missing/null", async () => {
    // Never `undefined`: on the client that would silently fall back to guessing from the name.
    expect((await resolveOne({ is_change_order: null })).isChangeOrder).toBe(false);
    expect((await resolveOne({})).isChangeOrder).toBe(false);
  });

  it("selects d.is_change_order in the list query", async () => {
    const db = tenantDb([[{ total: 0 }], []]);
    await listFieldProjects(db, access);
    const sqlText = db.execute.mock.calls.map(([arg]: [unknown]) => extractSqlText(arg)).join("\n");
    expect(sqlText).toContain("d.is_change_order");
  });

  it("selects d.is_change_order in the starred query too", async () => {
    const db = tenantDb([[]]);
    await listStarredFieldProjects(db, access);
    const sqlText = db.execute.mock.calls.map(([arg]: [unknown]) => extractSqlText(arg)).join("\n");
    expect(sqlText).toContain("d.is_change_order");
  });
});

describe("field projects — project_number is selected and searchable", () => {
  beforeEach(() => vi.clearAllMocks());

  it("selects d.project_number in the list query", async () => {
    const db = tenantDb([[{ total: 0 }], []]);
    await listFieldProjects(db, access);
    const allSql = db.execute.mock.calls.map((c: any[]) => extractSqlText(c[0])).join(" | ");
    expect(allSql).toContain("project_number");
  });

  it("searches project_number too (so the DFW number finds HubSpot-imported deals)", async () => {
    const db = tenantDb([[{ total: 0 }], []]);
    await listFieldProjects(db, access, { search: "DFW-1-09026" });
    const allSql = db.execute.mock.calls.map((c: any[]) => extractSqlText(c[0])).join(" | ");
    expect(allSql).toContain("project_number ILIKE");
  });
});
