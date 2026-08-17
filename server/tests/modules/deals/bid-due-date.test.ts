import { describe, expect, it } from "vitest";
import {
  bidDueDateToDateOnly,
  dateOnlyToUtcMidnightIso,
  resolveDealBidDueDate,
  resolveDealBidDueDateForRead,
  resolveRfpPayloadDueDates,
} from "../../../src/modules/deals/bid-due-date.js";

/**
 * The PURE half of the Bid Board due-date read-back. This resolver decides which of three columns supplies
 * a deal's bid due date — and since 2026-07-27 that date is the auto-park horizon for estimating deals, so
 * getting the precedence or the calendar day wrong moves reported dollars. Everything here is DB-free and
 * flag-explicit (the wrapper takes an `env`), so the rules are pinned without a fixture in the way.
 */

const FLAG_ON = { BID_BOARD_DUE_DATE_READBACK: "true" } as NodeJS.ProcessEnv;
const FLAG_OFF = {} as NodeJS.ProcessEnv;

describe("bidDueDateToDateOnly", () => {
  it("returns an exact date-only string verbatim (the lead + Bid Board mirror column shape)", () => {
    expect(bidDueDateToDateOnly("2026-09-01")).toBe("2026-09-01");
  });

  it("reads a UTC-midnight timestamptz Date as its UTC calendar day — no off-by-one", () => {
    // deals.bid_due_date is a timestamptz pinned to UTC midnight (migration 0132) and the SQL twin reads it
    // back with AT TIME ZONE 'UTC'. A local-time read would land on Aug 31 anywhere west of UTC and flip
    // an estimating deal's park verdict, and therefore its value.
    expect(bidDueDateToDateOnly(new Date("2026-09-01T00:00:00.000Z"))).toBe("2026-09-01");
  });

  it("reads a NON-UTC-offset timestamp string by its UTC day, NOT by slicing the prefix", () => {
    // 2026-08-31T19:00:00-05:00 IS 2026-09-01T00:00:00Z. Prefix-slicing would say Aug 31.
    expect(bidDueDateToDateOnly("2026-08-31T19:00:00-05:00")).toBe("2026-09-01");
  });

  it("returns null for absent, blank and unparseable values", () => {
    expect(bidDueDateToDateOnly(null)).toBeNull();
    expect(bidDueDateToDateOnly(undefined)).toBeNull();
    expect(bidDueDateToDateOnly("   ")).toBeNull();
    expect(bidDueDateToDateOnly("not a date")).toBeNull();
    expect(bidDueDateToDateOnly(new Date("nonsense"))).toBeNull();
  });
});

describe("dateOnlyToUtcMidnightIso", () => {
  it("produces the UTC-midnight instant every deals.bid_due_date writer stores", () => {
    expect(dateOnlyToUtcMidnightIso("2026-09-01")).toBe("2026-09-01T00:00:00.000Z");
    // …and round-trips back to the same calendar day the hold rule reads.
    expect(bidDueDateToDateOnly(new Date(dateOnlyToUtcMidnightIso("2026-09-01")))).toBe("2026-09-01");
  });
});

