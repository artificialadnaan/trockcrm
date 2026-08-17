// ★ THE FLAG-OFF PARITY TEST — the one that protects prod — plus the flag-on read precedence.
//
// `deals.bid_board_due_date` is ALREADY populated on prod: the Bid Board ingest has mirrored it on every
// sync since the column existed, and until now NOTHING read it. So the read precedence cannot ship
// ungated — the moment it did, every deal carrying a mirror value would show a different bid due date on
// its detail banner, and because getDealDetail feeds that date into attachAtRiskResult, a different
// at-risk verdict and a different effective VALUE. The flag is the only thing standing between a deploy
// and that swing, which is why the flag-off half of every case below asserts the OLD answer explicitly
// rather than trusting that "nothing changed".
//
// Both read sites run for real against PGlite with the schema derived from the REAL Drizzle tables
// (tenantSchemaSql), so the precedence is exercised through the actual SELECTs and column types — a
// mocked tenantDb would prove only that the resolver was called.
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  auditLog,
  changeOrders,
  companies,
  contacts,
  dealApprovals,
  dealChangeOrders,
  dealHistory,
  dealStageHistory,
  deals,
  leadQuestionAnswers,
  leads,
  pipelineStageConfig,
  projectTypeConfig,
  projectTypeQuestionNodes,
  properties,
  users,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const STAGE_ESTIMATING = "00000000-0000-4000-8000-0000000050a1";
const REP_ID = "00000000-0000-4000-8000-0000000000a1";
const OFFICE_ID = "00000000-0000-4000-8000-0000000000f1";
const DEAL_ID = "00000000-0000-4000-8000-0000000000d1";
const LEAD_ID = "00000000-0000-4000-8000-0000000000e1";
const COMPANY_ID = "00000000-0000-4000-8000-0000000000c1";
const PROPERTY_ID = "00000000-0000-4000-8000-0000000000b1";

// The three dates are deliberately all DIFFERENT, so every assertion below distinguishes which source won
// instead of coincidentally agreeing.
const MIRROR_DAY = "2026-09-01";
const LEAD_DAY = "2026-06-01";
const DEAL_DAY = "2026-07-01";
const DEAL_INSTANT = new Date(`${DEAL_DAY}T00:00:00.000Z`);

const STAGE = {
  id: STAGE_ESTIMATING,
  slug: "estimating",
  name: "Estimating",
  workflowFamily: "standard_deal",
  displayOrder: 3,
  isBidBoard: false,
  isTerminal: false,
  isActive: true,
  bidBoardStageCode: null,
};

// getStageByIdForWorkflowRoute reads pipeline_stage_config through the GLOBAL db connection, which cannot
// see PGlite. Everything on the bid-due-date path below is the real thing.
vi.mock("../../../src/modules/pipeline/service.js", () => ({
  getStageById: vi.fn().mockResolvedValue(STAGE),
  getStageBySlug: vi.fn().mockResolvedValue(STAGE),
  getStageByIdForWorkflowRoute: vi.fn().mockResolvedValue(STAGE),
  getActiveProjectTypes: vi.fn().mockResolvedValue([]),
  resolveActiveProjectTypeValue: vi.fn().mockResolvedValue(null),
  listDealStages: vi.fn().mockResolvedValue([STAGE]),
}));

vi.mock("../../../src/modules/assignment-tasks/service.js", () => ({
  createAssignmentTaskIfNeeded: vi.fn(),
}));

const { getDealDetail } = await import("../../../src/modules/deals/service.js");
const { getResolvedDeal } = await import("../../../src/modules/deals/lineage-resolver.js");

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

/**
 * @param hasLead      whether the deal is lead-backed at all
 * @param leadDay      the lead's bid_due_date (null models a deliberately CLEARED lead value)
 * @param mirrorDay    deals.bid_board_due_date — already populated on prod for every matched deal
 * @param expectedCloseDate drives the auto-park horizon in every stage EXCEPT estimating
 */
