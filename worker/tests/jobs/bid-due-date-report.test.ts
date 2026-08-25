import { describe, expect, it, vi } from "vitest";
// node-cron's OWN matcher, not a hand-rolled Intl formatter. A test that builds its own
// Intl.DateTimeFormat and checks that 17 === 17 is green whether the source says "0 17 * * 3",
// "0 17 * * 4", or omits `timezone` entirely — it tests Intl, not the schedule. Driving the real
// TimeMatcher with the module's OWN exported constant is the only thing that fails when the cron string
// changes, which is the whole reason BID_DUE_REPORT_CRON is exported rather than written inline in
// worker/src/index.ts (that file boots the worker on import and cannot be loaded from a test).
import TimeMatcher from "node-cron/src/time-matcher.js";
import {
  BID_DUE_REPORT_CRON,
  BID_DUE_REPORT_TZ,
  bidDueReportWeekOf,
  buildBidDueDateReportEmail,
  runBidDueDateReport,
} from "../../src/jobs/bid-due-date-report.js";

// ---------------------------------------------------------------------------------------------------
// 1. The DST assertion
// ---------------------------------------------------------------------------------------------------

describe("BID_DUE_REPORT_CRON", () => {
  const matcher = () => new TimeMatcher(BID_DUE_REPORT_CRON, BID_DUE_REPORT_TZ);

  it("fires at 17:00 America/Chicago in CDT (UTC-5)", () => {
    // 2026-08-26 is a Wednesday. 22:00Z is 17:00 CDT.
    expect(matcher().match(new Date(Date.UTC(2026, 7, 26, 22, 0)))).toBe(true);
  });

  it("fires at 17:00 America/Chicago in CST (UTC-6) — the same wall clock, an hour later in UTC", () => {
    // 2026-12-02 is a Wednesday. 23:00Z is 17:00 CST. If the schedule carried a UTC hour instead of a
    // timezone, one of these two dates would be an hour out; that is the whole DST question.
    expect(matcher().match(new Date(Date.UTC(2026, 11, 2, 23, 0)))).toBe(true);
  });

  it("does NOT fire an hour either side of 17:00 local, in either offset", () => {
    const m = matcher();
    expect(m.match(new Date(Date.UTC(2026, 7, 26, 21, 0)))).toBe(false); // 16:00 CDT
    expect(m.match(new Date(Date.UTC(2026, 7, 26, 23, 0)))).toBe(false); // 18:00 CDT
    expect(m.match(new Date(Date.UTC(2026, 11, 2, 22, 0)))).toBe(false); // 16:00 CST
    expect(m.match(new Date(Date.UTC(2026, 11, 3, 0, 0)))).toBe(false); // 18:00 CST
  });

  it("does not fire on the other five weekdays", () => {
    const m = matcher();
    // Mon 24th, Tue 25th, Fri 28th, Sat 29th, Sun 30th of Aug 2026, all at 17:00 CDT.
    for (const day of [24, 25, 28, 29, 30]) {
      expect(m.match(new Date(Date.UTC(2026, 7, day, 22, 0)))).toBe(false);
    }
  });

  it("carries a Thursday CATCH-UP tick, because node-cron never recovers a missed weekly run", () => {
    // recoverMissedExecutions is undefined when only { timezone } is passed, and node-cron's scheduler
    // makes only the CURRENT second eligible. This process also runs pollJobs, PDF generation and Procore
    // syncs, so a >1s event-loop block across 17:00:00 drops the tick with no error and no receipt. A
    // daily job self-heals in 24h; this one would lose seven days. The (tenant_schema, week_of) receipt
    // makes the second tick free — it reads the receipt and returns.
    expect(matcher().match(new Date(Date.UTC(2026, 7, 27, 22, 0)))).toBe(true); // Thu 17:00 CDT
  });
});

describe("bidDueReportWeekOf", () => {
  it("anchors on the Wednesday ON OR BEFORE the run date, so the catch-up shares the receipt key", () => {
    // weeklyReportWeekOf() looks FORWARD to the next cadence day, which on the Thursday catch-up would
    // return the NEXT Wednesday — a different key, and therefore a second email for the same week.
    expect(bidDueReportWeekOf("2026-08-26")).toBe("2026-08-26"); // Wednesday, the primary tick
    expect(bidDueReportWeekOf("2026-08-27")).toBe("2026-08-26"); // Thursday, the catch-up
  });
});

// ---------------------------------------------------------------------------------------------------
// Stubs
// ---------------------------------------------------------------------------------------------------

const SCHEMA = "office_dfw";
// Wed 2026-08-26 17:00 CDT, and the Thursday catch-up tick that stands in for it when it is missed.
const WEDNESDAY_1700_CDT = new Date(Date.UTC(2026, 7, 26, 22, 0));
const THURSDAY_1700_CDT = new Date(Date.UTC(2026, 7, 27, 22, 0));
const OFFICE_ID = "11111111-1111-1111-1111-111111111111";
const ESTIMATING_STAGE_ID = "22222222-2222-2222-2222-222222222222";

type SendResult = { success: boolean; messageId: string | null; outcome: string };