describe("resolveDealBidDueDate — the SIGNAL rule (pure, flag-free)", () => {
  const LANDED = "2026-09-01";
  const LANDED_INSTANT = new Date(`${LANDED}T00:00:00.000Z`);
  const LEAD = "2026-06-01";
  const STALE_DEAL = new Date("2026-07-01T00:00:00.000Z");
  /** The 0223 provenance stamp: the sync WROTE the column. Absent => a coincidence, never an override. */
  const STAMP = new Date("2026-08-01T09:00:00.000Z");
  /** The project the stamp was earned on == the project the deal is on now. */
  const PROJECT = { bidDueDateBidBoardProjectNumber: "DFW-1-00001-aa", bidBoardProjectNumber: "DFW-1-00001-aa" };

  // ★ The rule the whole design rests on. Prove it once, unmistakably: the mirror's VALUE is never what
  // comes back. When the signal fires, the value returned is the DEAL COLUMN; all the signal decides is
  // that it outranks the lead.
  it("NEVER returns the mirror's value — the mirror only decides whether the deal column beats the lead", () => {
    const mirrorOnly = resolveDealBidDueDate({
      bidBoardDueDate: LANDED,
      hasSourceLead: true,
      leadBidDueDate: LEAD,
      // The write-through has NOT run: the column still holds a different day.
      dealBidDueDate: STALE_DEAL,
    });
    expect(mirrorOnly.day).not.toBe(LANDED);
    expect(mirrorOnly).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  it("signal FIRES when the deal column matches the mirror: the DEAL COLUMN beats the lead", () => {
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: LANDED,
      hasSourceLead: true,
      leadBidDueDate: LEAD,
      dealBidDueDate: LANDED_INSTANT,
      bidDueDateFromBidBoardAt: STAMP,
      ...PROJECT,
    });
    // `raw` is the deal column's stored instant, NOT the mirror's date-only string.
    expect(resolved).toEqual({ day: LANDED, raw: LANDED_INSTANT, source: "bid_board" });
  });

  it("compares CALENDAR DAYS, so a UTC-midnight column matches a date-only mirror", () => {
    // The column is a timestamptz at UTC midnight and the mirror is a date. Comparing instants (or raw
    // strings) would never match and the signal would be dead on arrival.
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: `${LANDED}T00:00:00.000Z`,
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      ...PROJECT,
      }).source
    ).toBe("bid_board");
    // …and a legacy non-midnight instant on the same DAY still counts as landed, matching the
    // write-through's own day-based guard.
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: new Date(`${LANDED}T14:30:00.000Z`),
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      ...PROJECT,
      }).source
    ).toBe("bid_board");
  });

  // ★ H1. buildBidBoardDetachUpdate does NOT clear bid_board_due_date, so a detached deal can carry a
  // mirror that still matches its column. Without the explicit guard it would keep sourcing its bid due
  // date — and its hold horizon, at-risk verdict and effective value — from the board it was severed from.
  it("DETACHED: the override is refused even when the column and the mirror agree", () => {
    const resolved = resolveDealBidDueDate({
      bidBoardDueDate: LANDED,
      bidBoardDetachedAt: new Date("2026-07-20T12:00:00.000Z"),
      hasSourceLead: true,
      leadBidDueDate: LEAD,
      dealBidDueDate: LANDED_INSTANT,
      bidDueDateFromBidBoardAt: STAMP,
      ...PROJECT,
    });
    expect(resolved).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  it("a lead-backed deal's CLEARED lead value still beats a stale deal column", () => {
    // The lead OWNS this field (DEAL_FIELD_OWNERSHIP.bidDueDate === "lead"); the deal column is only a
    // compatibility snapshot. Falling back to it here would mask a deliberate clear — the documented
    // behaviour of both existing read sites, and a regression this test exists to prevent.
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: null,
        dealBidDueDate: STALE_DEAL,
      })
    ).toEqual({ day: null, raw: null, source: "lead" });
  });

  it("…but a CLEARED lead loses once the Bid Board's date has landed in the column", () => {
    // This is the lead-masking fix, and the only case the read change exists for.
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: null,
        dealBidDueDate: LANDED_INSTANT,
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      ...PROJECT,
      })
    ).toEqual({ day: LANDED, raw: LANDED_INSTANT, source: "bid_board" });
  });

  it("a deal with NO source lead returns its own column either way — the signal changes nothing", () => {
    // Only a lead-backed deal can be affected at all: with no lead there is nothing for the deal column to
    // outrank, so the signal is inert by construction.
    const landed = resolveDealBidDueDate({
      bidBoardDueDate: LANDED,
      hasSourceLead: false,
      dealBidDueDate: LANDED_INSTANT,
      bidDueDateFromBidBoardAt: STAMP,
      ...PROJECT,
    });
    const notLanded = resolveDealBidDueDate({
      bidBoardDueDate: LANDED,
      hasSourceLead: false,
      dealBidDueDate: STALE_DEAL,
    });
    expect(landed.raw).toBe(LANDED_INSTANT);
    expect(notLanded.raw).toBe(STALE_DEAL);
    // `.day` is normalized for the resolved-fields consumers; `.raw` preserves the stored shape so the
    // deal-detail response keeps publishing the same bytes it always has.
    expect(notLanded.day).toBe("2026-07-01");
    expect(notLanded.source).toBe("deal");
  });

  it("a NULL deal column can never fire the signal, whatever the mirror says", () => {
    // "Landed" means the value is IN the column every SQL surface reads. A null column has received
    // nothing, so the legacy answer stands and TS cannot drift ahead of SQL.
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: null,
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  it("returns null (not a fabricated date) when every source is empty", () => {
    expect(resolveDealBidDueDate({ hasSourceLead: false })).toEqual({ day: null, raw: null, source: "deal" });
    expect(resolveDealBidDueDate({ hasSourceLead: true })).toEqual({ day: null, raw: null, source: "lead" });
  });

  it("an unparseable mirror leaves the legacy chain intact rather than blanking the date", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: "garbage",
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: LANDED_INSTANT,
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      ...PROJECT,
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  // ★ THE COINCIDENCE. `bid_board_due_date` has been populated on prod for MONTHS, so a deal whose
  // pre-existing bid_due_date merely shares the board's calendar day looks identical to a landed one on
  // the dates alone. Without the provenance stamp the override would fire for it the instant the flag was
  // flipped — no sync having run — changing a lead-backed deal's displayed date and, in a genuine
  // estimating stage, its hold verdict and reported value. Provenance is what makes "the flip changes
  // nothing until a sync writes" true.
  it("REFUSES the override on a coincidental day match with no provenance stamp", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: LANDED_INSTANT,
        // No bidDueDateFromBidBoardAt: the sync never wrote this column.
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  // The other half: the stamp alone must not latch the override on. A rep or the lead correcting the date
  // moves the column off the board's day and revokes it — which is why the stamp is never cleared and the
  // day check exists.
  // ★ P1 — RETIRED PROJECT. A deal is detached and later linked to a genuinely NEW Bid Board project. The
  // link callback clears bid_board_detached_at but preserves the dates AND the timestamp stamp, so without
  // an identity check the override would fire again on provenance earned from a project this deal is no
  // longer on — the detached-deal leak returning where the detach guard cannot see it.
  it("REFUSES the override when the stamp was earned on a DIFFERENT Bid Board project", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: LANDED_INSTANT,
        bidDueDateFromBidBoardAt: STAMP,
        bidDueDateBidBoardProjectNumber: "DFW-9-RETIRED-zz",
        bidBoardProjectNumber: "DFW-1-00001-aa",
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  // The detach itself NULLs bid_board_project_number, so the identity check catches a severed deal too —
  // and must not read NULL == NULL as a match, which would re-admit exactly that case.
  it("REFUSES the override when the deal is on no project at all (NULL is not an identity)", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: LANDED_INSTANT,
        bidDueDateFromBidBoardAt: STAMP,
        bidDueDateBidBoardProjectNumber: null,
        bidBoardProjectNumber: null,
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });

  it("ALLOWS the override after a re-link to the SAME project — the stamp is still honest there", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        dealBidDueDate: LANDED_INSTANT,
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      }).source
    ).toBe("bid_board");
  });

  it("REVOKES the override when a later edit moves the column off the board's day", () => {
    expect(
      resolveDealBidDueDate({
        bidBoardDueDate: LANDED,
        hasSourceLead: true,
        leadBidDueDate: LEAD,
        // The sync wrote it once (stamp present), but someone has since corrected the date.
        dealBidDueDate: STALE_DEAL,
        bidDueDateFromBidBoardAt: STAMP,
        ...PROJECT,
      ...PROJECT,
      })
    ).toEqual({ day: LEAD, raw: LEAD, source: "lead" });
  });
});