async function seed(options: {
  hasLead: boolean;
  leadDay?: string | null;
  mirrorDay?: string | null;
  dealInstant?: Date | null;
  expectedCloseDate?: string | null;
  bidBoardTotalSales?: string | null;
}) {
  await pg.exec(`DELETE FROM public.deals; DELETE FROM public.leads;`);
  if (options.hasLead) {
    await tdb.insert(leads).values({
      id: LEAD_ID,
      name: "Riverbend Tower",
      bidDueDate: options.leadDay ?? null,
      assignedRepId: REP_ID,
      // leads.company_id and leads.property_id are NOT NULL in the real schema (tenantSchemaSql
      // reproduces that verbatim), so the lead-backed fixture carries the real lineage.
      companyId: COMPANY_ID,
      propertyId: PROPERTY_ID,
      stageId: STAGE_ESTIMATING,
      officeCode: "dfw",
      office: "dfw",
    });
  }
  await tdb.insert(deals).values({
    id: DEAL_ID,
    name: "Riverbend Tower",
    dealNumber: "DFW-1-00001-aa",
    stageId: STAGE_ESTIMATING,
    assignedRepId: REP_ID,
    sourceLeadId: options.hasLead ? LEAD_ID : null,
    bidDueDate: options.dealInstant === undefined ? DEAL_INSTANT : options.dealInstant,
    bidBoardDueDate: options.mirrorDay ?? null,
    expectedCloseDate: options.expectedCloseDate ?? null,
    bidBoardTotalSales: options.bidBoardTotalSales ?? null,
    stageEnteredAt: new Date(),
    isActive: true,
  });
}

function detail() {
  return getDealDetail(tdb, DEAL_ID, "admin", REP_ID);
}

function resolved() {
  return getResolvedDeal(tdb, DEAL_ID);
}

/** Both read sites agree on the calendar day. `bidDueDate` is date-only or a UTC-midnight instant. */
function day(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(
    tenantSchemaSql("public", [
      users,
      pipelineStageConfig,
      projectTypeConfig,
      companies,
      contacts,
      properties,
      leads,
      // getResolvedDeal joins the lead's questionnaire answers.
      leadQuestionAnswers,
      projectTypeQuestionNodes,
      deals,
      dealHistory,
      dealStageHistory,
      dealApprovals,
      changeOrders,
      dealChangeOrders,
      auditLog,
    ]),
  );
  await tdb_init();
}, 30000);

async function tdb_init() {
  tdb = drizzle(pg);
  await tdb.insert(pipelineStageConfig).values({
    id: STAGE_ESTIMATING,
    slug: "estimating",
    name: "Estimating",
    workflowFamily: "standard_deal",
    displayOrder: 3,
  });
  await tdb.insert(companies).values({
    id: COMPANY_ID,
    name: "Acme Roofing Co",
    slug: "acme-roofing-co",
    category: "client",
  });
  await tdb.insert(properties).values({
    id: PROPERTY_ID,
    companyId: COMPANY_ID,
    name: "Riverbend Tower",
  });
  await tdb.insert(users).values({
    id: REP_ID,
    email: "rep@example.com",
    displayName: "Rep One",
    role: "rep",
    officeId: OFFICE_ID,
    isActive: true,
  });
}

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(() => {
  delete process.env.BID_BOARD_DUE_DATE_READBACK;
});

afterEach(() => {
  delete process.env.BID_BOARD_DUE_DATE_READBACK;
});

describe("Bid Board due date read precedence — flag ON", () => {
  beforeEach(() => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
  });

  it("getDealDetail surfaces the Bid Board date over a DIFFERING lead value", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, mirrorDay: MIRROR_DAY });

    expect(day((await detail())?.bidDueDate)).toBe(MIRROR_DAY);
  });

  it("getResolvedDeal surfaces the Bid Board date over a DIFFERING lead value", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, mirrorDay: MIRROR_DAY });

    expect(day((await resolved()).resolved.bidDueDate)).toBe(MIRROR_DAY);
  });

  it("both sites agree for a deal with NO source lead, over its own stale column", async () => {
    await seed({ hasLead: false, mirrorDay: MIRROR_DAY });

    expect(day((await detail())?.bidDueDate)).toBe(MIRROR_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(MIRROR_DAY);
  });

  // The 91%-null regression guard: with no mirror value the flag changes nothing at all, on either site.
  it("a deal with NO Bid Board date behaves exactly as it does today", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, mirrorDay: null });
    expect(day((await detail())?.bidDueDate)).toBe(LEAD_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(LEAD_DAY);

    await seed({ hasLead: false, mirrorDay: null });
    expect(day((await detail())?.bidDueDate)).toBe(DEAL_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(DEAL_DAY);
  });
});

