import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

vi.mock("../src/db.js", () => ({ db: {}, pool: {} }));
vi.mock("../src/modules/pipeline/service.js", () => ({
  getAllStages: vi.fn(async () => []),
  getStageById: vi.fn(async () => null),
  getStageBySlug: vi.fn(async () => null),
  getActiveProjectTypes: vi.fn(async () => []),
}));
vi.mock("@trock-crm/shared/schema", async () => {
  const actual = await vi.importActual<typeof import("@trock-crm/shared/schema")>(
    "@trock-crm/shared/schema"
  );
  return actual;
});

import { getAllStages } from "../src/modules/pipeline/service.js";

const dialect = new PgDialect();

/** Render captured SQL nodes to a single lowercased haystack of sql text + bound params. */
function render(nodes: unknown[]): string {
  return nodes
    .map((node) => {
      try {
        const q = dialect.sqlToQuery(node as never);
        return `${q.sql} ${(q.params as unknown[]).map((p) => String(p)).join(" ")}`;
      } catch {
        return "";
      }
    })
    .join("\n")
    .toLowerCase();
}

function createTenantDbCapturingLeadQueries() {
  const wheres: unknown[] = [];
  const orderBys: unknown[] = [];
  const selectFields: unknown[] = [];
  const builder: any = {
    select: vi.fn((fields?: unknown) => {
      selectFields.push(fields);
      return builder;
    }),
    from: vi.fn(() => builder),
    leftJoin: vi.fn(() => builder),
    innerJoin: vi.fn(() => builder),
    where: vi.fn((condition: unknown) => {
      wheres.push(condition);
      return builder;
    }),
    orderBy: vi.fn((...nodes: unknown[]) => {
      orderBys.push(...nodes);
      return Promise.resolve([]);
    }),
  };
  const tenantDb = { select: builder.select } as unknown as Parameters<typeof listLeads>[0];
  return { tenantDb, wheres, orderBys, selectFields };
}

let listLeads: typeof import("../src/modules/leads/service.js")["listLeads"];
let resolveLeadStageBucketIds: typeof import("../src/modules/leads/service.js")["resolveLeadStageBucketIds"];

beforeAll(async () => {
  ({ listLeads, resolveLeadStageBucketIds } = await import("../src/modules/leads/service.js"));
});

beforeEach(() => {
  vi.mocked(getAllStages).mockResolvedValue([] as never);
});

describe("listLeads — created-date and sort filters (legacy)", () => {
  it("emits created-date, rep, and status filters and sorts newest-first when requested", async () => {
    const { tenantDb, wheres, orderBys } = createTenantDbCapturingLeadQueries();

    await listLeads(
      tenantDb,
      {
        assignedRepId: "rep-1",
        status: "open",
        createdFrom: "2026-05-01",
        createdTo: "2026-05-21",
        sortBy: "created_at",
        sortDir: "desc",
      },
      "director",
      "director-1"
    );

    const sql = render(wheres);
    expect(sql).toContain("assigned_rep_id");
    expect(sql).toContain("status");
    expect(sql).toMatch(/created_at.*>=/s);
    expect(sql).toMatch(/created_at.*interval '1 day'/s);
    expect(render(orderBys)).toContain("created_at");
  });
});