function delivered(messageId = "msg-1"): SendResult {
  // `outcome` by hand: worker/tests/** is outside the typecheck program, so nothing would tell us this
  // stub is missing the field the job branches on.
  return { success: true, messageId, outcome: "delivered" };
}

interface StubOptions {
  rows?: Record<string, unknown>[];
  nullCount?: number;
  receipts?: Record<string, unknown>[];
  toRecipients?: { email: string }[];
  ccRecipients?: { email: string }[];
  offices?: { id: string; slug: string; name: string }[];
  /** Tenant schemas whose row query blows up, for the one-broken-office-must-not-cost-the-rest case. */
  failSchemas?: string[];
  /** The claim INSERT returns no row — another run got there first. */
  claimLost?: boolean;
  /** Office ids for which NO group member holds access, for the authorization-scoping case. */
  noAccessOffices?: string[];
}

/**
 * Routes each of the job's reads by a marker UNIQUE to it — a projected alias, not a table name.
 *
 * Table names are not discriminating here: the report query joins `public.pipeline_stage_config` and
 * contains the word "estimating", so a `pipeline_stage_config && estimating` branch (the obvious one)
 * swallows it and hands back the CTA's single stage row. That silently turns "no deals this week" into
 * "one deal", and every assertion in this file that counts send calls stays green while it happens.
 *
 * Anything unmatched THROWS rather than returning `[]`, so a query this job starts or stops issuing shows
 * up as a failure instead of an empty result that reads like a legitimate answer.
 */
function stubQuery(options: StubOptions = {}) {
  const calls: { sql: string; params?: unknown[] }[] = [];
  const query = vi.fn(async (sql: string, params?: unknown[]) => {
    calls.push({ sql, params });
    if (sql.includes("FROM public.offices")) {
      const rows = options.offices ?? [{ id: OFFICE_ID, slug: "dfw", name: "DFW" }];
      return { rows, rowCount: rows.length };
    }
    for (const schema of options.failSchemas ?? []) {
      if (sql.includes(`${schema}.deals`)) {
        throw new Error(`relation "${schema}.deals" does not exist`);
      }
    }
    if (sql.includes("INSERT INTO public.bid_due_date_report_receipts")) {
      // The CLAIM. rowCount 1 = this run won it; the `claimLost` option makes it lose to a concurrent run.
      return options.claimLost
        ? { rows: [], rowCount: 0 }
        : { rows: [{ tenant_schema: SCHEMA }], rowCount: 1 };
    }
    if (sql.includes("UPDATE public.bid_due_date_report_receipts")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("DELETE FROM public.bid_due_date_report_receipts")) {
      return { rows: [], rowCount: 1 };
    }
    if (sql.includes("FROM public.bid_due_date_report_receipts")) {
      return { rows: options.receipts ?? [], rowCount: (options.receipts ?? []).length };
    }
    if (sql.includes("public.notification_recipient_groups")) {
      const key = String(params?.[0] ?? "");
      const isCc = key.endsWith("_cc");
      const configured = isCc
        ? options.ccRecipients ?? [{ email: "adnaan.iqbal@gmail.com" }]
        : options.toRecipients ?? [{ email: "sidney@trockgc.com" }];
      // The GLOBAL pre-flight ("is anybody assigned at all") takes no office and ignores the per-office
      // filter; the per-office resolve is the one `noAccessOffices` can empty. Keeping them distinguishable
      // in the stub is what lets a test tell "nobody configured" from "nobody here can see this office".
      const isPreflight = !sql.includes("user_office_access");
      if (isPreflight) return { rows: configured, rowCount: configured.length };
      const officeId = String(params?.[1] ?? "");
      if (!isCc && (options.noAccessOffices ?? []).includes(officeId)) {
        return { rows: [], rowCount: 0 };
      }
      return { rows: configured, rowCount: configured.length };
    }
    if (sql.includes("AS missing_count")) {
      return { rows: [{ missing_count: options.nullCount ?? 0 }], rowCount: 1 };
    }
    if (sql.includes("AS bid_due_on")) {
      return { rows: options.rows ?? [], rowCount: (options.rows ?? []).length };
    }
    if (sql.includes("WHERE slug = 'estimating'")) {
      return { rows: [{ id: ESTIMATING_STAGE_ID }], rowCount: 1 };
    }
    throw new Error(`Unstubbed query: ${sql}`);
  });
  return { query, calls };
}

function deps(options: StubOptions & { sendEmail?: ReturnType<typeof vi.fn>; now?: Date } = {}) {
  const { query, calls } = stubQuery(options);
  const sendEmail = options.sendEmail ?? vi.fn(async () => delivered());
  const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const release = vi.fn(async () => undefined);
  return {
    query,
    calls,
    sendEmail,
    logger,
    release,
    deps: {
      query,
      sendEmail,
      logger,
      acquireLock: vi.fn(async () => release),
      env: { NODE_ENV: "test", FRONTEND_URL: "https://trockcrm.com" } as NodeJS.ProcessEnv,
      now: options.now ?? WEDNESDAY_1700_CDT,
    },
  };
}

const ROW = {
  id: "d1",
  name: "Riverside Medical Center",
  deal_number: "DFW-1-24118",
  project_number: "24-118",
  bid_due_on: "2026-09-04",
  value: "1200000",
  rep_name: "James Helms",
};

