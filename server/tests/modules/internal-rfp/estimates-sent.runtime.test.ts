// The CRM half of SyncHub's "RFP + Estimate Sent to Client" email, run against real SQL.
//
// Real types throughout, because every interesting failure here is a type failure in disguise: the amount
// columns are real NUMERIC (a JS number would drift a cent), created_at is real timestamptz (the window is
// half-open and would double-count on a text column), and the stage catalogue is a PUBLIC table while the
// history is per-office (a per-schema join would silently return nothing at all — it did, in the first draft).
import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { SENT_STAGE_SLUGS } from "../../../src/modules/reports/foundations.js";
import { loadEstimatesSent, parseWindow, quoteSchema } from "../../../src/modules/internal-rfp/estimates-sent-service.js";

let db: PGlite;
const query = (text: string, params?: unknown[]) => db.query(text, params as unknown[]) as Promise<{ rows: any[] }>;

const REP_A = "11111111-1111-1111-1111-11111111000a";
const REP_B = "11111111-1111-1111-1111-11111111000b";
const REP_TEST = "11111111-1111-1111-1111-1111111100fe";

const ST_SENT = "22222222-2222-2222-2222-222222220001";
const ST_SENT_SERVICE = "22222222-2222-2222-2222-222222220002";
const ST_BID_SENT = "22222222-2222-2222-2222-222222220003";
const ST_ESTIMATING = "22222222-2222-2222-2222-222222220004";

const D_FIRST = "33333333-3333-3333-3333-333333330001";
const D_RESENT = "33333333-3333-3333-3333-333333330002";
const D_SERVICE = "33333333-3333-3333-3333-333333330003";
const D_LEGACY = "33333333-3333-3333-3333-333333330004";
const D_DELETED = "33333333-3333-3333-3333-333333330005";
const D_TESTDATA = "33333333-3333-3333-3333-333333330006";
const D_ONHOLD = "33333333-3333-3333-3333-333333330007";
const D_TESTREP = "33333333-3333-3333-3333-333333330008";
const D_ATL = "33333333-3333-3333-3333-333333330009";
const D_ESTIMATING = "33333333-3333-3333-3333-33333333000a";
const D_DEDUCTIVE = "33333333-3333-3333-3333-33333333000b";
const D_HUBSPOT_OWNER = "33333333-3333-3333-3333-33333333000c";
const D_CREATOR_OWNER = "33333333-3333-3333-3333-33333333000d";
const D_TEST_CREATOR = "33333333-3333-3333-3333-33333333000e";
const D_TEST_HUBSPOT = "33333333-3333-3333-3333-33333333000f";

const WINDOW_FROM = new Date("2026-08-06T00:00:00.000Z");
const WINDOW_TO = new Date("2026-08-07T00:00:00.000Z");
const SCHEMAS = ["office_dallas", "office_atlanta"];