describe("resolveDealBidDueDateForRead — the flag gate", () => {
  // The deal column ALREADY carries the Bid Board's date (the write-through has run) and the lead
  // disagrees — the only shape where the flag changes an answer.
  const input = {
    bidBoardDueDate: "2026-09-01",
    hasSourceLead: true,
    leadBidDueDate: "2026-06-01",
    dealBidDueDate: new Date("2026-09-01T00:00:00.000Z"),
    bidDueDateFromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
    bidDueDateBidBoardProjectNumber: "DFW-1-00001-aa",
    bidBoardProjectNumber: "DFW-1-00001-aa",
  };

  it("flag ON: the landed deal column beats the stale lead", () => {
    expect(resolveDealBidDueDateForRead(input, FLAG_ON)).toEqual({
      day: "2026-09-01",
      raw: input.dealBidDueDate,
      source: "bid_board",
    });
  });

  // ★ THE PARITY TEST. Flag off must erase the SIGNAL entirely, so the answer is indistinguishable from a
  // deal whose mirror column holds nothing.
  it("flag OFF: identical to the same input with NO mirror value at all", () => {
    expect(resolveDealBidDueDateForRead(input, FLAG_OFF)).toEqual(
      resolveDealBidDueDate({ ...input, bidBoardDueDate: null })
    );
    expect(resolveDealBidDueDateForRead(input, FLAG_OFF)).toEqual({
      day: "2026-06-01",
      raw: "2026-06-01",
      source: "lead",
    });
  });

  it("flag OFF for a deal with no lead: the deal's own column, unchanged", () => {
    const dealValue = new Date("2026-07-01T00:00:00.000Z");
    expect(
      resolveDealBidDueDateForRead(
        {
          bidBoardDueDate: "2026-09-01",
          hasSourceLead: false,
          dealBidDueDate: dealValue,
          bidDueDateFromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
        },
        FLAG_OFF
      )
    ).toEqual({ day: "2026-07-01", raw: dealValue, source: "deal" });
  });

  it("treats any value other than the exact string \"true\" as OFF", () => {
    for (const value of ["false", "1", "TRUE", "yes", ""]) {
      expect(
        resolveDealBidDueDateForRead(input, { BID_BOARD_DUE_DATE_READBACK: value } as NodeJS.ProcessEnv).source
      ).toBe("lead");
    }
  });

  // The property that makes the flip itself safe: the write-through is gated by the SAME flag, so at flip
  // time no deal's column has been rewritten and the read override fires for nobody. The read side follows
  // the write side instead of racing ahead of it — which is also what keeps these three TS read sites from
  // drifting away from holdHorizonDateSql and its ~50 SQL consumers.
  it("is INERT at flip time — no deal carries the provenance stamp, so the override fires for nobody", () => {
    // Deliberately the COINCIDENCE shape: dates that already agree, which is the state prod is in for some
    // deals today. At flip time the write-through has never run, so no stamp exists, and flag ON must
    // return exactly what flag OFF returns.
    const notYetWritten = {
      bidBoardDueDate: "2026-09-01",
      hasSourceLead: true,
      leadBidDueDate: "2026-06-01",
      dealBidDueDate: new Date("2026-09-01T00:00:00.000Z"),
    };
    expect(resolveDealBidDueDateForRead(notYetWritten, FLAG_ON)).toEqual(
      resolveDealBidDueDateForRead(notYetWritten, FLAG_OFF)
    );
  });
});