// ---------------------------------------------------------------------------------------------------
// 7. Cc
// ---------------------------------------------------------------------------------------------------

describe("runBidDueDateReport recipients", () => {
  it("sends to the report group and cc's the cc group", async () => {
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    const [to, , , options] = h.sendEmail.mock.calls[0];
    expect(to).toEqual(["sidney@trockgc.com"]);
    expect(options.cc).toEqual(["adnaan.iqbal@gmail.com"]);
    // EMAIL_OVERRIDE_RECIPIENT discards cc entirely and SYSTEM_EMAIL_BCC is live on every system email,
    // so this assertion is the only place the cc is observable until the override is unset in prod.
    expect(options.bcc).toBeUndefined();
  });

  it("keys idempotency on the same Wednesday the receipt is keyed on", async () => {
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail.mock.calls[0][3].idempotencyKey).toBe(`bid-due-report-${SCHEMA}-2026-08-26`);
  });

  // C1, AND THE GUARD OF RECORD for "this report has no recipients".
  //
  // Migration 0236 only WARNS about an empty group — deliberately, because the Dockerfile CMD is
  // `runner.js && index.js` and the runner exits non-zero, so a raising migration crash-loops the API
  // container and takes the CRM down over a mailing list. That makes THIS the assertion that has to hold:
  // every property below is load-bearing, because nothing upstream will stop an unseeded group reaching
  // production.
  //
  // The resolver used to return [] for any key but lead_due_diligence and the callers logged and moved on,
  // so this report would have mailed nobody, silently, every Wednesday, forever.
  it("THROWS when the report group resolves to nobody, and writes no receipt", async () => {
    const h = deps({ rows: [ROW], toRecipients: [] });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow(/bid_due_date_report/);
    // 1. Nothing was sent. `to: []` would otherwise reach Resend and come back as a rejection that reads
    //    like a delivery blip rather than a configuration fault.
    expect(h.sendEmail).not.toHaveBeenCalled();
    // 2. It is an ERROR, not a warn. A warn is what the old code path did, and it is why the failure was
    //    invisible.
    expect(h.logger.error).toHaveBeenCalled();
    // 3. NO receipt — so the next tick retries rather than recording a week that never went out.
    expect(
      h.calls.some((c) => c.sql.includes("INSERT INTO public.bid_due_date_report_receipts")),
    ).toBe(false);
    // 4. It throws BEFORE any office is read. This is a configuration fault, not an office's fault, and
    //    resolving recipients per office would report the same fault N times while letting office 1's
    //    throw hide offices 2..N entirely.
    expect(h.calls.some((c) => c.sql.includes("FROM public.offices"))).toBe(false);
    // 5. The advisory lock is released. A throw that strands the lock makes every later tick — including
    //    the Thursday catch-up and next week's run — a silent no-op, which converts a configuration fault
    //    into a permanently dead job.
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("still sends when the CC group is empty — an unwatched report is not an undelivered one", async () => {
    const h = deps({ rows: [ROW], ccRecipients: [] });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][3].cc).toBeUndefined();
    expect(h.logger.warn).toHaveBeenCalled();
  });
});