function historyRow(id: string, dealId: string, stageId: string, at: string) {
  return `('${id}', '${dealId}', '${stageId}', '${REP_A}', '${at}')`;
}

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_dallas;
    CREATE SCHEMA office_atlanta;

    CREATE TABLE public.users (
      id uuid PRIMARY KEY, display_name text, email text, is_test_data boolean DEFAULT false
    );
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, slug text NOT NULL);
  `);

  for (const schema of SCHEMAS) {
    await db.exec(`
      CREATE TABLE ${schema}.deals (
        id uuid PRIMARY KEY,
        name text,
        deal_number text,
        project_number text,
        assigned_rep_id uuid,
        created_by_user_id uuid,
        hubspot_owner_email text,
        is_change_order boolean DEFAULT false,
        awarded_amount numeric(12,2),
        bid_board_total_sales numeric(12,2),
        bid_estimate numeric(12,2),
        dd_estimate numeric(12,2),
        on_hold boolean DEFAULT false,
        is_active boolean DEFAULT true,
        is_test_data boolean DEFAULT false
      );
      CREATE TABLE ${schema}.deal_stage_history (
        id uuid PRIMARY KEY,
        deal_id uuid,
        to_stage_id uuid,
        changed_by uuid,
        created_at timestamptz NOT NULL
      );
    `);
  }

  await db.exec(`
    INSERT INTO public.users (id, display_name, email, is_test_data) VALUES
      ('${REP_A}',    'Andrew Green',  'agreen@trockgc.com',  false),
      ('${REP_B}',    'Colby Burling', 'cburling@trockgc.com', false),
      ('${REP_TEST}', 'QA Bot',        'qa@trockgc.com',       true);

    INSERT INTO public.pipeline_stage_config (id, slug) VALUES
      ('${ST_SENT}',         'estimate_sent_to_client'),
      ('${ST_SENT_SERVICE}', 'service_estimate_sent_to_client'),
      ('${ST_BID_SENT}',     'bid_sent'),
      ('${ST_ESTIMATING}',   'estimating');

    INSERT INTO office_dallas.deals
      (id, name, deal_number, project_number, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate, on_hold, is_active, is_test_data) VALUES
      ('${D_FIRST}',      'Elan at Bluffview',  'DFW-1', 'DFW-4-21826-ad', '${REP_A}', NULL,      120000.55, 90000, false, true,  false),
      ('${D_RESENT}',     'Tides Royal Lane',   'DFW-2', 'DFW-4-21826-ac', '${REP_B}', 250000.00, 200000,    NULL,  false, true,  false),
      ('${D_SERVICE}',    'Tides on Timberglen','DFW-3', 'DFW-4-21826-ab', '${REP_A}', NULL,      80000,     NULL,  false, true,  false),
      ('${D_LEGACY}',     'Legacy Bid Sent',    'DFW-4', NULL,             '${REP_A}', NULL,      45000,     NULL,  false, true,  false),
      ('${D_DELETED}',    'Soft Deleted',       'DFW-5', NULL,             '${REP_A}', NULL,      10000,     NULL,  false, false, false),
      ('${D_TESTDATA}',   'Test Row',           'DFW-6', NULL,             '${REP_A}', NULL,      10000,     NULL,  false, true,  true),
      ('${D_ONHOLD}',     'Parked After Send',  'DFW-7', NULL,             '${REP_A}', NULL,      70000,     NULL,  true,  true,  false),
      ('${D_TESTREP}',    'Owned By QA',        'DFW-8', NULL,             '${REP_TEST}', NULL,   10000,     NULL,  false, true,  false),
      ('${D_ESTIMATING}', 'Still Estimating',   'DFW-9', NULL,             '${REP_A}', NULL,      30000,     NULL,  false, true,  false);

    -- A DEDUCTIVE change order: a negative awarded_amount the positive-only chain would drop to 0.
    INSERT INTO office_dallas.deals
      (id, name, deal_number, assigned_rep_id, is_change_order, awarded_amount, bid_estimate, is_active, is_test_data) VALUES
      ('${D_DEDUCTIVE}', 'Credit CO', 'DFW-10', '${REP_A}', true, -15000.00, 90000, true, false);

    -- assigned_rep_id is NULLABLE (migration 0042). These two exercise the fallback chain.
    INSERT INTO office_dallas.deals
      (id, name, deal_number, assigned_rep_id, created_by_user_id, hubspot_owner_email, bid_estimate, is_active, is_test_data) VALUES
      ('${D_HUBSPOT_OWNER}', 'HubSpot Owned', 'DFW-11', NULL, NULL,        'legacy@trockgc.com', 11000, true, false),
      ('${D_CREATOR_OWNER}', 'Creator Owned', 'DFW-12', NULL, '${REP_B}',  NULL,                 12000, true, false),
      -- No rep, no HubSpot owner, and the CREATOR is a test user: the fallback selects them, so the row
      -- must be excluded rather than reported under a test identity.
      ('${D_TEST_CREATOR}', 'Created By QA', 'DFW-13', NULL, '${REP_TEST}', NULL,                13000, true, false),
      -- No rep and no creator, but the synced HubSpot address resolves to a test user — cased differently,
      -- since email matching here is case-insensitive.
      ('${D_TEST_HUBSPOT}', 'HubSpot QA', 'DFW-14', NULL, NULL, 'QA@trockgc.com', 14000, true, false);

    INSERT INTO office_atlanta.deals
      (id, name, deal_number, project_number, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate, on_hold, is_active, is_test_data) VALUES
      ('${D_ATL}', 'Atlanta Send', 'ATL-1', NULL, '${REP_B}', NULL, 60000, NULL, false, true, false);
  `);

  await db.exec(`
    INSERT INTO office_dallas.deal_stage_history (id, deal_id, to_stage_id, changed_by, created_at) VALUES
      -- in-window sends
      ${historyRow("44444444-4444-4444-4444-444444440001", D_FIRST, ST_SENT, "2026-08-06T12:54:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440002", D_RESENT, ST_SENT, "2026-08-06T12:52:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440003", D_SERVICE, ST_SENT_SERVICE, "2026-08-06T12:50:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440004", D_LEGACY, ST_BID_SENT, "2026-08-06T12:48:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440005", D_DELETED, ST_SENT, "2026-08-06T12:46:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440006", D_TESTDATA, ST_SENT, "2026-08-06T12:44:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440007", D_ONHOLD, ST_SENT, "2026-08-06T12:42:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440008", D_TESTREP, ST_SENT, "2026-08-06T12:40:00Z")},
      -- a non-sent stage entry in-window: must never appear
      ${historyRow("44444444-4444-4444-4444-444444440009", D_ESTIMATING, ST_ESTIMATING, "2026-08-06T12:38:00Z")},
      -- D_RESENT's TWO earlier sends, both before the window
      ${historyRow("44444444-4444-4444-4444-44444444000a", D_RESENT, ST_SENT, "2026-07-01T09:00:00Z")},
      ${historyRow("44444444-4444-4444-4444-44444444000b", D_RESENT, ST_BID_SENT, "2026-06-01T09:00:00Z")},
      -- exact boundary rows: the lower bound is INCLUDED, the upper bound is EXCLUDED
      ${historyRow("44444444-4444-4444-4444-44444444000c", D_FIRST, ST_SENT, "2026-08-06T00:00:00Z")},
      ${historyRow("44444444-4444-4444-4444-44444444000d", D_FIRST, ST_SENT, "2026-08-07T00:00:00Z")},
      ${historyRow("44444444-4444-4444-4444-44444444000e", D_DEDUCTIVE, ST_SENT, "2026-08-06T12:36:00Z")},
      ${historyRow("44444444-4444-4444-4444-44444444000f", D_HUBSPOT_OWNER, ST_SENT, "2026-08-06T12:34:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440010", D_CREATOR_OWNER, ST_SENT, "2026-08-06T12:32:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440011", D_TEST_CREATOR, ST_SENT, "2026-08-06T12:30:00Z")},
      ${historyRow("44444444-4444-4444-4444-444444440012", D_TEST_HUBSPOT, ST_SENT, "2026-08-06T12:28:00Z")};

    INSERT INTO office_atlanta.deal_stage_history (id, deal_id, to_stage_id, changed_by, created_at) VALUES
      ${historyRow("44444444-4444-4444-4444-4444444400a1", D_ATL, ST_SENT, "2026-08-06T12:53:00Z")};
  `);
}, 60_000);

afterAll(async () => {
  await db?.close?.();
});

async function load() {
  return loadEstimatesSent(query, SCHEMAS, WINDOW_FROM, WINDOW_TO);
}

describe("estimates sent — which rows the feed returns", () => {
  it("returns every SENT-stage entry in the window and nothing else", async () => {
    const rows = await load();
    const names = rows.map((row) => row.name);

    expect(names).toContain("Elan at Bluffview");
    expect(names).toContain("Tides Royal Lane");
    // The service pipeline's parallel stage and the pre-0053 legacy slug both count. Naming only
    // estimate_sent_to_client would omit every service deal while the reports still counted it.
    expect(names).toContain("Tides on Timberglen");
    expect(names).toContain("Legacy Bid Sent");
    // A stage entry that is not a send.
    expect(names).not.toContain("Still Estimating");
  });

  it("covers the whole canonical sent set, not a hand-picked slug", async () => {
    const rows = await load();
    const slugs = new Set(rows.map((row) => row.stageSlug));
    for (const slug of SENT_STAGE_SLUGS) {
      expect(slugs, `missing ${slug}`).toContain(slug);
    }
  });

  it("excludes soft-deleted and test rows, and sends owned by a test user", async () => {
    const names = (await load()).map((row) => row.name);

    expect(names).not.toContain("Soft Deleted");
    expect(names).not.toContain("Test Row");
    expect(names).not.toContain("Owned By QA");
  });

  // Parking a deal afterwards does not un-send the estimate. This differs from the forecast reports on
  // purpose — they ask what is still live, this asks what went out.
  it("includes a deal put on hold AFTER the estimate went out", async () => {
    const names = (await load()).map((row) => row.name);
    expect(names).toContain("Parked After Send");
  });
});

describe("estimates sent — the window", () => {
  // Half-open. A closed upper bound puts a boundary send in TWO consecutive daily reports, and the two
  // emails then disagree about the same deal with no way to tell which is right.
  it("includes the lower bound and excludes the upper", async () => {
    const rows = await load();
    const stamps = rows.filter((row) => row.name === "Elan at Bluffview").map((row) => row.enteredAt);

    expect(stamps).toContain("2026-08-06T00:00:00.000Z");
    expect(stamps).not.toContain("2026-08-07T00:00:00.000Z");
  });

  it("leaves out sends from before the window entirely", async () => {
    const rows = await load();
    expect(rows.every((row) => Date.parse(row.enteredAt) >= WINDOW_FROM.getTime())).toBe(true);
    expect(rows.every((row) => Date.parse(row.enteredAt) < WINDOW_TO.getTime())).toBe(true);
  });
});

describe("estimates sent — the re-send annotation", () => {
  // The whole point of "every entry, annotated": a revised estimate going out again is a real send worth
  // reporting, but it must not read as new business.
  it("counts a deal's PRIOR sends, across every sent slug", async () => {
    const rows = await load();
    const resent = rows.find((row) => row.name === "Tides Royal Lane");

    // One earlier estimate_sent_to_client and one earlier bid_sent.
    expect(resent?.priorEntryCount).toBe(2);
  });

  it("reports zero for a deal being sent for the first time", async () => {
    const rows = await load();
    const first = rows.find((row) => row.name === "Tides on Timberglen");
    expect(first?.priorEntryCount).toBe(0);
  });

  // Counted STRICTLY BEFORE this entry, so the two boundary sends of the same deal do not each claim the
  // other. Ordered newest-first, the later send must show one more prior than the earlier one.
  it("counts only sends earlier than the entry it annotates", async () => {
    const rows = await load();
    const elan = rows.filter((row) => row.name === "Elan at Bluffview");

    expect(elan.length).toBeGreaterThan(1);
    const counts = elan.map((row) => row.priorEntryCount);
    expect(counts).toEqual([...counts].sort((a, b) => b - a));
    expect(Math.min(...counts)).toBe(0);
  });
});

describe("estimates sent — the fields the email prints", () => {
  it("carries the owner's name and email", async () => {
    const rows = await load();
    const row = rows.find((entry) => entry.name === "Elan at Bluffview");

    expect(row?.ownerName).toBe("Andrew Green");
    expect(row?.ownerEmail).toBe("agreen@trockgc.com");
  });

  // Awarded-first, the same basis the reports quote — not "whatever column is populated".
  it("prefers the awarded amount over the estimate", async () => {
    const rows = await load();
    expect(rows.find((row) => row.name === "Tides Royal Lane")?.amount).toBe("250000.00");
  });

  it("falls back down the chain when nothing is awarded", async () => {
    const rows = await load();
    // bid_estimate outranks dd_estimate on the default chain.
    expect(rows.find((row) => row.name === "Elan at Bluffview")?.amount).toBe("120000.55");
  });

  // Kept as a STRING. numeric(12,2) through a JS number turns 120000.55 into a float the email would
  // eventually print with a drifting cent.
  it("returns the amount as an exact decimal string, not a float", async () => {
    const rows = await load();
    const amount = rows.find((row) => row.name === "Elan at Bluffview")?.amount;

    expect(typeof amount).toBe("string");
    expect(amount).toBe("120000.55");
  });

  // The canonical chain routes through a change-order branch that takes a CO's awarded_amount VERBATIM.
  // The first text rendering of the chain omitted it, so a deductive child's negative amount fell through
  // the positive-only COALESCE and rendered 0 — the two renderings would have disagreed on exactly the
  // rows where a wrong number is most conspicuous.
  it("keeps a deductive change order's NEGATIVE amount instead of zeroing it", async () => {
    const rows = await load();
    expect(rows.find((row) => row.name === "Credit CO")?.amount).toBe("-15000.00");
  });

  // assigned_rep_id is nullable, and the RFP half of this same email already falls back
  // (resolveDealOwner: assigned rep -> HubSpot owner email -> creator). Without the same chain the new
  // section printed an em-dash for deals the rest of the report can name.
  it("falls back to the synced HubSpot owner when there is no assigned rep", async () => {
    const rows = await load();
    const row = rows.find((entry) => entry.name === "HubSpot Owned");
    expect(row?.ownerEmail).toBe("legacy@trockgc.com");
  });

  it("falls back to the deal's creator when there is neither a rep nor a HubSpot owner", async () => {
    const rows = await load();
    const row = rows.find((entry) => entry.name === "Creator Owned");
    expect(row?.ownerEmail).toBe("cburling@trockgc.com");
    expect(row?.ownerName).toBe("Colby Burling");
  });

  // The assigned-rep exclusion was not enough: with no rep and no HubSpot owner the chain selects the
  // CREATOR, and a test creator was reported under their own identity — against this feed's own rule.
  it("excludes a send whose owner resolves to a TEST user through the creator fallback", async () => {
    const rows = await load();
    expect(rows.map((row) => row.name)).not.toContain("Created By QA");
  });

  it("excludes a send whose owner resolves to a TEST user through the HubSpot address", async () => {
    const rows = await load();
    expect(rows.map((row) => row.name)).not.toContain("HubSpot QA");
  });

  it("still prefers the assigned rep over both fallbacks", async () => {
    const rows = await load();
    expect(rows.find((row) => row.name === "Elan at Bluffview")?.ownerEmail).toBe("agreen@trockgc.com");
  });

  it("names the office each send came from", async () => {
    const rows = await load();
    expect(rows.find((row) => row.name === "Atlanta Send")?.officeSlug).toBe("atlanta");
    expect(rows.find((row) => row.name === "Elan at Bluffview")?.officeSlug).toBe("dallas");
  });
});

describe("estimates sent — ordering across offices", () => {
  // Concatenating per-schema results would group by office and read as though every Dallas send preceded
  // every Atlanta one. The Atlanta send at 12:53 sits BETWEEN two Dallas sends, so a missing re-sort shows.
  it("orders strictly newest-first across every office", async () => {
    const rows = await load();
    const stamps = rows.map((row) => Date.parse(row.enteredAt));

    expect(stamps).toEqual([...stamps].sort((a, b) => b - a));

    const ordered = rows.map((row) => row.name);
    expect(ordered.indexOf("Elan at Bluffview")).toBeLessThan(ordered.indexOf("Atlanta Send"));
    expect(ordered.indexOf("Atlanta Send")).toBeLessThan(ordered.indexOf("Tides Royal Lane"));
  });
});

describe("window parsing", () => {
  it("accepts a well-formed window", () => {
    const parsed = parseWindow({ from: "2026-08-06T00:00:00Z", to: "2026-08-07T00:00:00Z" });
    expect(parsed.from.toISOString()).toBe("2026-08-06T00:00:00.000Z");
  });

  it("refuses a missing or unparseable bound rather than defaulting to one", () => {
    expect(() => parseWindow({})).toThrow(/ISO-8601/);
    expect(() => parseWindow({ from: "yesterday", to: "2026-08-07T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  // new Date(String(x)) is far too permissive to guard a window with. Each of these previously became a
  // DIFFERENT valid instant, so a caller with a date-construction bug got a successful report covering a
  // period it never asked for — worse than the 422 it should have had.
  it("refuses a non-string bound instead of stringifying it into a real date", () => {
    // JSON 0 -> "0" -> 2000-01-01.
    expect(() => parseWindow({ from: 0, to: "2026-08-07T00:00:00Z" })).toThrow(/ISO-8601/);
    expect(() => parseWindow({ from: null, to: "2026-08-07T00:00:00Z" })).toThrow(/ISO-8601/);
    expect(() => parseWindow({ from: ["2026-08-06T00:00:00Z"], to: "2026-08-07T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  it("refuses an impossible calendar day rather than normalising it into another month", () => {
    // 2026-02-30 parses as March 2.
    expect(() => parseWindow({ from: "2026-02-30T00:00:00Z", to: "2026-03-05T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  // Postgres has no year zero: this parses in JS and then fails at the ::date cast, turning an invalid
  // parameter into a 500 where the route means to answer 400. The report service's own isRealIsoDate
  // rejects 0000 for exactly this reason.
  it("refuses a year-zero bound", () => {
    expect(() => parseWindow({ from: "0000-01-01T00:00:00Z", to: "2026-08-07T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  it("accepts a bound carrying a non-UTC offset", () => {
    const parsed = parseWindow({ from: "2026-08-06T00:00:00-05:00", to: "2026-08-07T00:00:00Z" });
    expect(parsed.from.toISOString()).toBe("2026-08-06T05:00:00.000Z");
  });

  // An earlier revision skipped the calendar check whenever the input did NOT end in Z, on the grounds
  // that an offset legitimately shifts the day — which exempted every explicit-offset timestamp. These
  // two normalise silently and were both accepted. Components are now validated AS WRITTEN, before the
  // offset is applied, which settles it for every offset.
  it("refuses an impossible calendar day even when it carries an offset", () => {
    expect(() => parseWindow({ from: "2026-02-30T00:00:00-05:00", to: "2026-03-05T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  it("refuses an out-of-range clock component", () => {
    expect(() => parseWindow({ from: "2026-08-06T24:00:00-05:00", to: "2026-08-08T00:00:00Z" })).toThrow(/ISO-8601/);
    expect(() => parseWindow({ from: "2026-08-06T00:60:00Z", to: "2026-08-08T00:00:00Z" })).toThrow(/ISO-8601/);
  });

  it("refuses an inverted or empty window", () => {
    expect(() => parseWindow({ from: "2026-08-07T00:00:00Z", to: "2026-08-06T00:00:00Z" })).toThrow(/after/);
    expect(() => parseWindow({ from: "2026-08-06T00:00:00Z", to: "2026-08-06T00:00:00Z" })).toThrow(/after/);
  });

  // A caller that mis-computes `from` should get an error, not a sweep of every send in company history.
  it("caps the window", () => {
    expect(() => parseWindow({ from: "2020-01-01T00:00:00Z", to: "2026-08-07T00:00:00Z" })).toThrow(/31 days/);
  });
});

describe("schema guarding", () => {
  // The schema name is interpolated into the SQL (it cannot be a bind parameter), so it is the one input
  // that must never be taken on trust — even though today it comes from pg_namespace rather than a request.
  it("refuses anything that is not a tenant schema", () => {
    expect(() => quoteSchema("public")).toThrow();
    expect(() => quoteSchema('office_x"; DROP TABLE deals; --')).toThrow();
    expect(() => quoteSchema("Office_Dallas")).toThrow();
    expect(quoteSchema("office_dallas")).toBe('"office_dallas"');
  });
});