describe("listLeads — FilterBar (Wave 1) predicates", () => {
  it("windows on the outcome-aware date axis (converted/disqualified/open) for dateFrom/dateTo", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, { dateFrom: "2026-05-01", dateTo: "2026-05-31" }, "director", "director-1");

    const sql = render(wheres);
    expect(sql).toContain("converted_at");
    expect(sql).toContain("disqualified_at");
    expect(sql).toContain("stage_entered_at");
    expect(sql).toContain("created_at"); // open-axis fallback
    expect(sql).toContain("coalesce");
    expect(sql).toContain("status");
    expect(sql).toContain("interval '1 day'");
  });

  it("does not add the outcome-aware date window when dateFrom/dateTo are absent", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, { status: "open" }, "director", "director-1");

    const sql = render(wheres);
    expect(sql).not.toContain("converted_at");
    expect(sql).not.toContain("disqualified_at");
  });

  it("filters a valid projectTypeId by equality", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(
      tenantDb,
      { projectTypeId: "11111111-1111-4111-8111-111111111111" },
      "director",
      "director-1"
    );

    const sql = render(wheres);
    expect(sql).toContain("project_type_id");
    expect(sql).toContain("11111111-1111-4111-8111-111111111111");
  });

  it("no-matches a malformed projectTypeId instead of emitting a uuid-cast predicate", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, { projectTypeId: "not-a-uuid" }, "director", "director-1");

    const sql = render(wheres);
    expect(sql).not.toContain("project_type_id");
    expect(sql).not.toContain("not-a-uuid");
    expect(sql).toContain("false");
  });

  it("expands a canonical board-stage id into its alias-stage family", async () => {
    vi.mocked(getAllStages).mockResolvedValue([
      { id: "00000000-0000-4000-8000-000000000001", slug: "new_lead" },
      { id: "00000000-0000-4000-8000-000000000002", slug: "contacted" },
      { id: "00000000-0000-4000-8000-000000000003", slug: "scoping_in_progress" },
      { id: "00000000-0000-4000-8000-000000000009", slug: "qualified_lead" },
    ] as never);
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(
      tenantDb,
      { stageIds: ["00000000-0000-4000-8000-000000000001"] },
      "director",
      "director-1"
    );

    const sql = render(wheres);
    expect(sql).toContain("stage_id");
    expect(sql).toContain("00000000-0000-4000-8000-000000000001"); // new_lead itself
    expect(sql).toContain("00000000-0000-4000-8000-000000000002"); // contacted (same family)
    expect(sql).toContain("00000000-0000-4000-8000-000000000003"); // scoping_in_progress (same family)
    expect(sql).not.toContain("00000000-0000-4000-8000-000000000009"); // qualified_lead (other bucket)
  });

  it("no-matches when every stage id is malformed (never widens to all leads)", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, { stageIds: ["stage-a", "stage-b"] }, "director", "director-1");

    const sql = render(wheres);
    expect(sql).toContain("false");
    expect(sql).not.toContain("stage-a");
  });

  it("SELECTs the outcome-aware displayDate (filter-axis == display-axis)", async () => {
    const { tenantDb, selectFields } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, {}, "director", "director-1");

    const fields = selectFields[0] as Record<string, unknown> | undefined;
    expect(fields && "displayDate" in fields).toBe(true);
    const displaySql = render([fields?.displayDate]);
    expect(displaySql).toContain("to_char");
    expect(displaySql).toContain("converted_at");
    expect(displaySql).toContain("disqualified_at");
    expect(displaySql).toContain("yyyy-mm-dd");
  });
});

describe("listLeads — soft-delete exclusion", () => {
  it("excludes soft-deleted leads when isActive='all' (drops only isActive=false AND status=open)", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, { isActive: "all" }, "director", "director-1");

    const sql = render(wheres);
    expect(sql).toContain("not");
    expect(sql).toContain("is_active");
    expect(sql).toContain("status");
    expect(sql).toContain("open");
    // keeps converted + disqualified inactive leads (does not single them out by status)
    expect(sql).not.toContain("converted");
    expect(sql).not.toContain("disqualified");
  });

  it("default (no isActive) filters strictly to active leads (no soft-delete carve-out)", async () => {
    const { tenantDb, wheres } = createTenantDbCapturingLeadQueries();

    await listLeads(tenantDb, {}, "director", "director-1");

    const sql = render(wheres);
    expect(sql).toContain("is_active");
    expect(sql).not.toContain("not ("); // plain eq(is_active, true), no NOT(...) guard
  });
});

describe("resolveLeadStageBucketIds (pure stage-family expansion)", () => {
  const stages = [
    { id: "id-new_lead", slug: "new_lead" },
    { id: "id-contacted", slug: "contacted" },
    { id: "id-company_pre_qualified", slug: "company_pre_qualified" },
    { id: "id-scoping_in_progress", slug: "scoping_in_progress" },
    { id: "id-lead_new", slug: "lead_new" },
    { id: "id-qualified_lead", slug: "qualified_lead" },
    { id: "id-director_go_no_go", slug: "director_go_no_go" },
    { id: "id-sales_validation_stage", slug: "sales_validation_stage" },
  ];

  it("expands a canonical bucket id to every member of its family", () => {
    const result = resolveLeadStageBucketIds(["id-new_lead"], stages);
    expect(new Set(result)).toEqual(
      new Set([
        "id-contacted",
        "id-lead_new",
        "id-company_pre_qualified",
        "id-scoping_in_progress",
        "id-new_lead",
      ])
    );
    expect(result).not.toContain("id-qualified_lead");
  });

  it("expands a non-canonical family member id to the whole bucket too", () => {
    const result = resolveLeadStageBucketIds(["id-contacted"], stages);
    expect(result).toContain("id-new_lead");
    expect(result).toContain("id-scoping_in_progress");
  });

  it("dedupes across multiple selected buckets", () => {
    const result = resolveLeadStageBucketIds(["id-new_lead", "id-contacted"], stages);
    expect(result.length).toBe(new Set(result).size);
  });

  it("passes a valid-uuid stage id that is not a known lead stage through as an exact match", () => {
    const unknownUuid = "22222222-2222-4222-8222-222222222222";
    expect(resolveLeadStageBucketIds([unknownUuid], stages)).toEqual([unknownUuid]);
  });

  it("drops malformed (non-uuid, unknown) values entirely", () => {
    expect(resolveLeadStageBucketIds(["garbage", "also-bad"], stages)).toEqual([]);
  });
});