describe("runBidDueDateReport Bid Board readback wiring", () => {
  it("threads an enabled readback flag to BOTH the row query and the footer count", async () => {
    // The PGlite suite proves the SQL's behavior. This small run-level guard proves the production seam:
    // `deps.env` is read once and reaches both callers, rather than a correct expression sitting behind an
    // option that the actual cron never supplies.
    const h = deps({ rows: [ROW] });
    h.deps.env.BID_BOARD_DUE_DATE_READBACK = "true";
    await runBidDueDateReport(h.deps);

    const effectiveDateQueries = h.calls.filter(
      (call) => call.sql.includes("AS bid_due_on") || call.sql.includes("AS missing_count")
    );
    expect(effectiveDateQueries).toHaveLength(2);
    for (const { sql } of effectiveDateQueries) {
      expect(sql).toContain("d.bid_board_detached_at IS NULL");
      expect(sql).toContain("d.bid_due_date_from_bid_board_at IS NOT NULL");
      expect(sql).toContain("d.bid_due_date_bid_board_project_number = d.bid_board_project_number");
      expect(sql).toContain("d.bid_board_due_date IS NOT NULL");
      expect(sql).toContain("(d.bid_due_date AT TIME ZONE 'UTC')::date = d.bid_board_due_date");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// 8, 9, 10. Receipts and outcomes
// ---------------------------------------------------------------------------------------------------

describe("runBidDueDateReport exactly-once", () => {
  it("does not re-send when a receipt for this week already exists", async () => {
    const h = deps({ rows: [ROW], receipts: [{ resend_message_id: "msg-0", week_of: "2026-08-26" }] });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("claims the week under (tenant_schema, week_of)", async () => {
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    const inserts = h.calls.filter((c) =>
      c.sql.includes("INSERT INTO public.bid_due_date_report_receipts"),
    );
    expect(inserts).toHaveLength(1);
    expect(inserts[0].params).toContain(SCHEMA);
    expect(inserts[0].params).toContain("2026-08-26");
  });

  // `rejected` and `unknown` are NOT the same failure and must not get the same handling.
  //
  //   rejected — the provider positively refused and created NOTHING. Re-sending is safe, so the claim is
  //              DELETED and the catch-up genuinely retries.
  //   unknown  — resend@6 wraps its whole fetch in a try/catch, so a socket hang-up, a 5xx and a gateway
  //              timeout all arrive as an ordinary error result. The message MAY have been delivered.
  //              Re-sending risks a duplicate, so the claim STAYS, unstamped, and the catch-up declines.
  //
  // The catch-up tick is what makes this consequential rather than academic: without it, an ambiguous
  // failure sat until next Wednesday. With it, the provider is called again 24 hours later.
  it("DELETES the claim on 'rejected' — nothing was sent, so the catch-up must retry", async () => {
    const sendEmail = vi.fn(async () => ({ success: false, messageId: null, outcome: "rejected" }));
    const h = deps({ rows: [ROW], sendEmail });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow();
    expect(h.calls.some((c) => c.sql.includes("DELETE FROM public.bid_due_date_report_receipts"))).toBe(true);
    expect(h.calls.some((c) => c.sql.includes("SET sent_at"))).toBe(false);
  });

  it("KEEPS the claim unstamped on 'unknown' — the mail may already be in the inbox", async () => {
    const sendEmail = vi.fn(async () => ({ success: false, messageId: null, outcome: "unknown" }));
    const h = deps({ rows: [ROW], sendEmail });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow();
    expect(h.calls.some((c) => c.sql.includes("DELETE FROM public.bid_due_date_report_receipts"))).toBe(false);
    // Stamped as unconfirmed rather than as sent, so an operator can tell the two apart.
    const marked = h.calls.find((c) => c.sql.includes("UPDATE public.bid_due_date_report_receipts"));
    expect(marked?.params).toContain("unknown");
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("the catch-up DECLINES after an 'unknown', instead of calling the provider again", async () => {
    // The end-to-end consequence, and the reason the claim exists at all.
    const h = deps({
      rows: [ROW],
      receipts: [{ week_of: "2026-08-26", sent_at: null, outcome: "unknown", resend_message_id: null }],
      now: THURSDAY_1700_CDT,
    });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail).not.toHaveBeenCalled();
  });

  it("claims the week BEFORE calling the provider, not after", async () => {
    // A claim written only after a successful send cannot protect anything: the ambiguous outcome is
    // precisely the case where the write never happens.
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    const claimAt = h.calls.findIndex((c) =>
      c.sql.includes("INSERT INTO public.bid_due_date_report_receipts"),
    );
    const stampAt = h.calls.findIndex((c) => c.sql.includes("SET sent_at"));
    expect(claimAt).toBeGreaterThanOrEqual(0);
    expect(stampAt).toBeGreaterThan(claimAt);
  });

  it("declines when a concurrent run wins the claim", async () => {
    // The advisory lock already serializes runs, so this is the backstop rather than the primary guard —
    // but the claim is what makes the guarantee atomic rather than dependent on the lock holding.
    const h = deps({ rows: [ROW], claimLost: true });
    const summary = await runBidDueDateReport(h.deps);
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(summary.skipped).toBe(1);
  });

  it("stamps sent_at only on 'delivered'", async () => {
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    const stamp = h.calls.find((c) => c.sql.includes("SET sent_at"));
    expect(stamp?.params).toContain("msg-1");
  });

  it("sends an EMPTY report rather than nothing — a silent week reads as a broken job", async () => {
    const h = deps({ rows: [] });
    await runBidDueDateReport(h.deps);
    expect(h.sendEmail).toHaveBeenCalledTimes(1);
    expect(h.sendEmail.mock.calls[0][2]).toContain("No estimating deals have a bid due date");
  });

  // C5, asserted on the URL the RUN actually builds. The buildBidDueDateReportEmail test below takes its
  // ctaUrl as an argument, so on its own it proves the renderer and nothing about the resolver — pointing
  // resolveEstimatingCtaUrl at /reports/operations/estimator-pipeline left it green.
  it("builds a CTA the recipient can open: the estimating stage page, scope=all, office-scoped", async () => {
    const h = deps({ rows: [ROW] });
    await runBidDueDateReport(h.deps);
    const html = h.sendEmail.mock.calls[0][2];
    expect(html).toContain(`/deals/stages/${ESTIMATING_STAGE_ID}?scope=all&amp;officeId=${OFFICE_ID}`);
    // The obvious CTA is RequireRole admin|director, and the primary recipient is a rep.
    expect(html).not.toContain("/reports/operations/estimator-pipeline");
    // scope=mine is the stage page's default, and 0222's header records that Sidney owns 0 deals — so the
    // default renders the one person this report is for an empty board.
    expect(html).not.toContain("scope=mine");
  });

  it("degrades to /deals but KEEPS scope=all — the fallback has the same empty-board trap", async () => {
    // /deals defaults a rep to scope=mine exactly as the stage page does, and the configured estimator
    // owns no deals. Dropping scope=all here reproduces the C5 failure in the degraded path, on the very
    // run where something already went wrong.
    const h = deps({ rows: [ROW] });
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("WHERE slug = 'estimating'")) return { rows: [], rowCount: 0 };
      return h.query(sql, params);
    });
    await runBidDueDateReport({ ...h.deps, query });
    const html = h.sendEmail.mock.calls[0][2];
    expect(html).toContain("scope=all");
    expect(html).not.toContain("scope=mine");
  });

  it("degrades to /deals when the estimating stage id cannot be resolved", async () => {
    const h = deps({ rows: [ROW] });
    const query = vi.fn(async (sql: string, params?: unknown[]) => {
      if (sql.includes("WHERE slug = 'estimating'")) return { rows: [], rowCount: 0 };
      return h.query(sql, params);
    });
    await runBidDueDateReport({ ...h.deps, query });
    const html = h.sendEmail.mock.calls[0][2];
    expect(html).toContain(`/deals?scope=all&amp;officeId=${OFFICE_ID}`);
    expect(html).not.toContain("/deals/stages/");
  });

  it("skips the whole run when another replica holds the advisory lock", async () => {
    const h = deps({ rows: [ROW] });
    const summary = await runBidDueDateReport({ ...h.deps, acquireLock: vi.fn(async () => null) });
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(summary.offices).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------
// The catch-up tick must be INDISTINGUISHABLE from the run it replaces
// ---------------------------------------------------------------------------------------------------

describe("Wednesday run vs Thursday catch-up", () => {
  // A row whose SECTION depends on the anchor: 2026-09-02 is weekOf+7 (NEXT 30 DAYS from Wednesday) but
  // Thursday+6 (THIS WEEK if the body is computed from the run date). And ROW, at 2026-09-04, changes its
  // relative-days text by one day. Between them, any anchor slip shows up in both html and text.
  const NEXT_WEEK_ROW = {
    id: "d2",
    name: "Next Wednesday Bid",
    deal_number: "DFW-1-99",
    project_number: "24-199",
    bid_due_on: "2026-09-02",
    value: "500000",
    rep_name: "Sidney Gibson",
  };

  async function emailFrom(now: Date) {
    const h = deps({ rows: [ROW, NEXT_WEEK_ROW], now });
    await runBidDueDateReport(h.deps);
    const [, subject, html, options] = h.sendEmail.mock.calls[0];
    return { subject, html, text: options.text, idempotencyKey: options.idempotencyKey, calls: h.calls };
  }

  /**
   * The text body renders each row as `  cell  ·  cell  ·  …`, so it parses back into columns. Column 1 is
   * the relative-date PROSE; every other column, and the section headings, are the report's DATA.
   */
  function bodyOf(text: string) {
    const headings: string[] = [];
    const data: string[][] = [];
    const prose: string[] = [];
    for (const line of text.split("\n")) {
      if (/^[A-Z0-9 ]+\(\d+\)$/.test(line.trim())) headings.push(line.trim());
      if (!line.startsWith("  ")) continue;
      const cells = line.trim().split("  ·  ");
      if (cells.length < 6) continue;
      prose.push(cells[1]);
      data.push([cells[0], ...cells.slice(2)]);
    }
    return { headings, data, prose };
  }

  // TWO ANCHORS, and they are not the same one.
  //
  // `weekOf` decides WHAT THE REPORT CONTAINS — the SQL window, the sectioning, the subject, the receipt.
  // The delivery date decides HOW A HUMAN READS IT: the reader's "today" is the day the mail lands in front
  // of them, not the day the report is about. Anchoring the prose to weekOf too would tell a Thursday
  // reader that a bid due Wednesday is due "today", which is the one thing this report exists to get right.
  it("keeps the DATA identical across both ticks — same sections, same rows, same order", async () => {
    const wednesday = bodyOf((await emailFrom(WEDNESDAY_1700_CDT)).text);
    const thursday = bodyOf((await emailFrom(THURSDAY_1700_CDT)).text);
    expect(thursday.headings).toEqual(wednesday.headings);
    expect(thursday.data).toEqual(wednesday.data);
    expect(thursday.data.length).toBeGreaterThan(0);
  });

  it("keeps the subject and the receipt key identical — both name the same Wednesday", async () => {
    const wednesday = await emailFrom(WEDNESDAY_1700_CDT);
    const thursday = await emailFrom(THURSDAY_1700_CDT);
    expect(thursday.subject).toBe(wednesday.subject);
    expect(thursday.idempotencyKey).toBe(wednesday.idempotencyKey);
  });

  it("moves ONLY the relative-date prose, by exactly the one day that separates the ticks", async () => {
    const wednesday = bodyOf((await emailFrom(WEDNESDAY_1700_CDT)).text);
    const thursday = bodyOf((await emailFrom(THURSDAY_1700_CDT)).text);
    // Sep 4 then Sep 2 (the stub returns fixture order; the real query sorts ascending), read from
    // Wednesday the 26th and then from Thursday the 27th.
    expect(wednesday.prose).toEqual(["in 9 days", "in 7 days"]);
    expect(thursday.prose).toEqual(["in 8 days", "in 6 days"]);
  });

  it("says 'today' on the day the mail actually lands, not on the day the report is about", async () => {
    // The whole point of the split, stated as the case that motivated it: a bid due Wednesday, in an email
    // delivered Thursday, is not due today.
    const dueWednesday = {
      ...ROW,
      id: "d3",
      name: "Due On WeekOf",
      bid_due_on: "2026-08-26",
    };
    const onWednesday = deps({ rows: [dueWednesday], now: WEDNESDAY_1700_CDT });
    await runBidDueDateReport(onWednesday.deps);
    const onThursday = deps({ rows: [dueWednesday], now: THURSDAY_1700_CDT });
    await runBidDueDateReport(onThursday.deps);
    expect(onWednesday.sendEmail.mock.calls[0][3].text).toContain("today");
    expect(onThursday.sendEmail.mock.calls[0][3].text).toContain("yesterday");
    expect(onThursday.sendEmail.mock.calls[0][3].text).not.toContain("  ·  today  ·  ");
    // ...and it is still filed under THIS WEEK on both, because SECTIONING is anchored on weekOf. The row
    // moves in prose only; a reader gets the right urgency without the two emails disagreeing about the
    // week's contents.
    expect(onThursday.sendEmail.mock.calls[0][3].text).toContain("THIS WEEK (1)");
    expect(onWednesday.sendEmail.mock.calls[0][3].text).toContain("THIS WEEK (1)");
  });

  it("queries the SAME window on both ticks — the anchor reaches the SQL, not just the rendering", async () => {
    const wednesday = await emailFrom(WEDNESDAY_1700_CDT);
    const thursday = await emailFrom(THURSDAY_1700_CDT);
    const windowParams = (calls: { sql: string; params?: unknown[] }[]) =>
      calls.find((call) => call.sql.includes("AS bid_due_on"))?.params;
    expect(windowParams(wednesday.calls)?.[0]).toBe("2026-08-26");
    expect(windowParams(thursday.calls)?.[0]).toBe("2026-08-26");
  });

  it("files the weekOf+7 deal under NEXT 30 DAYS on BOTH ticks, never THIS WEEK", async () => {
    for (const now of [WEDNESDAY_1700_CDT, THURSDAY_1700_CDT]) {
      const email = await emailFrom(now);
      const thisWeek = email.text.split("THIS WEEK")[1] ?? "";
      expect(thisWeek).not.toContain("Next Wednesday Bid");
      expect(email.text).toContain("NEXT 30 DAYS");
    }
  });
});

// ---------------------------------------------------------------------------------------------------
// One broken office must not cost every other office its week
// ---------------------------------------------------------------------------------------------------

describe("runBidDueDateReport per-office isolation", () => {
  const THREE_OFFICES = [
    { id: "office-a", slug: "aaa", name: "A" },
    { id: "office-b", slug: "bbb", name: "B" },
    { id: "office-c", slug: "ccc", name: "C" },
  ];

  it("FAILS an office whose recipients cannot see it, rather than mailing them its pipeline", async () => {
    // The P1, at the run level. Recipient assignments are global; office access is not. An office whose
    // group resolves to nobody must fail loudly — the alternative that looks tidy, skipping it quietly, is
    // an office whose report silently never arrives.
    const h = deps({
      rows: [ROW],
      offices: THREE_OFFICES,
      noAccessOffices: ["office-b"],
    });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow(/1 of 3/);
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    // The office-scoping fault must reach the log, not just the failure count — the per-office catch
    // carries it in the `err` field, so an operator can tell it from a tenant-query blowup.
    const logged = h.logger.error.mock.calls
      .map(([, context]) => String((context as { err?: unknown })?.err ?? ""))
      .join("\n");
    expect(logged).toContain("has access to office");
    expect(logged).toContain("user_office_access");
  });

  it("resolves recipients PER OFFICE, passing that office's id to the lookup", async () => {
    const h = deps({ rows: [ROW], offices: THREE_OFFICES });
    await runBidDueDateReport(h.deps);
    const scoped = h.calls.filter(
      (c) => c.sql.includes("user_office_access") && c.params?.[0] === "bid_due_date_report",
    );
    expect(scoped.map((c) => c.params?.[1])).toEqual(["office-a", "office-b", "office-c"]);
  });

  it("keeps going when one office throws, and still sends to the others", async () => {
    // The offices are read in slug order, so a broken FIRST office is the worst case: without a per-office
    // guard it aborts the loop and every office behind it misses the week. And because the Thursday
    // catch-up walks the same list in the same order, it fails at the same place — the catch-up cannot
    // rescue anyone standing behind a persistently broken office.
    const h = deps({ rows: [ROW], offices: THREE_OFFICES, failSchemas: ["office_aaa"] });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow();
    expect(h.sendEmail).toHaveBeenCalledTimes(2);
    expect(h.logger.error).toHaveBeenCalled();
  });

  it("reports a NON-ZERO failure signal rather than logging like a clean run", async () => {
    // A partial run that resolves successfully is how this stays broken: the cron's catch block never
    // fires, nothing is alerted, and the summary in the logs reads the same as a week that fully worked.
    const h = deps({ rows: [ROW], offices: THREE_OFFICES, failSchemas: ["office_bbb"] });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow(/1 of 3/);
  });

  it("RELEASES the advisory lock on the partial path", async () => {
    // Already established for the empty-recipients throw: a stranded session lock makes every later tick —
    // the Thursday catch-up and next week's run — a silent no-op, turning a transient tenant error into a
    // permanently dead job.
    const h = deps({ rows: [ROW], offices: THREE_OFFICES, failSchemas: ["office_bbb"] });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow();
    expect(h.release).toHaveBeenCalledTimes(1);
  });

  it("counts the offices that succeeded and the ones that did not", async () => {
    const h = deps({ rows: [ROW], offices: THREE_OFFICES });
    const summary = await runBidDueDateReport(h.deps);
    expect(summary).toMatchObject({ offices: 3, sent: 3, failed: 0 });
  });

  it("does not let a broken office write a receipt for the week it failed", async () => {
    const h = deps({ rows: [ROW], offices: THREE_OFFICES, failSchemas: ["office_aaa"] });
    await expect(runBidDueDateReport(h.deps)).rejects.toThrow();
    const receipted = h.calls
      .filter((call) => call.sql.includes("INSERT INTO public.bid_due_date_report_receipts"))
      .map((call) => call.params?.[0]);
    expect(receipted).toEqual(["office_bbb", "office_ccc"]);
  });
});

// ---------------------------------------------------------------------------------------------------
// The rendered email
// ---------------------------------------------------------------------------------------------------

describe("buildBidDueDateReportEmail", () => {
  const base = {
    weekOf: "2026-08-26",
    // The two anchors COINCIDE on the normal Wednesday tick, which is why collapsing them looked correct.
    deliveryDate: "2026-08-26",
    officeName: "DFW",
    sections: [
      {
        key: "overdue" as const,
        label: "OVERDUE",
        rows: [
          {
            id: "d0",
            name: "Old Bid <script>",
            dealNumber: "DFW-1-1",
            projectNumber: "24-100",
            bidDueOn: "2026-08-19",
            value: 1200000,
            repName: null,
          },
        ],
      },
      {
        key: "next_30" as const,
        label: "NEXT 30 DAYS",
        rows: [
          {
            id: "d1",
            name: "Cedar Park Retail",
            dealNumber: "DFW-1-2",
            projectNumber: "24-131",
            bidDueOn: "2026-09-04",
            value: 840000,
            repName: "Sidney Gibson",
          },
        ],
      },
    ],
    missingBidDateCount: 7,
    ctaUrl: "https://trockcrm.com/deals/stages/stage-1?scope=all&officeId=o1",
    overdueLookbackDays: 90,
  };

  it("names the OFFICE and the week in the subject", () => {
    // Per-office scoping means a cross-office recipient legitimately receives one message per office. With
    // an identical subject and no office named in the body, the only way to tell them apart is to inspect
    // the CTA's officeId query parameter.
    expect(buildBidDueDateReportEmail(base).subject).toBe("Bid due dates — DFW — week of Aug 26");
  });

  it("names the office in the body too, not only the subject", () => {
    // Subjects get truncated on a phone, and a forwarded body loses its subject entirely.
    const email = buildBidDueDateReportEmail(base);
    expect(email.html).toContain("DFW");
    expect(email.text).toContain("DFW");
  });

  it("escapes the office name", () => {
    const email = buildBidDueDateReportEmail({ ...base, officeName: "R&D <Test>" });
    expect(email.html).toContain("R&amp;D &lt;Test&gt;");
    expect(email.html).not.toContain("R&D <Test>");
  });

  // The preheader is the one line a phone shows before the body, so a false summary there is the most
  // expensive sentence in the email.
  it("does NOT describe an overdue bid as due in the next 30 days", () => {
    const overdueOnly = { ...base, sections: [base.sections[0]] };
    const email = buildBidDueDateReportEmail(overdueOnly);
    expect(email.html).not.toMatch(/1 project in estimating with bid dates in the next 30 days/);
    expect(email.html).toMatch(/1 overdue/);
  });

  it("counts overdue and upcoming SEPARATELY when the report has both", () => {
    const email = buildBidDueDateReportEmail(base);
    expect(email.html).toMatch(/1 overdue/);
    expect(email.html).toMatch(/1 due in the next 30 days/);
  });

  it("says there is nothing upcoming when everything in the report is overdue", () => {
    const email = buildBidDueDateReportEmail({ ...base, sections: [base.sections[0]] });
    expect(email.html).toMatch(/nothing due in the next 30 days/);
  });

  it("keeps the plain 'next 30 days' sentence when nothing is overdue", () => {
    const email = buildBidDueDateReportEmail({ ...base, sections: [base.sections[1]] });
    expect(email.html).toMatch(/1 project in estimating with bid dates in the next 30 days/);
    // Scoped to the SUMMARY sentence: the footer legitimately explains the overdue lookback bound on every
    // report. Asserting over the whole document only passed before because the footer happened to
    // capitalise the word.
    const preheader = /<p[^>]*>([^<]*in estimating[^<]*)<\/p>/.exec(email.html)?.[1] ?? "";
    expect(preheader).not.toMatch(/overdue/i);
  });

  // The reconciliation rule: the preheader, the section headings and the footer are three statements about
  // one population and must not be able to disagree. The footer's NULL count already derives from the
  // report's own predicates; these numbers derive from the sections themselves.
  it("PREHEADER NUMBERS RECONCILE WITH THE SECTION COUNTS, for every shape", () => {
    const shapes = [
      base.sections,
      [base.sections[0]],
      [base.sections[1]],
      [
        { ...base.sections[0], rows: [...base.sections[0].rows, ...base.sections[0].rows] },
        base.sections[1],
      ],
    ];
    for (const sections of shapes) {
      const email = buildBidDueDateReportEmail({ ...base, sections });
      const overdue = sections.find((section) => section.key === "overdue")?.rows.length ?? 0;
      const upcoming = sections
        .filter((section) => section.key !== "overdue")
        .reduce((sum, section) => sum + section.rows.length, 0);
      // Every number the preheader states must be one the sections can account for: the overdue count,
      // the upcoming count, or their sum. A number outside that set is a claim the body cannot support.
      const accountedFor = [overdue, upcoming, overdue + upcoming];
      const stated = (email.html.match(/(\d+) (?:overdue|due in the next|projects? in estimating)/g) ?? [])
        .map((match) => Number(match.split(" ")[0]));
      expect(stated.length).toBeGreaterThan(0);
      for (const value of stated) expect(accountedFor).toContain(value);
      // ...and when both windows have rows, the preheader must state BOTH rather than one total that
      // silently folds overdue bids into a "next 30 days" sentence.
      if (overdue > 0 && upcoming > 0) {
        expect(stated).toContain(overdue);
        expect(stated).toContain(upcoming);
      }
      // ...and each section still prints its own count in its heading.
      for (const section of sections) {
        expect(email.html).toContain(`${section.label} (${section.rows.length})`);
      }
    }
  });

  it("renders one row per deal with date, relative days, name, number, value and rep", () => {
    const email = buildBidDueDateReportEmail(base);
    expect(email.text).toContain("Aug 19");
    expect(email.text).toContain("7 days ago");
    expect(email.text).toContain("Sep 4");
    expect(email.text).toContain("in 9 days");
    expect(email.text).toContain("24-131");
    expect(email.text).toContain("$840,000");
    expect(email.text).toContain("S. Gibson");
  });

  it("renders an unassigned deal as an em dash rather than dropping it", () => {
    // bid-deadline.ts excludes `assigned_rep_id IS NULL` because it CREATES A TASK, which needs an owner.
    // This report only informs, and a bid nobody owns is the one most worth surfacing.
    const email = buildBidDueDateReportEmail(base);
    expect(email.text).toContain("—");
    expect(email.text).toContain("Old Bid");
  });

  it("escapes the deal name in the HTML body", () => {
    const email = buildBidDueDateReportEmail(base);
    expect(email.html).toContain("Old Bid &lt;script&gt;");
    expect(email.html).not.toContain("<script>");
  });

  it("reports the NULL-bid-date count, because 91% NULL makes a short list read as 'nothing due'", () => {
    const email = buildBidDueDateReportEmail(base);
    expect(email.html).toContain("7 estimating deals have no bid due date set");
    expect(email.text).toContain("7 estimating deals have no bid due date set");
  });

  it("renders the prose against deliveryDate while the sections stay on weekOf", () => {
    // Same report, read a day later: the section a row sits in is unchanged, the urgency beside it is not.
    const later = buildBidDueDateReportEmail({ ...base, deliveryDate: "2026-08-27" });
    const sameDay = buildBidDueDateReportEmail(base);
    expect(sameDay.text).toContain("7 days ago");
    expect(later.text).toContain("8 days ago");
    // BOTH renderings. The html is the half most people actually read, and asserting only the text left
    // the html's anchor free to be wired back to weekOf with the suite still green.
    expect(sameDay.html).toContain("7 days ago");
    expect(later.html).toContain("8 days ago");
    expect(later.html).not.toContain("7 days ago");
    // Headings, and therefore membership, are identical.
    for (const section of base.sections) {
      expect(later.text).toContain(`${section.label} (${section.rows.length})`);
      expect(sameDay.text).toContain(`${section.label} (${section.rows.length})`);
    }
    // The subject names the week, never the delivery day.
    expect(later.subject).toBe(sameDay.subject);
  });

  it("states the overdue lookback bound instead of implying the section is complete", () => {
    expect(buildBidDueDateReportEmail(base).text).toContain("last 90 days");
  });

  it("points the CTA at a page the recipient can actually open", () => {
    // /reports/operations/estimator-pipeline is RequireRole admin|director and the primary recipient is a
    // rep, so the obvious CTA is a 403 for the one person the report is for. The estimating stage
    // workspace is unguarded, and ?scope=all is in a rep's allowed set — which matters because Sidney
    // owns 0 deals, so the default ?scope=mine would render her an empty board.
    const email = buildBidDueDateReportEmail(base);
    expect(email.html).toContain("/deals/stages/stage-1?scope=all&amp;officeId=o1");
    expect(email.html).not.toContain("/reports/operations/estimator-pipeline");
    expect(email.text).toContain("scope=all");
  });

  it("says so when there is nothing to report", () => {
    const email = buildBidDueDateReportEmail({ ...base, sections: [], missingBidDateCount: 0 });
    expect(email.html).toContain("No estimating deals have a bid due date");
  });
});
