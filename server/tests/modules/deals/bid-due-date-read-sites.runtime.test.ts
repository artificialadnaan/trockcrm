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
const PROJECT_NUMBER = "DFW-1-00001-aa";
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
  detachedAt?: Date | null;
  /** Models writeBidDueDateIfNeeded's provenance stamp (0224). Absent => a coincidental day match. */
  fromBidBoardAt?: Date | null;
  /** The project the stamp was earned on. Defaults to the deal's current project when a stamp is set. */
  stampedProjectNumber?: string | null;
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
    bidDueDateFromBidBoardAt: options.fromBidBoardAt ?? null,
    bidBoardProjectNumber: PROJECT_NUMBER,
    bidDueDateBidBoardProjectNumber:
      options.stampedProjectNumber !== undefined
        ? options.stampedProjectNumber
        : options.fromBidBoardAt
          ? PROJECT_NUMBER
          : null,
    bidBoardDetachedAt: options.detachedAt ?? null,
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

  // "Landed" = the write-through has run, so deals.bid_due_date already carries the mirror's day. That is
  // the ONLY state in which the override fires, and the value returned is the deal COLUMN — the same
  // column holdHorizonDateSql and its ~50 SQL consumers read, so TS and SQL cannot disagree.
  const landed = {
    dealInstant: new Date(`${MIRROR_DAY}T00:00:00.000Z`),
    mirrorDay: MIRROR_DAY,
    // The 0224 stamp. Without it the same two dates are only a COINCIDENCE and the override must refuse.
    fromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
  };

  it("getDealDetail: a LANDED deal column beats a differing lead value", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, ...landed });

    expect(day((await detail())?.bidDueDate)).toBe(MIRROR_DAY);
  });

  it("getResolvedDeal: a LANDED deal column beats a differing lead value", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, ...landed });

    expect(day((await resolved()).resolved.bidDueDate)).toBe(MIRROR_DAY);
  });

  // ★ H2 — the drift guard. A mirror the write-through has NOT delivered must change NOTHING, or these
  // three TS read sites would show the board's date while every SQL surface still read the deal column —
  // permanently, for every deal the write-through skips (detached, off-export, null-attributor,
  // multi-match, template rows).
  it("a mirror the column has NOT received is ignored on both sites — no TS/SQL drift", async () => {
    await seed({ hasLead: true, leadDay: LEAD_DAY, mirrorDay: MIRROR_DAY });

    expect(day((await detail())?.bidDueDate)).toBe(LEAD_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(LEAD_DAY);
  });

  // ★ H1 — detach. buildBidBoardDetachUpdate never clears bid_board_due_date, so a severed deal can carry
  // a mirror that still matches its column. It must fall back to the legacy answer anyway, or it would go
  // on taking its hold horizon (and therefore its value) from the board it was disconnected from, forever.
  it("a DETACHED deal ignores the override even when its column matches the mirror", async () => {
    await seed({
      hasLead: true,
      leadDay: LEAD_DAY,
      ...landed,
      detachedAt: new Date("2026-07-20T12:00:00.000Z"),
    });

    expect(day((await detail())?.bidDueDate)).toBe(LEAD_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(LEAD_DAY);
  });

  // ★ P1 — RETIRED PROJECT. Detached, then re-linked to a genuinely NEW Bid Board project: the link path
  // clears bid_board_detached_at but preserves the dates and the stamp. The deal is no longer detached, so
  // the detach guard cannot help — only the project identity can.
  it("a stamp earned on a RETIRED project does not resurrect the override on either site", async () => {
    await seed({
      hasLead: true,
      leadDay: LEAD_DAY,
      ...landed,
      // The deal now sits on a different project than the one the stamp names.
      stampedProjectNumber: "DFW-9-RETIRED-zz",
    });

    expect(day((await detail())?.bidDueDate)).toBe(LEAD_DAY);
    expect(day((await resolved()).resolved.bidDueDate)).toBe(LEAD_DAY);
  });

  it("a deal with NO source lead is unaffected either way — there is nothing to outrank", async () => {
    await seed({ hasLead: false, ...landed });
    expect(day((await detail())?.bidDueDate)).toBe(MIRROR_DAY);

    await seed({ hasLead: false, mirrorDay: MIRROR_DAY });
    expect(day((await detail())?.bidDueDate)).toBe(DEAL_DAY);
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
  it("returns the LEAD value on a deal whose column HAS landed — the exact case the flag changes", async () => {
    // Not a mirror-only fixture: with the signal rule that would pass whether or not the flag were read.
    // The column and the mirror agree here, so flag ON returns the column — and flag OFF must not.
    await seed({
      hasLead: true,
      leadDay: LEAD_DAY,
      mirrorDay: MIRROR_DAY,
      dealInstant: new Date(`${MIRROR_DAY}T00:00:00.000Z`),
      fromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
    });

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
 * horizon, so which date wins decides whether the deal reports its value or $0.
 *
 * Every fixture here is in the LANDED state (the write-through has run, so deals.bid_due_date carries the
 * mirror's day) because that is the only state the read override fires in. Note what that makes these
 * cases: with the flag ON, detail agrees with what the SQL surfaces have been saying all along, since they
 * read the same column. With it OFF, the lead masks that column on the deal page while the board and the
 * dashboards read it — the pre-existing detail-vs-aggregate gap this read change closes.
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

  /** A deal whose column has RECEIVED the Bid Board's date, with the lead disagreeing. */
  async function seedLanded(boardDay: string, leadDay: string) {
    await seed({
      hasLead: true,
      leadDay,
      mirrorDay: boardDay,
      dealInstant: new Date(`${boardDay}T00:00:00.000Z`),
      fromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
      // The close target is deliberately the OPPOSITE of the board's date, so a surface still reading
      // expected_close_date gives the wrong answer rather than accidentally agreeing.
      expectedCloseDate: leadDay,
      bidBoardTotalSales: VALUE,
    });
  }

  it("a landed horizon >90 CT-days out parks the estimating deal and zeroes its value", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await seedLanded(farOutDay(), nearDay());

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(true);
    expect(Number(result?.effectiveValue)).toBe(0);
  });

  it("…and the SAME fixture with the flag OFF reports the deal live, at its full value", async () => {
    // The pair that makes the flag meaningful: identical rows, the only difference is the gate.
    await seedLanded(farOutDay(), nearDay());

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(false);
    expect(Number(result?.effectiveValue)).toBe(Number(VALUE));
  });

  it("a landed horizon <=90 days out does NOT park it, even with a far-out close target", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await seedLanded(nearDay(), farOutDay());

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(false);
    expect(Number(result?.effectiveValue)).toBe(Number(VALUE));
  });

  // A far-out board date that has NOT landed must not park anything: the column still holds the old value,
  // so parking here would be TS inventing a verdict the SQL surfaces do not share.
  it("a far-out mirror the column has NOT received parks nothing, flag on", async () => {
    process.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await seed({
      hasLead: true,
      leadDay: nearDay(),
      mirrorDay: farOutDay(),
      dealInstant: new Date(`${nearDay()}T00:00:00.000Z`),
      expectedCloseDate: nearDay(),
      bidBoardTotalSales: VALUE,
    });

    const result = await detail();
    expect(result?.effectiveOnHold).toBe(false);
    expect(Number(result?.effectiveValue)).toBe(Number(VALUE));
  });
});