describe("★ Bid Board due date read precedence — flag OFF (prod parity)", () => {
  it("returns the LEAD value even though a DIFFERING Bid Board date is present, on both sites", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, mirrorDay: MIRROR_DAY });

    expect(day((await detail())?.bidDueDate)).toBe(LEAD_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(LEAD_DAY);
  });

  it("returns the DEAL column for a lead-less deal even though a Bid Board date is present", async () => {
    await seed({ hasLead: false, mirrorDay: MIRROR_DAY });

    expect(day((await detail())?.bidDueDate)).toBe(DEAL_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(DEAL_DAY);
  });

  it("keeps a lead-backed deal's CLEARED lead value winning over a stale deal column", async () => {
    // Documented behaviour predating this PR: the lead owns the field, so a deliberate clear must not be
    // masked by the deal's pre-write-through snapshot. Asserted with a mirror present so the flag-off path
    // is proven to ignore it rather than to be untested.
    await seed({ hasLead: true, leadDay: null, mirrorDay: MIRROR_DAY });

    expect((await detail())?.bidDueDate).toBeNull();
    expect((await resolved()).resolved.bidDueDate).toBeNull();
  });

  it("publishes the deal column in its ORIGINAL wire shape (a UTC-midnight instant), not a narrowed day", async () => {
    // getDealDetail takes the resolver's `.raw`, not `.day`, precisely so introducing the resolver does not
    // silently change the JSON a client receives for the ~9% of deals that carry deals.bid_due_date.
    await seed({ hasLead: false, mirrorDay: MIRROR_DAY });

    expect((await detail())?.bidDueDate).toBeInstanceOf(Date);
    expect(((await detail())?.bidDueDate as Date).toISOString()).toBe(DEAL_INSTANT.toISOString());
    // getResolvedDeal keeps its date-only contract (consumers guard on `typeof === "string"`).
    expect((await resolved()).resolved.bidDueDate).toBe(DEAL_DAY);
  });
});

/**
 * ★ THE CONSEQUENCE. The bid due date is not a label: in a genuine estimating stage it IS the auto-park
 * horizon, so which date wins decides whether the deal reports its value or $0. This pins both directions
 * and — critically — pins that the flag-off answer is the OLD one on the very same fixture.
 */
describe("hold / at-risk consequence of the resolved bid due date", () => {
  const VALUE = "241000.00";
  const farOutDay = () => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 200);
    return date.toISOString().slice(0, 10);
  };
  const nearDay = () => {
    const date = new Date();
    date.setUTCDate(date.getUTCDate() + 10);
    return date.toISOString().slice(0, 10);
  };

  it("a Bid Board horizon >90 CT-days out parks the estimating deal and zeroes its value", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await seed({
      hasLead: true,
      leadDay: nearDay(),
      mirrorDay: farOutDay(),
      // The close target is deliberately NEAR, so a surface still reading expected_close_date would give
      // the opposite answer rather than accidentally agreeing.
      expectedCloseDate: nearDay(),
      bidBoardTotalSales: VALUE,
    });

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(true);
    expect(Number(result?.effectiveValue)).toBe(0);
  });

  it("…and the SAME fixture with the flag OFF reports the deal live, at its full value", async () => {
    // This is the pair that makes the flag meaningful: the mirror is present and far out either way, so
    // the ONLY difference is the gate.
    await seed({
      hasLead: true,
      leadDay: nearDay(),
      mirrorDay: farOutDay(),
      expectedCloseDate: nearDay(),
      bidBoardTotalSales: VALUE,
    });

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(false);
    expect(Number(result?.effectiveValue)).toBe(Number(VALUE));
  });

  it("a Bid Board horizon <=90 days out does NOT park it, even with a far-out close target", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await seed({
      hasLead: true,
      leadDay: farOutDay(),
      mirrorDay: nearDay(),
      expectedCloseDate: farOutDay(),
      bidBoardTotalSales: VALUE,
    });

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(false);
    expect(Number(result?.effectiveValue)).toBe(Number(VALUE));
  });
});
