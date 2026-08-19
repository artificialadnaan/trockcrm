// Runtime suite for the weekly-report dead-letter sweep.
//
// The schema is migrations 0222 + 0226 + 0227 READ FROM DISK — the files that actually ship — because
// every guarantee this job makes is enforced partly by SQL: the claim's WHERE is the concurrency control,
// the partial index is the row set, and a hand-copied CREATE TABLE would let this suite pass against a
// shape the database does not have.
//
// TIME IS PINNED ABSOLUTELY, EVERYWHERE. Not one fixture below is computed from the constant it exercises.
// `ageSend(THRESHOLD + 5)` cannot fail — change the threshold to 30,000 minutes and the fixture moves with
// it, the assertion still passes, and the alert silently never fires again. That defect has already
// shipped in this feature more than once, so every timestamp here is written out in full and the
// thresholds are pinned to an interval by a row on each side of the boundary.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { deals, fieldResponders, files, offices, users } from "@trock-crm/shared/schema";
import { WEEKLY_REPORT_SEND_STALL_MINUTES } from "@trock-crm/shared/lib/weeklyReportSendStall";
import { migrationSql } from "../../../server/tests/helpers/migration-sql.js";
import { tenantSchemaSql } from "../../../server/tests/helpers/tenant-schema-from-drizzle.js";
import type { SendSystemEmailOutcome, SendSystemEmailResult } from "../../src/lib/system-email.js";
import {
  WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS,
  WEEKLY_REPORT_SEND_SWEEP_LOCK_KEY,
  buildWeeklyReportSendAlertEmail,
  formatElapsed,
  runWeeklyReportSendSweep,
  sendFailureSummary,
  weeklyReportSendIsAlertable,
} from "../../src/jobs/weekly-report-send-sweep.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const DALLAS_OFFICE = U("00001");
const AUSTIN_OFFICE = U("00002");
const DALLAS_DEAL = U("11111");
const AUSTIN_DEAL = U("11112");
const PM = U("22221");
const AUSTIN_PM = U("22222");
const WON_STAGE = U("33331");
const DALLAS_PROJECT = U("44441");
const AUSTIN_PROJECT = U("44442");
const REPORT = U("55551");
const OTHER_REPORT = U("55552");
const AUSTIN_REPORT = U("55553");

const WEEK_OF = "2026-08-13";

/**
 * THE REFERENCE INSTANT AND THE FIXTURES EITHER SIDE OF EACH THRESHOLD.
 *
 * WEEKLY_REPORT_SEND_STALL_MINUTES is 30, so with `now` at 18:00Z:
 *   17:29Z is 31 minutes old — STALLED.
 *   17:31Z is 29 minutes old — still in flight.
 * Those two pin the threshold to the open interval (29, 31) minutes. Any change to the constant outside it
 * turns one of them red.
 *
 * WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS is 168 (a week), so the window opens at 2026-08-11T18:00Z:
 *   2026-08-11T19:00Z is 167 hours old — inside the window, still alertable.
 *   2026-08-11T17:00Z is 169 hours old — history, and the board's problem rather than the alert's.
 * Those two pin that constant to (167, 169) hours.
 */
const NOW = new Date("2026-08-18T18:00:00.000Z");
const STALLED_AT = "2026-08-18T17:29:00.000Z";
const IN_FLIGHT_AT = "2026-08-18T17:31:00.000Z";
const JUST_INSIDE_ALERT_WINDOW = "2026-08-11T19:00:00.000Z";
const JUST_OUTSIDE_ALERT_WINDOW = "2026-08-11T17:00:00.000Z";
/** A commit two hours before `now`, for the "aged against the retry, not the commit" cases. */
const COMMITTED_AT = "2026-08-18T16:00:00.000Z";
const RETRIED_A_MINUTE_AGO = "2026-08-18T17:59:00.000Z";
const RETRIED_AN_HOUR_AGO = "2026-08-18T17:00:00.000Z";

/**
 * THE SECOND TICK, for every case that spans two sweeps — which is every case about the idempotency key,
 * because the defect it guards against is invisible inside a single run.
 *
 * The cron runs every fifteen minutes, so two ticks NEVER share a reference instant in production. A test
 * that re-runs at the same `now` is modelling something that cannot happen, and the alert's payload — which
 * carries "Silent for" — is different at each of these instants by construction.
 */
const NEXT_TICK = new Date("2026-08-18T18:15:00.000Z");
/** A director sees the 18:00 alert and presses Retry two minutes later. */
const HUMAN_RETRIED_AT = "2026-08-18T18:02:00.000Z";
/** The first tick at which THAT retry has itself been silent past the threshold — 43 minutes. */
const TICK_AFTER_RETRY = new Date("2026-08-18T18:45:00.000Z");
/**
 * A retry landing in the window between the sweep's SELECT and its claim: half a minute AFTER the instant
 * this run measured every row against, which is what makes it invisible to a claim that only re-checks the
 * SELECT's own conjuncts.
 */
const RACED_RETRY_AT = "2026-08-18T18:00:30.000Z";
/** The other side of that bound: a clock landing exactly ON the run's reference instant is still claimable. */
const RACED_AT_REFERENCE_INSTANT = "2026-08-18T18:00:00.000Z";

let pg: PGlite;

const query = async (text: string, params?: unknown[]) => {
  const result = await pg.query(text, params as any[]);
  return {
    rows: result.rows as any[],
    // PGlite reports writes as `affectedRows`; `rows.length` is 0 for every UPDATE/DELETE without
    // RETURNING. A harness that reports it WRONG is how a future "the update affected nothing" assertion
    // silently passes.
    rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
  };
};

interface SentEmail {
  to: string[];
  subject: string;
  html: string;
  text: string;
  idempotencyKey: string;
}

interface SendBehaviour {
  outcome?: SendSystemEmailOutcome;
  throws?: boolean;
}

/**
 * THE MAIL PROVIDER, WITH THE IDEMPOTENCY BEHAVIOUR THE REAL ONE HAS.
 *
 * A spy that only records calls cannot see the defect this suite exists to pin. Resend remembers an
 * idempotency key for 24 hours, and what it does on a repeat depends on the PAYLOAD:
 *
 *   same key, same payload       the original response is replayed. Nothing new is sent, and that is
 *                                correct — the first message went out.
 *   same key, DIFFERENT payload  409 `invalid_idempotent_request`, and NOTHING IS SENT.
 *                                `sendSystemEmailWithMetadata` deliberately maps that to
 *                                `{success:true, outcome:"delivered"}` (system-email.ts:201-203), because
 *                                for its original caller it does mean the first payload was delivered.
 *
 * That second row is the trap. A caller whose payload moves between attempts — and this alert's does, it
 * carries "Silent for" and "Last attempt" — reads a refusal to send as a delivery, stamps its row, and
 * never tries again. A stub returning `{success:true}` unconditionally reports that as a pass, which is
 * exactly why the bug it models survived a suite of forty tests.
 *
 * `requests` is every call the sweep made; `delivered` is the ones that actually put a NEW email in an
 * inbox; `swallowed` is the ones the provider refused. Assertions belong on the last two — `requests`
 * cannot distinguish an email that was sent from one that was not.
 *
 * ONE PROVIDER PER TEST, NOT PER RUN, because the 24-hour key memory is the whole point: every defect here
 * lives BETWEEN ticks.
 */