/**
 * The RFP payload is the one read site whose flag-OFF branch is NOT the shared precedence: it has always
 * preferred the deal's own column over the lead's, and that stays true until the flag flips because the
 * value leaves the CRM for SyncHub and lands in the Procore project's Due Date field.
 */
describe("resolveRfpPayloadDueDates — the gated correction, and the rejected-mirror leak", () => {
  const LEAD = "2026-09-15";
  const DEAL_COLUMN = new Date("2026-08-01T00:00:00.000Z");
  const MIRROR = "2026-12-24";

  it("flag OFF: the DEAL column wins over the lead, and the mirror passes through untouched", () => {
    // Both halves are legacy: the ordering AND the mirror, which buildNormalizedRfpRequestBody uses as its
    // `dueDate` fallback. If this ever returns the lead, someone has "simplified" the helper into
    // resolveDealBidDueDateForRead and silently changed what the CRM sends Procore.
    expect(
      resolveRfpPayloadDueDates(
        { bidBoardDueDate: MIRROR, hasSourceLead: true, leadBidDueDate: LEAD, dealBidDueDate: DEAL_COLUMN },
        FLAG_OFF
      )
    ).toEqual({ bidDueDate: DEAL_COLUMN, bidBoardDueDate: MIRROR });
  });

  it("flag OFF: falls back to the lead only when the deal column is empty — also legacy", () => {
    expect(
      resolveRfpPayloadDueDates(
        { bidBoardDueDate: null, hasSourceLead: true, leadBidDueDate: LEAD, dealBidDueDate: null },
        FLAG_OFF
      )
    ).toEqual({ bidDueDate: LEAD, bidBoardDueDate: null });
  });

  it("flag ON: the precedence CORRECTION lands — the lead beats an un-landed deal column", () => {
    expect(
      resolveRfpPayloadDueDates(
        { bidBoardDueDate: null, hasSourceLead: true, leadBidDueDate: LEAD, dealBidDueDate: DEAL_COLUMN },
        FLAG_ON
      ).bidDueDate
    ).toBe(LEAD);
  });

  it("flag ON: once the board's date has LANDED in the column, that column beats the lead", () => {
    const landed = new Date(`${MIRROR}T00:00:00.000Z`);
    expect(
      resolveRfpPayloadDueDates(
        {
          bidBoardDueDate: MIRROR,
          hasSourceLead: true,
          leadBidDueDate: LEAD,
          dealBidDueDate: landed,
          bidDueDateFromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
          bidDueDateBidBoardProjectNumber: "DFW-1-00001-aa",
          bidBoardProjectNumber: "DFW-1-00001-aa",
        },
        FLAG_ON
      )
    ).toEqual({ bidDueDate: landed, bidBoardDueDate: null });
  });

  // ★ THE LEAK. buildNormalizedRfpRequestBody computes
  // `dueDate: cleanIso(bidDueDate) ?? cleanIso(bidBoardDueDate)`. A lead-backed deal with a CLEARED lead
  // value and an UNLANDED mirror resolves to null — the rep deliberately has no bid date — and if the
  // mirror were still passed, the fallback would send the board's rejected date to SyncHub, where it is
  // typed into the Procore Bid Board project's Due Date field. A value the resolver refused must not come
  // back in through a side door.
  it("flag ON: a REJECTED mirror is withheld, so the payload's fallback cannot resurrect it", () => {
    const resolved = resolveRfpPayloadDueDates(
      { bidBoardDueDate: MIRROR, hasSourceLead: true, leadBidDueDate: null, dealBidDueDate: DEAL_COLUMN },
      FLAG_ON
    );
    expect(resolved.bidDueDate).toBeNull();
    expect(resolved.bidBoardDueDate).toBeNull();
  });

  it("flag ON: a DETACHED deal's mirror is withheld too", () => {
    const landed = new Date(`${MIRROR}T00:00:00.000Z`);
    const resolved = resolveRfpPayloadDueDates(
      {
        bidBoardDueDate: MIRROR,
        bidBoardDetachedAt: new Date("2026-07-20T12:00:00.000Z"),
        hasSourceLead: true,
        leadBidDueDate: null,
        dealBidDueDate: landed,
        bidDueDateFromBidBoardAt: new Date("2026-08-01T09:00:00.000Z"),
        bidDueDateBidBoardProjectNumber: "DFW-1-00001-aa",
        bidBoardProjectNumber: "DFW-1-00001-aa",
      },
      FLAG_ON
    );
    expect(resolved.bidDueDate).toBeNull();
    expect(resolved.bidBoardDueDate).toBeNull();
  });

  it("returns the winning value AS STORED — the flag changes the source, not the shape", () => {
    // cleanIso normalizes a Date and a date-only string to the same ISO instant, so a deal-column win must
    // not be silently truncated to a calendar day on one side of the flag only.
    const input = { bidBoardDueDate: null, hasSourceLead: false, dealBidDueDate: DEAL_COLUMN };
    expect(resolveRfpPayloadDueDates(input, FLAG_OFF).bidDueDate).toBe(DEAL_COLUMN);
    expect(resolveRfpPayloadDueDates(input, FLAG_ON).bidDueDate).toBe(DEAL_COLUMN);
  });

  it("a deal with no lead and no mirror is identical on both sides of the flag", () => {
    const input = { hasSourceLead: false, dealBidDueDate: DEAL_COLUMN };
    expect(resolveRfpPayloadDueDates(input, FLAG_OFF)).toEqual(resolveRfpPayloadDueDates(input, FLAG_ON));
  });
});