function mailProvider() {
  const requests: SentEmail[] = [];
  const delivered: SentEmail[] = [];
  const swallowed: SentEmail[] = [];
  const payloadByKey = new Map<string, string>();

  const fingerprint = (email: SentEmail) =>
    [email.to.join(","), email.subject, email.text, email.html].join("\u0000");

  const send = (email: SentEmail, behaviour: SendBehaviour): SendSystemEmailResult => {
    requests.push(email);
    const held = payloadByKey.get(email.idempotencyKey);
    if (held !== undefined && held !== fingerprint(email)) {
      swallowed.push(email);
      return { success: true, messageId: null, outcome: "delivered" };
    }
    // A `rejected` outcome is "the request was refused before an email existed" (see classifySendFailure),
    // so it must not leave a key behind — re-sending it has to be free.
    if (behaviour.outcome === "rejected") return { success: false, messageId: null, outcome: "rejected" };
    // Everything that REACHES the provider registers its key, delivered or not. That is the adversarial
    // half of `unknown` and the one the release-on-unknown rationale has to survive: a 5xx after the
    // request was accepted leaves the key held with no email sent.
    if (held === undefined) payloadByKey.set(email.idempotencyKey, fingerprint(email));
    if (behaviour.outcome === "unknown") return { success: false, messageId: null, outcome: "unknown" };
    if (held !== undefined) return { success: true, messageId: "duplicate", outcome: "delivered" };
    delivered.push(email);
    return { success: true, messageId: `msg-${delivered.length}`, outcome: "delivered" };
  };

  return { requests, delivered, swallowed, send };
}

type MailProvider = ReturnType<typeof mailProvider>;

/**
 * `rejected` and `unknown` are DIFFERENT failures and BOTH are `{success:false}`, which is why the stub
 * carries `outcome`. It is the full `SendSystemEmailResult` for the reason the reminder suite's sibling
 * stub gives: a stub that cannot express "the provider answered and we still do not know whether it
 * delivered" cannot exercise the branch that decides whether the claim is rolled back.
 *
 * `throws` models a bug in the send path, NOT a transport failure — `sendSystemEmailWithMetadata` returns
 * rather than throwing for every provider and network failure, because resend@6 catches its own fetch.
 */
function emailSpy(behaviour: SendBehaviour = {}, provider: MailProvider = mailProvider()) {
  const sent: SentEmail[] = [];
  const sendEmail = async (
    to: string | string[],
    subject: string,
    html: string,
    options: { text: string; idempotencyKey: string },
  ): Promise<SendSystemEmailResult> => {
    const email: SentEmail = {
      to: Array.isArray(to) ? to : [to],
      subject,
      html,
      text: options.text,
      idempotencyKey: options.idempotencyKey,
    };
    sent.push(email);
    if (behaviour.throws) throw new Error("send path blew up");
    return provider.send(email, behaviour);
  };
  return { sent, sendEmail, provider };
}

function loggerSpy() {
  const logs = { log: [] as string[], warn: [] as string[], error: [] as string[] };
  const record = (bucket: string[]) => (...args: unknown[]) => {
    bucket.push(String(args[0] ?? ""));
  };
  return { logs, logger: { log: record(logs.log), warn: record(logs.warn), error: record(logs.error) } };
}

/** Every run in a test shares `provider`, so the provider's key memory spans ticks as the real one does. */
let provider: MailProvider;

async function run(
  behaviour: SendBehaviour & {
    now?: Date;
    /** Wrapped to interleave a write between the sweep's SELECT and its claim. */
    query?: typeof query;
  } = {},
) {
  const spy = emailSpy(behaviour, provider);
  const { logs, logger } = loggerSpy();
  const summary = await runWeeklyReportSendSweep({
    query: behaviour.query ?? query,
    sendEmail: spy.sendEmail,
    env: { FRONTEND_URL: "https://trockcrm.com" },
    now: behaviour.now ?? NOW,
    logger,
    // The advisory lock needs a real pooled pg connection, which PGlite cannot provide (a session lock has
    // to be taken and released on the SAME connection). Its behaviour is exercised directly below.
    acquireLock: async () => async () => {},
  });
  return { ...spy, summary, logs };
}

interface SeedSend {
  schema?: string;
  id?: string;
  projectId?: string;
  dealId?: string;
  weekOf?: string;
  version?: number;
  status?: string;
  isActive?: boolean;
  sentAt?: string | null;
  lastAttemptAt?: string | null;
  deliveredAt?: string | null;
  supersededById?: string | null;
  attempts?: number;
  error?: string | null;
  alertedAt?: string | null;
}

async function seedSend(input: SeedSend = {}) {
  const schema = input.schema ?? "office_dallas";
  await pg.query(
    `INSERT INTO ${schema}.weekly_reports
       (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status, is_active,
        sent_at, send_last_attempt_at, send_delivered_at, superseded_by_id, send_attempts, send_error,
        send_stall_alerted_at)
     VALUES (COALESCE($1::uuid, gen_random_uuid()), gen_random_uuid(), $2::uuid, $3::uuid, $4::date, $5, $6,
             $7, $8::timestamptz, $9::timestamptz, $10::timestamptz, $11::uuid, $12, $13, $14::timestamptz)`,
    [
      input.id ?? REPORT,
      input.projectId ?? (schema === "office_austin" ? AUSTIN_PROJECT : DALLAS_PROJECT),
      input.dealId ?? (schema === "office_austin" ? AUSTIN_DEAL : DALLAS_DEAL),
      input.weekOf ?? WEEK_OF,
      input.version ?? 1,
      input.status ?? "sent",
      input.isActive ?? true,
      input.sentAt === undefined ? STALLED_AT : input.sentAt,
      input.lastAttemptAt ?? null,
      input.deliveredAt ?? null,
      input.supersededById ?? null,
      input.attempts ?? 0,
      input.error ?? null,
      input.alertedAt ?? null,
    ],
  );
}

async function reportRow(id = REPORT, schema = "office_dallas"): Promise<Record<string, any>> {
  const result = await pg.query(`SELECT * FROM ${schema}.weekly_reports WHERE id = $1::uuid`, [id]);
  return result.rows[0] as Record<string, any>;
}

async function setLeadershipRecipients(emails: string[], schema = "office_dallas") {
  await pg.query(`DELETE FROM ${schema}.weekly_report_settings`);
  if (emails.length === 0) return;
  await pg.query(
    `INSERT INTO ${schema}.weekly_report_settings (leadership_recipient_emails) VALUES ($1::text[])`,
    [emails],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas;`);
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_austin;`);
  await pg.exec(tenantSchemaSql("public", [offices, users]));
  await pg.exec(tenantSchemaSql("office_dallas", [deals, fieldResponders, files]));
  await pg.exec(tenantSchemaSql("office_austin", [deals, fieldResponders, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  // 0222's loop builds the weekly-report tables in BOTH office schemas, which is what makes the
  // cross-office cases real rather than a fixture of this file.
  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(migrationSql("0227_weekly_report_send_stall_alerted"));
  // 0228 links the PM/superintendent slots to the FIELD TEAM ROSTER. The job PROBES for these
  // columns and skips any office without them (migrations do not run on the worker), so a fixture
  // that stops at 0227 makes every office silently skip and every assertion read zero.
  await pg.exec(migrationSql("0228_weekly_report_project_roster_link"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES
      ('${DALLAS_OFFICE}', 'Dallas', 'dallas'),
      ('${AUSTIN_OFFICE}', 'Austin', 'austin');
    INSERT INTO public.users (id, display_name, email, role, office_id, is_active) VALUES
      ('${PM}',        'Adam Sherwood', 'pm@example.com',       'construction', '${DALLAS_OFFICE}', true),
      ('${AUSTIN_PM}', 'Rosa Delgado',  'austinpm@example.com', 'construction', '${AUSTIN_OFFICE}', true);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', 'won');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DALLAS_DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    INSERT INTO office_austin.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${AUSTIN_DEAL}', 'Barton Springs Lofts', 'ATX-20101', '${WON_STAGE}', 'ATX-20101');
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  provider = mailProvider();
  await pg.exec(`
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_dallas.weekly_report_settings;
    DELETE FROM office_austin.weekly_reports;
    DELETE FROM office_austin.weekly_report_projects;
    DELETE FROM office_austin.weekly_report_settings;
  `);
  await pg.query(
    `INSERT INTO office_dallas.weekly_report_projects
       (id, deal_id, property_display_name, client_name, trock_pm_user_id, cadence_weekday,
        cadence_start_date, status, is_active)
     VALUES ($1::uuid, $2::uuid, '4123 Cedar Springs', 'Mack Real Estate Group', $3::uuid, 4, '2026-07-27',
             'active', true)`,
    [DALLAS_PROJECT, DALLAS_DEAL, PM],
  );
  await pg.query(
    `INSERT INTO office_austin.weekly_report_projects
       (id, deal_id, property_display_name, client_name, trock_pm_user_id, cadence_weekday,
        cadence_start_date, status, is_active)
     VALUES ($1::uuid, $2::uuid, 'Barton Springs Lofts', 'Lantern Capital', $3::uuid, 4, '2026-07-27',
             'active', true)`,
    [AUSTIN_PROJECT, AUSTIN_DEAL, AUSTIN_PM],
  );
  await setLeadershipRecipients(["director@example.com"], "office_dallas");
  await setLeadershipRecipients(["austin.director@example.com"], "office_austin");
});

describe("the alert threshold", () => {
  it("pins WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS to a week", () => {
    // A direct pin so the number cannot drift silently; the interval cases below prove the fixtures still
    // straddle whatever it is.
    expect(WEEKLY_REPORT_SEND_ALERT_MAX_AGE_HOURS).toBe(168);
  });

  it("alerts on a send 31 minutes silent and NOT on one 29 minutes silent", () => {
    expect(weeklyReportSendIsAlertable({ sent_at: new Date(STALLED_AT) }, NOW)).toBe(true);
    expect(weeklyReportSendIsAlertable({ sent_at: new Date(IN_FLIGHT_AT) }, NOW)).toBe(false);
  });

  it("stops alerting once a stall is a week old, and still alerts an hour inside that", () => {
    // The bound exists so the sweep's FIRST pass in an office does not announce every undelivered send in
    // its history at once — the single most reliable way to teach a roster to filter this sender.
    expect(weeklyReportSendIsAlertable({ sent_at: new Date(JUST_INSIDE_ALERT_WINDOW) }, NOW)).toBe(true);
    expect(weeklyReportSendIsAlertable({ sent_at: new Date(JUST_OUTSIDE_ALERT_WINDOW) }, NOW)).toBe(false);
  });
});

describe("what the sweep alerts on", () => {
  it("announces a send that has stopped moving, once, to the leadership roster", async () => {
    await seedSend({ sentAt: STALLED_AT });

    const { sent, summary } = await run();

    expect(summary).toMatchObject({ offices: 2, stalled: 1, alerted: 1, skipped: 0, failed: 0 });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toEqual(["director@example.com"]);
    expect(sent[0]!.subject).toContain("4123 Cedar Springs");
    expect(sent[0]!.html).toContain("4123 Cedar Springs");
    // Claimed, which is what makes the next pass silent.
    expect((await reportRow()).send_stall_alerted_at).not.toBeNull();
  });

  it("leaves a send that is still in flight alone", async () => {
    // THE CONTROL for the case above. A sweep that alerted on everything would pass that test too.
    await seedSend({ sentAt: IN_FLIGHT_AT });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary).toMatchObject({ candidates: 1, stalled: 0, alerted: 0 });
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("ages against the RETRY, never the commit", async () => {
    // The precise bug migration 0226 was written to fix, executed end to end. `sent_at` is stamped once
    // when the PM commits and never moves, so ageing on it alone calls a delivery retried sixty seconds
    // ago "stuck" — and sends a director to chase a send that is in flight right now.
    await seedSend({ sentAt: COMMITTED_AT, lastAttemptAt: RETRIED_A_MINUTE_AGO, attempts: 1 });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary.stalled).toBe(0);
  });

  it("DOES announce the same commit once its last attempt is an hour old", async () => {
    // The control for the line above, and the distinction `send_attempts` alone cannot draw: "failed and
    // is still retrying" versus "failed and gave up". Same commit, same attempt count — only the clock
    // differs.
    await seedSend({
      sentAt: COMMITTED_AT,
      lastAttemptAt: RETRIED_AN_HOUR_AGO,
      attempts: 1,
      error: "Resend timed out",
    });

    const { sent, summary } = await run();

    expect(summary.stalled).toBe(1);
    expect(sent).toHaveLength(1);
    // The recorded error is carried, because a reader who can see what went wrong acts differently from
    // one who cannot.
    expect(sent[0]!.text).toContain("Resend timed out");
  });

  it("announces a silent stall — no error, no attempts — which is the case it exists for", async () => {
    // The job dead-lettered having written nothing at all: no error, no attempt stamp, `send_attempts` 0.
    // Nothing but the passage of time says anything is wrong.
    await seedSend({ sentAt: STALLED_AT, attempts: 0, error: null });

    const { sent } = await run();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain("No delivery attempt was ever recorded");
  });

  it("says nothing about a stall that is already a week old", async () => {
    await seedSend({ sentAt: JUST_OUTSIDE_ALERT_WINDOW });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    // Not even fetched: the window is a bound in the SQL, so this row never reaches the predicate.
    expect(summary.candidates).toBe(0);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("still announces one an hour inside that window", async () => {
    // The control. Without it the case above is satisfied by a bound that excludes everything.
    await seedSend({ sentAt: JUST_INSIDE_ALERT_WINDOW });

    const { sent, summary } = await run();

    expect(summary.candidates).toBe(1);
    expect(sent).toHaveLength(1);
  });
});

describe("what the sweep must NOT alert on", () => {
  it("says nothing about a report a correction has superseded", async () => {
    // A version the client has already been told is replaced is not a delivery failure: the worker refuses
    // to deliver it at all, so announcing it would send somebody to retry an email that must never go out.
    await seedSend({ id: OTHER_REPORT, version: 2, sentAt: STALLED_AT, deliveredAt: STALLED_AT });
    await seedSend({ id: REPORT, sentAt: STALLED_AT, supersededById: OTHER_REPORT });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary.candidates).toBe(0);
    expect((await reportRow(REPORT)).send_stall_alerted_at).toBeNull();
  });

  it("DOES announce the same report before a correction supersedes it", async () => {
    // The control: the only difference from the case above is `superseded_by_id`.
    await seedSend({ id: REPORT, sentAt: STALLED_AT, supersededById: null });

    const { sent } = await run();

    expect(sent).toHaveLength(1);
  });

  it("says nothing about a send the provider already accepted", async () => {
    await seedSend({ sentAt: STALLED_AT, deliveredAt: "2026-08-18T17:30:00.000Z" });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary.candidates).toBe(0);
  });

  it("says nothing about a soft-deleted report, or one that was never sent", async () => {
    await seedSend({ id: REPORT, sentAt: STALLED_AT, isActive: false });
    await seedSend({ id: OTHER_REPORT, sentAt: null, status: "approved" });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary.candidates).toBe(0);
  });

  it("says nothing about a send whose project setup has been deleted", async () => {
    // The board's own project predicate is `wrp.is_active`, so such a send is drawn nowhere. An alert
    // pointing at a board that will not show the row is an alert nobody can act on.
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET is_active = false WHERE id = $1::uuid`, [
      DALLAS_PROJECT,
    ]);
    await seedSend({ sentAt: STALLED_AT });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(0);
    expect(summary.candidates).toBe(0);
  });
});

describe("alerting once", () => {
  it("tells leadership ONCE, not every pass", async () => {
    // A job that emailed every fifteen minutes about the same stuck report would have a filter rule built
    // for it inside a day, and the next real failure would be invisible for exactly the reason it was
    // before this feature existed.
    await seedSend({ sentAt: STALLED_AT });

    const first = await run();
    expect(first.sent).toHaveLength(1);
    const stampedAt = (await reportRow()).send_stall_alerted_at;

    const second = await run();
    expect(second.sent).toHaveLength(0);
    expect(second.summary).toMatchObject({ candidates: 0, stalled: 0, alerted: 0 });
    // ...and the first claim is untouched, so nothing re-arms itself by accident.
    expect((await reportRow()).send_stall_alerted_at).toEqual(stampedAt);
  });

  it("announces a report again once a human retry has re-armed it — and actually SENDS that second email", async () => {
    // THE CONTROL for the suppression, and the reason `retryWeeklyReportSend` clears the stamp: somebody
    // saw the alert and acted, so a retry that also goes quiet is a NEW incident. Without this, a report
    // retried three times and stalled three times is announced once and then never again.
    //
    // AND IT ASSERTS ON `provider.delivered`, NOT ON THE CALL. This test used to assert that a second call
    // was MADE, which the sweep did — under an idempotency key identical to the first, because the cohort
    // digest is a pure function of the report set. Resend holds that key for 24 hours, the payload has
    // moved on ("Silent for", "Last attempt"), so the second call was refused as
    // `invalid_idempotent_request` and mapped straight back to "delivered". The claim was kept, the row
    // read as announced, no tick would ever retry it, and no email existed. The re-arm the whole of 0227
    // was built for was defeated by its own alert, and a call-counting spy called that a pass.
    await seedSend({ sentAt: STALLED_AT });
    expect((await run()).sent).toHaveLength(1);
    expect(provider.delivered).toHaveLength(1);

    // What the retry route writes: the error cleared, the clock moved, the alert re-armed.
    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_error = NULL, send_last_attempt_at = $2::timestamptz, send_stall_alerted_at = NULL
        WHERE id = $1::uuid`,
      [REPORT, HUMAN_RETRIED_AT],
    );

    // The first tick at which the retry has itself been silent past the threshold.
    const again = await run({ now: TICK_AFTER_RETRY });
    expect(again.sent).toHaveLength(1);
    expect(again.summary.alerted).toBe(1);
    expect(provider.swallowed).toEqual([]);
    expect(provider.delivered).toHaveLength(2);
    // The two announcements are different messages and must carry different keys.
    expect(again.sent[0]!.idempotencyKey).not.toBe(provider.delivered[0]!.idempotencyKey);
    expect(provider.delivered[1]!.text).toContain("Silent for: 43 min");
  });

  it("does not re-announce a retry that is still in flight", async () => {
    // The other half of the re-arming: clearing the stamp must not mean "alert immediately". The retry
    // moved the clock, so the report is not stalled until the threshold passes again.
    await seedSend({ sentAt: STALLED_AT });
    expect((await run()).sent).toHaveLength(1);

    await pg.query(
      `UPDATE office_dallas.weekly_reports
          SET send_last_attempt_at = $2::timestamptz, send_stall_alerted_at = NULL
        WHERE id = $1::uuid`,
      [REPORT, RETRIED_A_MINUTE_AGO],
    );

    expect((await run()).sent).toHaveLength(0);
  });
});

describe("the window between the read and the claim", () => {
  /**
   * Land a write in the gap the claim exists to survive: after the candidate SELECT has returned, before
   * the claim UPDATE runs. Dallas only, once — the sweep shares one `query` across every office.
   */
  function raceIntoTheClaim(write: () => Promise<void>) {
    let raced = false;
    return async (text: string, params?: unknown[]) => {
      const result = await query(text, params);
      if (!raced && text.includes("FROM office_dallas.weekly_reports wr")) {
        raced = true;
        await write();
      }
      return result;
    };
  }

  /** Exactly what `retryWeeklyReportSend` writes, at `at`. */
  const humanRetry = (at: string) => () =>
    pg
      .query(
        `UPDATE office_dallas.weekly_reports
            SET send_error = NULL, send_last_attempt_at = $2::timestamptz, send_stall_alerted_at = NULL
          WHERE id = $1::uuid`,
        [REPORT, at],
      )
      .then(() => undefined);

  it("does NOT announce a report a human retried between the read and the claim", async () => {
    // The claim re-checks the SELECT's conjuncts, and for a retry not one of them changes value: the error
    // is cleared (not read), the clock moves (not read), and `send_stall_alerted_at` is set to NULL when it
    // was ALREADY NULL. So the report a director had just re-queued was claimed and announced as having
    // stopped moving, while the board — reading the shared predicate off the clock that retry moved — drew
    // it as "Sending…". An alert whose first instruction is "open the board" must not point at a row the
    // board says is fine.
    await seedSend({ sentAt: STALLED_AT });

    const { sent, summary } = await run({ query: raceIntoTheClaim(humanRetry(RACED_RETRY_AT)) });

    // It WAS read as stalled — the row reached the claim, and the claim is what dropped it.
    expect(summary.stalled).toBe(1);
    expect(summary.alerted).toBe(0);
    expect(sent).toEqual([]);
    expect(provider.delivered).toEqual([]);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("still announces when the racing write does not move the delivery clock", async () => {
    // THE CONTROL. The new conjunct is a bound on the ACTIVITY CLOCK, not a blanket "something changed"
    // check: a worker recording an error against the attempt this sweep already measured is not a retry,
    // and dropping it would silently un-alert the commonest stalled shape there is.
    await seedSend({ sentAt: STALLED_AT });

    const { sent, summary } = await run({
      query: raceIntoTheClaim(() =>
        pg
          .query(`UPDATE office_dallas.weekly_reports SET send_error = 'Resend 502' WHERE id = $1::uuid`, [REPORT])
          .then(() => undefined),
      ),
    });

    expect(summary.alerted).toBe(1);
    expect(sent).toHaveLength(1);
    expect(provider.delivered).toHaveLength(1);
    expect((await reportRow()).send_stall_alerted_at).not.toBeNull();
  });

  it("claims a clock landing exactly on the run's reference instant", async () => {
    // The other side of the bound, pinning it to `<=` rather than `<`. A retry stamped at the very instant
    // this run measures against did not happen after the measurement, and the run's own claim stamp is
    // that same instant — a strict bound would make the sweep unable to claim a row it just stamped.
    await seedSend({ sentAt: STALLED_AT });

    const { summary } = await run({ query: raceIntoTheClaim(humanRetry(RACED_AT_REFERENCE_INSTANT)) });

    expect(summary.alerted).toBe(1);
    expect((await reportRow()).send_stall_alerted_at).not.toBeNull();
  });
});

describe("offices", () => {
  it("cannot leak a send from one office into another office's alert", async () => {
    await seedSend({ schema: "office_dallas", id: REPORT, sentAt: STALLED_AT });
    await seedSend({ schema: "office_austin", id: AUSTIN_REPORT, sentAt: STALLED_AT });

    const { sent, summary } = await run();

    // BOTH offices are alerted — the control that proves the iteration runs at all, without which "no
    // cross-office leak" is satisfied by a sweep that sweeps nothing.
    expect(summary).toMatchObject({ offices: 2, stalled: 2, alerted: 2 });
    expect(sent).toHaveLength(2);

    const dallas = sent.find((email) => email.to[0] === "director@example.com")!;
    const austin = sent.find((email) => email.to[0] === "austin.director@example.com")!;
    expect(dallas.text).toContain("4123 Cedar Springs");
    expect(dallas.text).not.toContain("Barton Springs Lofts");
    expect(austin.text).toContain("Barton Springs Lofts");
    expect(austin.text).not.toContain("4123 Cedar Springs");
    // Each office's link carries its OWN office id; CRM office context is URL-driven.
    expect(dallas.html).toContain(`officeId=${DALLAS_OFFICE}`);
    expect(austin.html).toContain(`officeId=${AUSTIN_OFFICE}`);
    // Each claim stamped its own row and nothing else.
    expect((await reportRow(REPORT, "office_dallas")).send_stall_alerted_at).not.toBeNull();
    expect((await reportRow(AUSTIN_REPORT, "office_austin")).send_stall_alerted_at).not.toBeNull();
  });

  it("alerts the other office even when one office's sweep throws", async () => {
    // A broken office must not cost its neighbours their alert. `deals` is renamed rather than one of the
    // probed tables on purpose: this has to be a failure the probe cannot pre-empt, so the throw happens
    // mid-sweep, inside the office's own try, exactly where a saturated pool or a bad row would land.
    await seedSend({ schema: "office_austin", id: AUSTIN_REPORT, sentAt: STALLED_AT });
    await seedSend({ schema: "office_dallas", id: REPORT, sentAt: STALLED_AT });
    await pg.exec(`ALTER TABLE office_dallas.deals RENAME TO deals_x;`);
    try {
      const { sent, summary, logs } = await run();

      expect(sent.map((email) => email.to[0])).toEqual(["austin.director@example.com"]);
      expect(summary.failed).toBe(1);
      expect(summary.alerted).toBe(1);
      expect(logs.error.some((line) => line.includes("Office sweep failed"))).toBe(true);
      // Nothing was claimed for the office that threw, so its next tick starts clean.
      expect((await reportRow(REPORT, "office_dallas")).send_stall_alerted_at).toBeNull();
    } finally {
      await pg.exec(`ALTER TABLE office_dallas.deals_x RENAME TO deals;`);
    }
  });

  it("skips an office whose API has not applied the migration yet, without failing it", async () => {
    // MIGRATIONS DO NOT RUN ON THE WORKER IN THIS REPO — the API runs the runner before start, the worker
    // does not. So there is a real deploy window in which this cron is live against a database that has
    // 0222's `weekly_reports` and none of 0226's or 0227's columns, and an unguarded SELECT throws 42703
    // for that office on every tick until the API happens to deploy.
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS office_houston;
      CREATE TABLE office_houston.weekly_report_projects (
        id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true,
        -- 0228's columns ARE present here. This test's subject is the COLUMN probe on weekly_reports;
        -- withholding these too would make the earlier TABLE probe fire instead and the assertion below
        -- would pass while saying something else happened.
        trock_pm_responder_id uuid, trock_super_responder_id uuid
      );
      CREATE TABLE office_houston.field_responders (
        id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL,
        role text NOT NULL, is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE office_houston.weekly_report_settings (leadership_recipient_emails text[] NOT NULL DEFAULT '{}');
      -- 0222's shape exactly: no send_delivered_at, no send_last_attempt_at, no send_stall_alerted_at.
      CREATE TABLE office_houston.weekly_reports (
        id uuid PRIMARY KEY, status varchar(20) NOT NULL DEFAULT 'sent',
        is_active boolean NOT NULL DEFAULT true, sent_at timestamptz,
        send_attempts integer NOT NULL DEFAULT 0, send_error text
      );
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00003")}', 'Houston', 'houston');
    `);
    try {
      await seedSend({ schema: "office_dallas", id: REPORT, sentAt: STALLED_AT });

      const { sent, summary, logs } = await run();

      // Houston is skipped at INFO — the routine deploy window, not a fault — and is NOT counted as swept.
      expect(summary.offices).toBe(2);
      expect(summary.failed).toBe(0);
      expect(logs.error).toEqual([]);
      expect(logs.log.some((line) => line.includes("send columns not migrated yet"))).toBe(true);
      // ...and Dallas, which HAS the columns, is alerted in the same pass.
      expect(sent.map((email) => email.to[0])).toEqual(["director@example.com"]);
    } finally {
      await pg.exec(`DROP SCHEMA office_houston CASCADE; DELETE FROM public.offices WHERE slug = 'houston';`);
    }
  });

  it("skips an office that has 0227's columns but NOT 0228's roster link", async () => {
    // The same deploy window one migration later, and it needs its own probe: `weekly_report_projects`
    // has existed since 0222, so the TABLE probe passes happily while the candidate query — which now
    // joins the roster off `wrp.trock_pm_responder_id` to resolve the PM's name — throws 42703 for that
    // office on every tick. Caught one level up, so it would fail silently: no alert ever goes out
    // there, and the only trace is a log line.
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS office_waco;
      -- Everything through 0227, and nothing of 0228: no trock_*_responder_id.
      CREATE TABLE office_waco.weekly_report_projects (id uuid PRIMARY KEY, is_active boolean NOT NULL DEFAULT true);
      CREATE TABLE office_waco.field_responders (
        id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL,
        role text NOT NULL, is_active boolean NOT NULL DEFAULT true
      );
      CREATE TABLE office_waco.weekly_report_settings (leadership_recipient_emails text[] NOT NULL DEFAULT '{}');
      CREATE TABLE office_waco.weekly_reports (
        id uuid PRIMARY KEY, status varchar(20) NOT NULL DEFAULT 'sent',
        is_active boolean NOT NULL DEFAULT true, sent_at timestamptz,
        send_attempts integer NOT NULL DEFAULT 0, send_error text,
        send_delivered_at timestamptz, send_last_attempt_at timestamptz, send_stall_alerted_at timestamptz
      );
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00005")}', 'Waco', 'waco');
    `);
    try {
      await seedSend({ schema: "office_dallas", id: REPORT, sentAt: STALLED_AT });

      const { sent, summary, logs } = await run();

      expect(summary.offices).toBe(2);
      expect(summary.failed).toBe(0);
      expect(logs.error).toEqual([]);
      expect(logs.log.some((line) => line.includes("roster columns not migrated yet"))).toBe(true);
      // Dallas is unaffected and still alerted in the same pass.
      expect(sent.map((email) => email.to[0])).toEqual(["director@example.com"]);
    } finally {
      await pg.exec(`DROP SCHEMA office_waco CASCADE; DELETE FROM public.offices WHERE slug = 'waco';`);
    }
  });

  it("skips an office that has no weekly-report tables at all", async () => {
    await pg.exec(`
      CREATE SCHEMA IF NOT EXISTS office_elpaso;
      INSERT INTO public.offices (id, name, slug) VALUES ('${U("00004")}', 'El Paso', 'elpaso');
    `);
    try {
      const { summary, logs } = await run();
      expect(summary.offices).toBe(2);
      expect(summary.failed).toBe(0);
      expect(logs.log.some((line) => line.includes("tables not present"))).toBe(true);
    } finally {
      await pg.exec(`DROP SCHEMA office_elpaso CASCADE; DELETE FROM public.offices WHERE slug = 'elpaso';`);
    }
  });
});

describe("when the alert cannot be sent", () => {
  it("claims NOTHING when no leadership roster is configured", async () => {
    // Burning the one alert a send will ever get on an email addressed to nobody is the worst outcome
    // available here. `leadership_recipient_emails` defaults to '{}', so a freshly migrated office is
    // exactly this shape.
    await setLeadershipRecipients([]);
    await seedSend({ sentAt: STALLED_AT });

    const { sent, summary, logs } = await run();

    expect(sent).toHaveLength(0);
    expect(summary).toMatchObject({ stalled: 1, alerted: 0, skipped: 1 });
    expect(logs.warn.some((line) => line.includes("No leadership recipients"))).toBe(true);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("alerts as soon as a roster IS configured", async () => {
    // The control: the slot was not burned by the run that had nobody to address.
    await setLeadershipRecipients([]);
    await seedSend({ sentAt: STALLED_AT });
    expect((await run()).sent).toHaveLength(0);

    await setLeadershipRecipients(["director@example.com"]);
    expect((await run()).sent).toHaveLength(1);
  });

  it("gives the claim back when the provider rejects the alert, so the next tick retries", async () => {
    await seedSend({ sentAt: STALLED_AT });

    const rejected = await run({ outcome: "rejected" });
    expect(rejected.sent).toHaveLength(1);
    expect(rejected.summary).toMatchObject({ alerted: 0, failed: 1 });
    expect((await reportRow()).send_stall_alerted_at).toBeNull();

    const retried = await run();
    expect(retried.sent).toHaveLength(1);
    expect(retried.summary.alerted).toBe(1);
  });

  it("gives the claim back on an UNKNOWN outcome too", async () => {
    // `unknown` may have been delivered. It is released anyway, because keeping the claim would permanently
    // suppress the only alert these sends ever get, on the most common transport failure there is.
    await seedSend({ sentAt: STALLED_AT });

    const unknown = await run({ outcome: "unknown" });
    expect(unknown.summary.failed).toBe(1);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();

    const retried = await run();
    expect(retried.sent).toHaveLength(1);
  });

  it("re-presents the SAME key when the retry is the same message in the same cycle", async () => {
    // THE OTHER HALF of the key's job, and the control for the rotation cases below: a key that rotated on
    // every request would be no key at all. Two announcements of the same cohort, claimed at the same
    // instant, are the same message — same payload, same key — and the provider recognises it rather than
    // putting a second copy of one alert in a director's inbox.
    await seedSend({ sentAt: STALLED_AT });

    const first = await run({ outcome: "unknown" });
    const same = await run();

    expect(same.sent[0]!.idempotencyKey).toBe(first.sent[0]!.idempotencyKey);
    // Recognised, not refused: `swallowed` would mean `invalid_idempotent_request`, which is the failure
    // shape, and `delivered` staying empty means no second copy was produced.
    expect(provider.swallowed).toEqual([]);
    expect(provider.delivered).toEqual([]);
  });

  it("SENDS the next tick's alert after an ambiguous outcome, instead of having it swallowed", async () => {
    // THE ROLLBACK RATIONALE, EXECUTED. Releasing the claim on `unknown` is only worth anything if the
    // next tick's send actually reaches somebody. It did not: the key was fixed by the cohort, the
    // provider was still holding it from the ambiguous request, and the payload had moved on by fifteen
    // minutes — so Resend answered `invalid_idempotent_request`, `sendSystemEmailWithMetadata` mapped that
    // to "delivered", and the sweep stamped the row and logged an announcement for an email that was never
    // sent. Released-then-re-suppressed is strictly worse than never releasing, because it also lies in
    // the log.
    await seedSend({ sentAt: STALLED_AT });

    const ambiguous = await run({ outcome: "unknown" });
    expect(ambiguous.summary.failed).toBe(1);
    expect(provider.delivered).toEqual([]);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();

    const next = await run({ now: NEXT_TICK });

    expect(provider.swallowed).toEqual([]);
    expect(provider.delivered).toHaveLength(1);
    expect(provider.delivered[0]!.text).toContain("Silent for: 46 min");
    expect(next.summary.alerted).toBe(1);
    expect((await reportRow()).send_stall_alerted_at).not.toBeNull();
  });

  it("gives the claim back when the send path throws outright", async () => {
    await seedSend({ sentAt: STALLED_AT });

    const thrown = await run({ throws: true });
    expect(thrown.summary.failed).toBe(1);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("gives the claim back when COMPOSING the email throws, after the claim is already written", async () => {
    // The claim is written BEFORE the email is composed, deliberately: a crash between the two costs one
    // missed alert rather than an alert every fifteen minutes. Composition used to sit outside the send's
    // guard, so a throw in it escaped to the per-office catch — whose comment promised "Nothing is claimed
    // on a throw", which stops being true the instant the claim lands. Those reports would read as
    // announced with no email ever sent, and `send_stall_alerted_at` is precisely the memory that stops any
    // later tick retrying them.
    //
    // "alerts the other office even when one office's sweep throws" cannot see this: it renames `deals`,
    // which breaks the candidate SELECT, so its throw happens BEFORE the claim and its "nothing was
    // claimed" assertion passes either way.
    //
    // The throw is injected at the module boundary the sweep genuinely composes through — the branded
    // shell and the detail table live in `weekly-report-reminders.ts`, a separate module with its own
    // reasons to change. Every throw path in there is guarded today, which is what makes this latent
    // rather than live; a guard has to hold before it is needed.
    await seedSend({ sentAt: STALLED_AT });

    vi.resetModules();
    vi.doMock("../../src/jobs/weekly-report-reminders.js", async () => {
      const actual = await vi.importActual<typeof import("../../src/jobs/weekly-report-reminders.js")>(
        "../../src/jobs/weekly-report-reminders.js",
      );
      return {
        ...actual,
        renderDetailRows: () => {
          throw new TypeError("renderDetailRows blew up");
        },
      };
    });
    try {
      const fresh = await import("../../src/jobs/weekly-report-send-sweep.js");
      const spy = emailSpy({}, provider);
      const { logs, logger } = loggerSpy();

      const summary = await fresh.runWeeklyReportSendSweep({
        query,
        sendEmail: spy.sendEmail,
        env: { FRONTEND_URL: "https://trockcrm.com" },
        now: NOW,
        logger,
        acquireLock: async () => async () => {},
      });

      expect(spy.sent).toEqual([]);
      expect(provider.delivered).toEqual([]);
      expect(summary.alerted).toBe(0);
      // THE ASSERTION THAT MOVES: unguarded, the row stays stamped and no tick ever looks at it again.
      expect((await reportRow()).send_stall_alerted_at).toBeNull();
      expect(logs.error.some((line) => line.includes("claims released"))).toBe(true);
    } finally {
      vi.doUnmock("../../src/jobs/weekly-report-reminders.js");
      vi.resetModules();
    }
  });
});

describe("the alert email", () => {
  it("does not claim the client failed to receive anything", async () => {
    // `send_delivered_at` records that the mail PROVIDER accepted the message, and there is no bounce
    // webhook in this codebase. The one path where a delivery genuinely succeeds and the stamp does not
    // land — the database going away between the provider answering and the row being updated — is
    // indistinguishable from here. Telling a director a client did not get their report, when they did, is
    // how the next four alerts get ignored.
    await seedSend({ sentAt: STALLED_AT });

    const { sent } = await run();
    const email = sent[0]!;

    expect(email.subject).toContain("not confirmed");
    expect(email.text).toContain("no record of the email being accepted by the mail provider");
    expect(email.text).toContain("not that the client definitely did or did not receive it");
    expect(email.text).not.toMatch(/did not receive (their|the) report/i);
    expect(email.subject).not.toMatch(/never (received|arrived)/i);
  });

  it("carries what a reader needs to act: project, week, PM, age and the board link", async () => {
    await seedSend({ sentAt: COMMITTED_AT, lastAttemptAt: RETRIED_AN_HOUR_AGO, attempts: 3, error: "Resend 502" });

    const { sent } = await run();
    const email = sent[0]!;

    expect(email.text).toContain("4123 Cedar Springs");
    expect(email.text).toContain("DFW-10432");
    expect(email.text).toContain("Mack Real Estate Group");
    expect(email.text).toContain("Aug 13, 2026");
    expect(email.text).toContain("Adam Sherwood");
    expect(email.text).toContain("Attempts: 3");
    expect(email.text).toContain("Resend 502");
    // An hour of silence, measured from the LAST ATTEMPT rather than the two-hour-old commit.
    expect(email.text).toContain("Silent for: 1h 00m");
    expect(email.text).toContain(`https://trockcrm.com/projects/weekly-reports?officeId=${DALLAS_OFFICE}`);
  });

  it("collapses several stalled sends into ONE email rather than one each", async () => {
    // A database outage stalls every send in flight at once. Twelve separate emails about one incident is
    // the same mute-inducing noise as alerting every pass.
    await seedSend({ id: REPORT, sentAt: STALLED_AT, weekOf: "2026-08-13" });
    await seedSend({ id: OTHER_REPORT, sentAt: STALLED_AT, weekOf: "2026-08-06" });

    const { sent, summary } = await run();

    expect(sent).toHaveLength(1);
    expect(sent[0]!.subject).toBe("2 weekly report deliveries not confirmed");
    expect(sent[0]!.text).toContain("Aug 13, 2026");
    expect(sent[0]!.text).toContain("Aug 6, 2026");
    expect(summary.alerted).toBe(2);
  });

  it("rotates the idempotency key per ANNOUNCEMENT, and names both dimensions in it", async () => {
    // This assertion used to read the other way round — same reports, same key, "so a re-send after an
    // ambiguous outcome is deduped by the provider". It pinned the bug. A cohort digest is a pure function
    // of the report set and the schema, so for a single report it is byte-identical forever, while the
    // email's payload moves with the clock it prints. Same key, different payload is the one combination
    // Resend refuses, and `sendSystemEmailWithMetadata` reads that refusal back as a delivery — so a key
    // that never rotated meant a report could be claimed, logged as announced, and never emailed again.
    //
    // The claim stamp is what rotates it: it is this run's own record of THIS announcement, written to
    // `send_stall_alerted_at` and minted afresh whenever a new claim is taken.
    await seedSend({ sentAt: STALLED_AT });

    const first = await run({ outcome: "unknown" });
    const second = await run({ outcome: "unknown", now: NEXT_TICK });

    expect(second.sent[0]!.idempotencyKey).not.toBe(first.sent[0]!.idempotencyKey);
    // The cohort half is still there — two offices alerting in one tick must not collide, and neither must
    // one office whose stalled set has grown.
    expect(first.sent[0]!.idempotencyKey).toMatch(
      /^weekly-report-stall-office_dallas-20260818T180000000Z-[0-9a-f]{16}$/,
    );
    expect(second.sent[0]!.idempotencyKey).toMatch(
      /^weekly-report-stall-office_dallas-20260818T181500000Z-[0-9a-f]{16}$/,
    );
  });

  it("names the stall threshold it actually used", async () => {
    await seedSend({ sentAt: STALLED_AT });
    const { sent } = await run();
    expect(sent[0]!.text).toContain(`more than ${WEEKLY_REPORT_SEND_STALL_MINUTES} minutes`);
  });
});

describe("the cohort cap", () => {
  // An unbounded cohort is a self-perpetuating failure, not just an ugly email. A database outage stalls
  // every in-flight send at once; the builder renders one detail block per report into ONE message; a
  // large enough message is refused; a refusal is `rejected`, which releases every claim; the next tick
  // assembles the same oversized cohort and is refused again. The alert never arrives, precisely on the
  // incident that most needs it, and silently — a released claim looks exactly like a quiet tick.
  //
  // Absolute count, not derived from WEEKLY_REPORT_SEND_ALERT_MAX_PER_EMAIL: a fixture computed from the
  // constant it tests moves with it and can never fail.
  const OVER_CAP = 30;
  // Absolute week labels, one per seeded report, walking back from 2026-08-13. Distinct weeks rather than
  // distinct projects because SeedSend keys a row by week; the age that makes them stalled comes from
  // `sentAt`, not from `week_of`, so every one of these is inside the alert window.
  const WEEKS = Array.from({ length: OVER_CAP }, (_, i) => {
    const d = new Date(Date.UTC(2026, 7, 13) - i * 7 * 86_400_000);
    return d.toISOString().slice(0, 10);
  });

  it("announces at most 25 reports in one email, and leaves the rest CLAIM-FREE for the next tick", async () => {
    for (let i = 0; i < OVER_CAP; i += 1) {
      await seedSend({ id: U(`9${String(i).padStart(4, "0")}`), sentAt: STALLED_AT, weekOf: WEEKS[i]! });
    }

    const { sent } = await run();

    expect(sent).toHaveLength(1);
    // Claimed exactly the cap — the remainder must keep a NULL stamp or it is marked announced to nobody.
    const alerted = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM office_dallas.weekly_reports WHERE send_stall_alerted_at IS NOT NULL`,
    );
    expect(Number(alerted.rows[0]!.n)).toBe(25);
    expect(sent[0]!.text).toContain("5 more sends are also waiting");
  });

  it("drains rather than deadlocking: the next tick takes what the cap left", async () => {
    for (let i = 0; i < OVER_CAP; i += 1) {
      await seedSend({ id: U(`9${String(i).padStart(4, "0")}`), sentAt: STALLED_AT, weekOf: WEEKS[i]! });
    }

    await run();
    const { sent } = await run();

    expect(sent).toHaveLength(1);
    const alerted = await pg.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM office_dallas.weekly_reports WHERE send_stall_alerted_at IS NOT NULL`,
    );
    expect(Number(alerted.rows[0]!.n)).toBe(OVER_CAP);
    // Nothing left over, so no remainder line — the control for the assertion above.
    expect(sent[0]!.text).not.toContain("also waiting");
  });

  it("says nothing about a remainder when the cohort fits", async () => {
    // The control. Without it, an email that ALWAYS printed the remainder line would pass the cap test.
    await seedSend({ sentAt: STALLED_AT });

    const { sent } = await run();

    expect(sent[0]!.text).not.toContain("also waiting");
    expect(sent[0]!.html).not.toContain("also waiting");
  });
});

describe("email composition helpers", () => {
  it("describes the two shapes of failure differently", () => {
    expect(sendFailureSummary({ sendError: "Resend timed out", sendAttempts: 2 })).toBe("Resend timed out");
    expect(sendFailureSummary({ sendError: null, sendAttempts: 2 })).toBe(
      "No error recorded on the last attempt",
    );
    // The dangerous one: nothing was ever written down.
    expect(sendFailureSummary({ sendError: null, sendAttempts: 0 })).toBe(
      "No delivery attempt was ever recorded — the job never reported back",
    );
  });

  it("truncates an enormous provider error rather than mailing it whole", () => {
    const summary = sendFailureSummary({ sendError: "x".repeat(900), sendAttempts: 1 });
    expect(summary.length).toBeLessThanOrEqual(301);
    expect(summary.endsWith("…")).toBe(true);
  });

  it("puts an age in words", () => {
    expect(formatElapsed(31 * 60_000)).toBe("31 min");
    expect(formatElapsed(60 * 60_000)).toBe("1h 00m");
    expect(formatElapsed(95 * 60_000)).toBe("1h 35m");
    expect(formatElapsed(50 * 60 * 60_000)).toBe("2d 2h");
  });

  it("renders a week label that no timezone can move by a day", () => {
    // The runner's clock is not the office's. A week label built by parsing the ISO date in local time and
    // formatting it in another zone lands on the 12th for half the world.
    const email = buildWeeklyReportSendAlertEmail({
      officeName: "Dallas",
      reports: [
        {
          id: REPORT,
          weeklyReportProjectId: DALLAS_PROJECT,
          projectName: "4123 Cedar Springs",
          projectNumber: "DFW-10432",
          clientName: "Mack Real Estate Group",
          pmName: "Adam Sherwood",
          weekOf: "2026-08-13",
          version: 1,
          sentAt: new Date(STALLED_AT),
          sendLastAttemptAt: null,
          sendAttempts: 0,
          sendError: null,
        },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
      now: NOW,
    });
    expect(email.text).toContain("Week of: Aug 13, 2026");
  });

  it("labels a correction by its version", () => {
    const email = buildWeeklyReportSendAlertEmail({
      officeName: "Dallas",
      reports: [
        {
          id: REPORT,
          weeklyReportProjectId: DALLAS_PROJECT,
          projectName: "4123 Cedar Springs",
          projectNumber: null,
          clientName: null,
          pmName: null,
          weekOf: "2026-08-13",
          version: 2,
          sentAt: new Date(STALLED_AT),
          sendLastAttemptAt: null,
          sendAttempts: 0,
          sendError: null,
        },
      ],
      dashboardUrl: "https://trockcrm.com/projects/weekly-reports",
      now: NOW,
    });
    // A director looking at the board needs to know WHICH version is stuck; "Send correction" on the wrong
    // row is how a client gets a third email.
    expect(email.text).toContain("correction v2");
    expect(email.html).toContain("correction v2");
  });
});

describe("single-flight", () => {
  it("does nothing at all when another replica holds the lock", async () => {
    await seedSend({ sentAt: STALLED_AT });
    const spy = emailSpy();
    const summary = await runWeeklyReportSendSweep({
      query,
      sendEmail: spy.sendEmail,
      env: { FRONTEND_URL: "https://trockcrm.com" },
      now: NOW,
      logger: loggerSpy().logger,
      acquireLock: async () => null,
    });

    expect(spy.sent).toHaveLength(0);
    expect(summary.offices).toBe(0);
    expect((await reportRow()).send_stall_alerted_at).toBeNull();
  });

  it("uses a key of its own, not the reminder cron's", () => {
    // Sharing one would make the two jobs block each other, and a sweep overlapping the 07:00 reminder tick
    // would silently do nothing.
    expect(WEEKLY_REPORT_SEND_SWEEP_LOCK_KEY).toBe(0x57_52_53_57);
  });

  it("releases the lock even when the run throws", async () => {
    let released = false;
    await expect(
      runWeeklyReportSendSweep({
        query: (async () => {
          throw new Error("pool exhausted");
        }) as any,
        now: NOW,
        logger: loggerSpy().logger,
        acquireLock: async () => async () => {
          released = true;
        },
      }),
    ).rejects.toThrow("pool exhausted");
    // A lock left held is a session lock held for the life of the process: every later tick skips, silently
    // and forever.
    expect(released).toBe(true);
  });
});
