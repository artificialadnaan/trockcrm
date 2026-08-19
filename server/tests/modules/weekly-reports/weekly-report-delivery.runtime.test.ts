// Runtime suite for the DELIVERY WEBHOOK: what the mail provider says after the send is over, and how it
// reaches the report row.
//
// Every table is built from the migrations READ FROM DISK — 0222, 0226 and 0227 — because the whole
// feature is three columns, a CHECK and a public lookup table, and a suite that hand-rolled them would be
// asserting a fixture rather than the schema that ships. The CHECK in particular is load-bearing here: a
// test that wrote 'delivered!' and passed would prove nothing about production.
//
// TWO OFFICES, on purpose. A delivery webhook arrives with NO office context at all — no session, no
// header, no tenant hint — and resolves its schema from `public.weekly_report_send_deliveries`. A suite
// with one office cannot tell "resolves the right office" from "writes to the only office there is",
// which is the same blindness that makes a single-tenant test of any search_path code worthless.

import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { deals, files, offices, userOfficeAccess, users } from "@trock-crm/shared/schema";
import { WEEKLY_REPORT_DELIVERY_TAG, parseWeeklyReportDeliveryEvent } from "@trock-crm/shared/lib/weeklyReportDelivery";
import { WON_DEAL_STAGE_SLUGS } from "@trock-crm/shared/types";
import { migrationSql } from "../../helpers/migration-sql.js";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { AppError } from "../../../src/middleware/error-handler.js";
import { createWeeklyReportProject } from "../../../src/modules/weekly-reports/projects-service.js";
import {
  createWeeklyReportDraft,
  transitionWeeklyReport,
  updateWeeklyReportContent,
} from "../../../src/modules/weekly-reports/reports-service.js";
import {
  buildWeeklyReportSendDraft,
  createWeeklyReportCorrection,
  retryWeeklyReportSend,
  sendWeeklyReport,
} from "../../../src/modules/weekly-reports/send-service.js";
import {
  getWeeklyReportDashboard,
  listWeeklyReportProjectSummaries,
} from "../../../src/modules/weekly-reports/dashboard-service.js";
import { ingestWeeklyReportDeliveryEvent } from "../../../src/modules/weekly-reports/delivery-service.js";
import type { withWeeklyReportOfficeClient } from "../../../src/modules/weekly-reports/office-connection.js";

const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const OFFICE = U("00001");
const OTHER_OFFICE = U("00002");
const DEAL = U("11111");
const ATLANTA_DEAL = U("11112");
const ATLANTA_PROJECT = U("11113");
const PM = U("22221");
const SUPER = U("22222");
const DIRECTOR = U("22223");
const WON_STAGE = U("33331");

const PM_ACTOR = { id: PM, role: "construction" };
const SUPER_ACTOR = { id: SUPER, role: "construction" };
const SENDER = { id: DIRECTOR, role: "director" };
const OFFICE_CONTEXT = { tenantId: OFFICE, slug: "dallas" };

const THURSDAY = 4;
const WEEK_OF = "2026-08-13";
const PRIOR_WEEK = "2026-08-06";

/**
 * ABSOLUTE PROVIDER INSTANTS, in order, and deliberately not derived from anything.
 *
 * The rule under test is "the provider's clock decides, not arrival order", so every fixture is a literal
 * ISO instant and the ORDER THEY ARE INGESTED IN is varied independently of the order they are dated in.
 * A suite that ingested them in timestamp order could not tell the rule from "last write wins".
 */
const T_EARLY = "2026-08-13T21:00:00.000Z";
const T_MID = "2026-08-13T21:04:00.000Z";
const T_LATE = "2026-08-13T21:09:00.000Z";

let pg: PGlite;

/** PGlite exposes `query`; rowCount comes from its `affectedRows`, never from rows.length. */
const db = {
  query: async (text: string, params?: unknown[]) => {
    const result = await pg.query(text, params as any[]);
    return {
      rows: result.rows as any[],
      rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
    } as any;
  },
};

/**
 * The office connection, against one PGlite.
 *
 * Mirrors what `withWeeklyReportOfficeClient` does that matters here — pick a search_path from a slug —
 * so the ingest under test really does have to resolve the right office rather than being handed one.
 */
const withOfficeClient = (async (officeSlug: string, _options: unknown, run: (client: typeof db) => Promise<unknown>) => {
  await pg.exec(`SET search_path TO office_${officeSlug}, public;`);
  try {
    return await run(db);
  } finally {
    await pg.exec(`SET search_path TO office_dallas, public;`);
  }
}) as unknown as typeof withWeeklyReportOfficeClient;

async function ingest(payload: unknown) {
  const event = parseWeeklyReportDeliveryEvent(payload);
  if (!event) throw new Error("fixture did not parse as a delivery event");
  return ingestWeeklyReportDeliveryEvent(event, { publicClient: db, withOfficeClient });
}

function providerEvent(input: {
  type: string;
  createdAt: string;
  deliveryKey: string;
  bounce?: { type: string; subType: string; message: string };
}) {
  return {
    type: input.type,
    created_at: input.createdAt,
    data: {
      email_id: "e1f2a3b4-0000-4000-8000-000000000001",
      from: "crm@trockconstruction.com",
      to: ["jay@example.com"],
      subject: "Weekly Progress Report",
      // The EMAIL's creation time — identical on every event about it, and never the ordering key.
      created_at: "2026-08-13T20:59:00.000Z",
      tags: { [WEEKLY_REPORT_DELIVERY_TAG]: input.deliveryKey },
      ...(input.bounce ? { bounce: input.bounce } : {}),
    },
  };
}

const HARD_BOUNCE = { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 user unknown" };

async function inTransaction<T>(run: () => Promise<T>): Promise<T> {
  await pg.exec("BEGIN");
  try {
    const result = await run();
    await pg.exec("COMMIT");
    return result;
  } catch (error) {
    await pg.exec("ROLLBACK");
    throw error;
  }
}

async function expectAppError(promise: Promise<unknown>, status: number, matcher?: RegExp) {
  let caught: unknown;
  try {
    await promise;
  } catch (error) {
    caught = error;
  }
  if (caught === undefined) throw new Error(`Expected an AppError ${status}, but the call resolved`);
  expect(caught).toBeInstanceOf(AppError);
  expect((caught as AppError).statusCode).toBe(status);
  if (matcher) expect((caught as AppError).message).toMatch(matcher);
}

function shareUrlFor(rawToken: string): string {
  return `https://reports.example.com/wr/${rawToken}`;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS office_dallas; CREATE SCHEMA IF NOT EXISTS office_atlanta;`);
  await pg.exec(tenantSchemaSql("public", [offices, users, userOfficeAccess]));
  // Both offices get `deals`/`files` BEFORE 0222 runs — that migration skips any office schema lacking
  // them, so a second office created afterwards would silently have no weekly_reports at all and the
  // cross-office case would quietly degrade into a single-office one.
  await pg.exec(tenantSchemaSql("office_dallas", [deals, files]));
  await pg.exec(tenantSchemaSql("office_atlanta", [deals, files]));
  await pg.exec(`CREATE TABLE IF NOT EXISTS public.pipeline_stage_config (id uuid PRIMARY KEY, slug text);`);
  await pg.exec(`
    DO $$ BEGIN
      CREATE TYPE job_status AS ENUM ('pending', 'processing', 'completed', 'failed', 'dead');
    EXCEPTION WHEN duplicate_object THEN NULL; END $$;
    CREATE TABLE IF NOT EXISTS public.job_queue (
      id                    BIGSERIAL PRIMARY KEY,
      job_type              VARCHAR(100) NOT NULL,
      payload               JSONB NOT NULL,
      office_id             UUID,
      status                job_status NOT NULL DEFAULT 'pending',
      attempts              INTEGER NOT NULL DEFAULT 0,
      max_attempts          INTEGER NOT NULL DEFAULT 3,
      last_error            TEXT,
      started_processing_at TIMESTAMPTZ,
      run_after             TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      created_at            TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      completed_at          TIMESTAMPTZ
    );
  `);
  await pg.exec(migrationSql("0222_weekly_reports"));
  await pg.exec(migrationSql("0223_weekly_report_pauses"));
  await pg.exec(migrationSql("0226_weekly_report_send"));
  await pg.exec(migrationSql("0227_weekly_report_delivery_events"));
  // The sweep's 0227 too, once both are on one branch: `retryWeeklyReportSend` clears
  // `send_stall_alerted_at` in the same statement that moves the stall clock, so a retry here fails on
  // an undefined column without it.
  await pg.exec(migrationSql("0227_weekly_report_send_stall_alerted"));

  await pg.exec(`
    INSERT INTO public.offices (id, name, slug) VALUES
      ('${OFFICE}', 'Dallas', 'dallas'), ('${OTHER_OFFICE}', 'Atlanta', 'atlanta');
    INSERT INTO public.users (id, display_name, email, role, office_id, phone) VALUES
      ('${PM}', 'Adam Sherwood', 'adam@trockconstruction.com', 'construction', '${OFFICE}', '(214) 555-0142'),
      ('${SUPER}', 'Steve Sanchez', 'super@example.com', 'construction', '${OFFICE}', NULL),
      ('${DIRECTOR}', 'Takashi', 'director@example.com', 'director', '${OFFICE}', NULL);
    INSERT INTO public.pipeline_stage_config (id, slug) VALUES ('${WON_STAGE}', '${WON_DEAL_STAGE_SLUGS[0]}');
    INSERT INTO office_dallas.deals (id, name, deal_number, stage_id, project_number) VALUES
      ('${DEAL}', '4123 Cedar Springs', 'DFW-10432', '${WON_STAGE}', 'DFW-10432');
    SET search_path TO office_dallas, public;
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  await pg.exec(`
    SET search_path TO office_dallas, public;
    DELETE FROM public.weekly_report_send_deliveries;
    DELETE FROM public.weekly_report_tokens;
    DELETE FROM public.job_queue;
    DELETE FROM office_dallas.weekly_report_photos;
    DELETE FROM office_dallas.weekly_reports;
    DELETE FROM office_dallas.weekly_report_projects;
    DELETE FROM office_atlanta.weekly_reports;
    DELETE FROM office_atlanta.weekly_report_projects;
  `);
});

let submissionSeq = 0;
async function seedApprovedReport(options: { weekOf?: string; projectId?: string } = {}) {
  submissionSeq += 1;
  const project = options.projectId
    ? { id: options.projectId }
    : await createWeeklyReportProject(
        db,
        {
          dealId: DEAL,
          propertyDisplayName: "4123 Cedar Springs",
          clientName: "Mack Real Estate Group",
          clientTeam: { doc: { name: "Jay Stauble", email: "jay@example.com" } },
          trockPmUserId: PM,
          trockSuperUserId: SUPER,
          contractDate: "2026-07-08",
          projectedDurationWeeks: 19,
          cadenceWeekday: THURSDAY,
          cadenceStartDate: "2026-07-27",
        } as any,
        DIRECTOR,
        OFFICE,
      );
  const { report } = await createWeeklyReportDraft(
    db,
    {
      clientSubmissionId: U(`5${String(submissionSeq).padStart(4, "0")}`),
      weeklyReportProjectId: project.id,
      weekOf: options.weekOf ?? WEEK_OF,
    },
    SUPER_ACTOR,
  );
  await updateWeeklyReportContent(
    db,
    report.id,
    { workCompleted: "Framing complete on levels 3 and 4.", completionPercent: 42 },
    SUPER_ACTOR,
  );
  await transitionWeeklyReport(db, report.id, "pending_review", SUPER_ACTOR);
  await transitionWeeklyReport(db, report.id, "approved", PM_ACTOR);
  return { projectId: project.id, reportId: report.id };
}

/** Send it, exactly as the CRM route does, and hand back the delivery key the provider will echo. */
async function sendReport(reportId: string): Promise<string> {
  await inTransaction(() =>
    sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    }),
  );
  const row = await reportRow(reportId);
  return String(row.send_delivery_key);
}

/**
 * `projectId` is threaded through because a deal has at most ONE live weekly-report setup
 * (`weekly_report_projects_deal_uidx`), so a second `sentWeek` in the same test must reuse the first's
 * project rather than creating another.
 */
async function sentWeek(weekOf: string, projectId?: string) {
  const seeded = await seedApprovedReport({ weekOf, projectId });
  const deliveryKey = await sendReport(seeded.reportId);
  return { reportId: seeded.reportId, projectId: seeded.projectId, deliveryKey };
}

async function reportRow(id: string): Promise<Record<string, any>> {
  const result = await pg.query(`SELECT * FROM office_dallas.weekly_reports WHERE id = $1::uuid`, [id]);
  return result.rows[0] as Record<string, any>;
}

/** Stand in for the worker stamping provider ACCEPTANCE — which is all `send_delivered_at` ever means. */
async function markAccepted(reportId: string): Promise<void> {
  await pg.query(
    `UPDATE office_dallas.weekly_reports
        SET send_delivered_at = now(), send_error = NULL, send_attempts = send_attempts + 1
      WHERE id = $1::uuid`,
    [reportId],
  );
}

describe("registering the delivery key", () => {
  it("writes the office map in the SAME transaction as the send", async () => {
    const { reportId } = await seedApprovedReport();
    const deliveryKey = await sendReport(reportId);

    const rows = await pg.query(
      `SELECT * FROM public.weekly_report_send_deliveries WHERE delivery_key = $1::uuid`,
      [deliveryKey],
    );
    expect(rows.rows[0]).toMatchObject({
      weekly_report_id: reportId,
      tenant_id: OFFICE,
      office_slug: "dallas",
    });
  });

  it("leaves NO map row behind when the send is rolled back", async () => {
    // The pairing that matters. A map row for a report that never reached `sent` would resolve a bounce
    // to a report nobody sent; a `sent` report with no map row would drop its bounce silently. Both are
    // prevented by the same thing — being in the caller's transaction — so both are asserted.
    const { reportId } = await seedApprovedReport();
    await pg.exec("BEGIN");
    await sendWeeklyReport(db, {
      reportId,
      office: OFFICE_CONTEXT,
      actor: SENDER,
      payload: { recipients: ["jay@example.com"] },
      shareUrlFor,
    });
    await pg.exec("ROLLBACK");

    const rows = await pg.query(`SELECT COUNT(*)::int AS n FROM public.weekly_report_send_deliveries`);
    expect((rows.rows[0] as { n: number }).n).toBe(0);
    expect((await reportRow(reportId)).status).toBe("approved");
  });

  it("does not add a second row when a send is RETRIED", async () => {
    // A retry replays the same request under the same key by design; a unique-violation here would turn
    // the one recovery path an undelivered report has into a 500.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await inTransaction(() => retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT));

    const rows = await pg.query(`SELECT delivery_key FROM public.weekly_report_send_deliveries`);
    expect(rows.rows).toEqual([{ delivery_key: deliveryKey }]);
  });

  it("REGISTERS a key that has no map row when the send is retried", async () => {
    // The worker tags EVERY message it sends, replays included, but only `sendWeeklyReport` wrote the map
    // row — so a retry put a delivery key on a real client email that nothing could resolve, and its
    // bounce was dropped on the floor. That is precisely the silence this feature exists to end, on
    // precisely the rows the board renders a Retry button beside.
    //
    // Two ways in, and neither is exotic. Every send committed before this deploy has no map row at all
    // (the population the board offers Retry on is `status = 'sent' AND send_delivered_at IS NULL`, which
    // is exactly those rows), and permanently: the API and the worker are separate Railway services, so a
    // send committed by the old API while the new worker is live gets a tagged message and no map row.
    //
    // Deleting the row is how the first of those is modelled — a `sent` report whose key is on the
    // message and in no map.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await pg.query(`DELETE FROM public.weekly_report_send_deliveries WHERE delivery_key = $1::uuid`, [deliveryKey]);
    const dropped = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_EARLY, deliveryKey, bounce: HARD_BOUNCE }),
    );
    expect(dropped.outcome).toBe("unknown_key");

    await inTransaction(() => retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT));

    const rows = await pg.query(
      `SELECT weekly_report_id, tenant_id, office_slug
         FROM public.weekly_report_send_deliveries WHERE delivery_key = $1::uuid`,
      [deliveryKey],
    );
    expect(rows.rows[0]).toMatchObject({
      weekly_report_id: reportId,
      tenant_id: OFFICE,
      office_slug: "dallas",
    });

    // Registering the row is only worth anything if the verdict then lands, so the assertion runs the
    // whole ingest rather than stopping at the insert.
    const applied = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_LATE, deliveryKey, bounce: HARD_BOUNCE }),
    );
    expect(applied.outcome).toBe("applied");
    expect((await reportRow(reportId)).send_delivery_status).toBe("bounced");
  });
});

describe("recording what the provider said", () => {
  it("stamps the verdict WITHOUT touching send_delivered_at or updated_at", async () => {
    // The `send_delivered_at` decision, asserted rather than described. It means "the provider accepted
    // the message" and four surfaces read it that way; the webhook adds a sibling and rewrites nothing.
    //
    // `updated_at` is in the same assertion for a different reason: it is the PDF artifact's cache
    // generation (pdf-artifact.ts). Bumping it on a delivery receipt would invalidate the stored PDF of
    // every report the moment its receipt arrived and re-render it — every photo downloaded and
    // transcoded again — to record something that is not in the document.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);
    const before = await reportRow(reportId);

    const result = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }),
    );
    expect(result.outcome).toBe("applied");

    const after = await reportRow(reportId);
    expect(after.send_delivery_status).toBe("bounced");
    expect(new Date(after.send_delivery_status_at).toISOString()).toBe(T_MID);
    expect(after.send_delivery_detail).toMatchObject({
      eventType: "email.bounced",
      bounceClass: "hard",
      bounceSubType: "NoEmail",
      message: "550 5.1.1 user unknown",
    });
    expect(after.send_delivered_at).toEqual(before.send_delivered_at);
    expect(after.send_delivered_at).not.toBeNull();
    expect(after.updated_at).toEqual(before.updated_at);
  });

  it("records a delivery and a complaint too", async () => {
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    expect((await ingest(providerEvent({ type: "email.delivered", createdAt: T_EARLY, deliveryKey }))).outcome).toBe(
      "applied",
    );
    expect((await reportRow(reportId)).send_delivery_status).toBe("delivered");

    expect((await ingest(providerEvent({ type: "email.complained", createdAt: T_LATE, deliveryKey }))).outcome).toBe(
      "applied",
    );
    expect((await reportRow(reportId)).send_delivery_status).toBe("complained");
  });
});

describe("events that arrive out of order and more than once", () => {
  it("does NOT let a late `delivered` overwrite a later `bounced`", async () => {
    // The headline failure mode. The provider retries a `delivered` it could not hand over, so it lands
    // AFTER the bounce that superseded it — and a row ordered by arrival would go back to claiming the
    // client has their report.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_LATE, deliveryKey, bounce: HARD_BOUNCE }));
    const late = await ingest(providerEvent({ type: "email.delivered", createdAt: T_EARLY, deliveryKey }));

    expect(late.outcome).toBe("superseded");
    const row = await reportRow(reportId);
    expect(row.send_delivery_status).toBe("bounced");
    expect(new Date(row.send_delivery_status_at).toISOString()).toBe(T_LATE);
  });

  it("does NOT let a later `delivered` for a SECOND RECIPIENT clear the bounce either", async () => {
    // INVERTED. This used to read "DOES let a genuinely later `delivered` clear an earlier bounce",
    // justified as a soft bounce followed by a provider retry the receiving server accepts.
    //
    // There is no such retry to wait for — a bounce is emitted once the sending side has GIVEN UP, after
    // SES has done its own retrying — and, far more to the point, the two events here are not about the
    // same mailbox. One send goes to up to four client contacts plus the live SYSTEM_EMAIL_BCC, the
    // provider emits one event per RECIPIENT, and all of them carry this one delivery key with nothing in
    // the payload naming the address. So the realistic sequence is exactly this one: the client's address
    // is refused at RCPT TO, and two minutes later the Gmail bcc copy lands. Letting the second one win
    // took the chip off the board, dropped the week out of "Send failures", and filed it away as settled
    // while the client had no report.
    //
    // Ingested in DATED order here, which is the strongest version of the assertion: the row refuses the
    // `delivered` even though it is the newest thing the platform knows.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_EARLY, deliveryKey, bounce: HARD_BOUNCE }));
    const later = await ingest(providerEvent({ type: "email.delivered", createdAt: T_LATE, deliveryKey }));

    expect(later.outcome).toBe("superseded");
    const row = await reportRow(reportId);
    expect(row.send_delivery_status).toBe("bounced");
    // The bounce's OWN facts survive too — a verdict kept with somebody else's timestamp and detail would
    // send whoever answers the support call to the wrong recipient.
    expect(new Date(row.send_delivery_status_at).toISOString()).toBe(T_EARLY);
    expect(row.send_delivery_detail).toMatchObject({ eventType: "email.bounced", bounceClass: "hard" });
  });

  it("does not let a later COMPLAINT clear a bounce, and still records one over a delivery", async () => {
    // A spam complaint is a human pressing a button in a mail client, so it is ALWAYS dated after the
    // bounce it would erase — the worst case for a rule that reads the clock first. It is not a delivery
    // failure (`weeklyReportDeliveryFailed` is false for it), so under recency it took the chip off the
    // board just as `delivered` did.
    const bounceFirst = await sentWeek(WEEK_OF);
    await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_EARLY, deliveryKey: bounceFirst.deliveryKey, bounce: HARD_BOUNCE }),
    );
    const complaint = await ingest(
      providerEvent({ type: "email.complained", createdAt: T_LATE, deliveryKey: bounceFirst.deliveryKey }),
    );
    expect(complaint.outcome).toBe("superseded");
    expect((await reportRow(bounceFirst.reportId)).send_delivery_status).toBe("bounced");

    // THE CONTROL, and it is the reason this is not simply "failures win". A complaint can only follow a
    // delivery, so over a `delivered` it strictly adds — the client has this report and does not want the
    // next one — and it must still be recorded, or the History chip would never show a complaint at all.
    const delivered = await sentWeek(PRIOR_WEEK, bounceFirst.projectId);
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_LATE, deliveryKey: delivered.deliveryKey }));
    const recorded = await ingest(
      providerEvent({ type: "email.complained", createdAt: T_EARLY, deliveryKey: delivered.deliveryKey }),
    );
    expect(recorded.outcome).toBe("applied");
    expect((await reportRow(delivered.reportId)).send_delivery_status).toBe("complained");
  });

  it("keeps the latest bounce's own detail when a second recipient bounces too", async () => {
    // The clock is still the rule INSIDE a verdict, and this is what it buys: two contacts on one message
    // bounce for different reasons, and the row should describe the most recent one rather than whichever
    // arrived first. Without it a ratchet that ignored the clock entirely would freeze the first bounce's
    // hard/soft class in place, and hard versus full-mailbox call for opposite actions from the PM.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await ingest(
      providerEvent({
        type: "email.bounced",
        createdAt: T_EARLY,
        deliveryKey,
        bounce: { type: "Transient", subType: "MailboxFull", message: "552 mailbox full" },
      }),
    );
    const second = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_LATE, deliveryKey, bounce: HARD_BOUNCE }),
    );

    expect(second.outcome).toBe("applied");
    const row = await reportRow(reportId);
    expect(row.send_delivery_detail).toMatchObject({ bounceClass: "hard", bounceSubType: "NoEmail" });
    expect(new Date(row.send_delivery_status_at).toISOString()).toBe(T_LATE);
  });

  it("is idempotent — the same event five times writes once", async () => {
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    const payload = providerEvent({
      type: "email.bounced",
      createdAt: T_MID,
      deliveryKey,
      bounce: HARD_BOUNCE,
    });

    expect((await ingest(payload)).outcome).toBe("applied");
    const after = await reportRow(reportId);
    for (let i = 0; i < 4; i += 1) {
      expect((await ingest(payload)).outcome).toBe("superseded");
    }
    expect(await reportRow(reportId)).toEqual(after);
  });

  it("breaks an exact timestamp tie towards the failure, whichever order they arrive in", async () => {
    // Two events on the same instant is a shape the provider does not promise never to emit, and there is
    // no clock left to separate them. Asserted in BOTH ingest orders, because a rule that only worked one
    // way round would still pass a single-order test.
    const first = await sentWeek(WEEK_OF);
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_MID, deliveryKey: first.deliveryKey }));
    await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey: first.deliveryKey, bounce: HARD_BOUNCE }),
    );
    expect((await reportRow(first.reportId)).send_delivery_status).toBe("bounced");

    const second = await sentWeek(PRIOR_WEEK, first.projectId);
    await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey: second.deliveryKey, bounce: HARD_BOUNCE }),
    );
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_MID, deliveryKey: second.deliveryKey }));
    expect((await reportRow(second.reportId)).send_delivery_status).toBe("bounced");
  });
});

describe("one version's verdict never lands on another's", () => {
  it("leaves version N+1 untouched when version N bounces", async () => {
    // Corrections share a client, a project and a week — everything except a delivery key. That is the
    // whole reason 0226 mints the key per SEND REQUEST, and the reason this does not correlate on a
    // recomposed identity, which would collapse the two.
    const { reportId: v1 } = await seedApprovedReport({ weekOf: WEEK_OF });
    const key1 = await sendReport(v1);
    await markAccepted(v1);

    const correction = await inTransaction(() => createWeeklyReportCorrection(db, v1, SENDER));
    const key2 = await sendReport(correction.id);
    expect(key2).not.toBe(key1);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey: key1, bounce: HARD_BOUNCE }));

    expect((await reportRow(v1)).send_delivery_status).toBe("bounced");
    expect((await reportRow(correction.id)).send_delivery_status).toBeNull();

    // And the other direction: delivering v2 must not clear v1's bounce.
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_LATE, deliveryKey: key2 }));
    expect((await reportRow(correction.id)).send_delivery_status).toBe("delivered");
    expect((await reportRow(v1)).send_delivery_status).toBe("bounced");
  });

  it("writes nothing when the report's key has moved on from the map's", async () => {
    // Belt and braces on the UPDATE's `send_delivery_key` predicate. The map row and the report row are
    // two separate facts; conditioning on both means a key that has somehow moved writes nothing at all
    // rather than writing to whatever the id now points at.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await pg.query(`UPDATE office_dallas.weekly_reports SET send_delivery_key = gen_random_uuid() WHERE id = $1::uuid`, [
      reportId,
    ]);

    const result = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }),
    );
    expect(result.outcome).toBe("unmatched");
    expect((await reportRow(reportId)).send_delivery_status).toBeNull();
  });
});

describe("offices", () => {
  it("resolves the delivery key's OWN office and writes only there", async () => {
    const dallas = await sentWeek(WEEK_OF);

    // An Atlanta report with its own key, registered the same way the send would have. Built through the
    // real FK chain (deal -> setup -> report) rather than with invented ids, so the row is one this
    // schema would actually hold.
    const atlantaReport = U("77777");
    const atlantaKey = "5c9e1d33-2a4b-4c6d-8e0f-1a2b3c4d5e6f";
    await pg.exec(`
      INSERT INTO office_atlanta.deals (id, name, deal_number, stage_id, project_number)
      VALUES ('${ATLANTA_DEAL}', 'Peachtree Center', 'ATL-2001', '${WON_STAGE}', 'ATL-2001')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO office_atlanta.weekly_report_projects
        (id, deal_id, cadence_weekday, cadence_start_date)
      VALUES ('${ATLANTA_PROJECT}', '${ATLANTA_DEAL}', ${THURSDAY}, '2026-07-27')
      ON CONFLICT (id) DO NOTHING;
      INSERT INTO office_atlanta.weekly_reports
        (id, client_submission_id, weekly_report_project_id, deal_id, week_of, version, status,
         send_delivery_key, send_delivered_at)
      VALUES ('${atlantaReport}', gen_random_uuid(), '${ATLANTA_PROJECT}', '${ATLANTA_DEAL}', '${WEEK_OF}', 1,
              'sent', '${atlantaKey}', now());
      INSERT INTO public.weekly_report_send_deliveries (delivery_key, weekly_report_id, tenant_id, office_slug)
      VALUES ('${atlantaKey}', '${atlantaReport}', '${OTHER_OFFICE}', 'atlanta');
    `);

    const result = await ingest(
      providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey: atlantaKey, bounce: HARD_BOUNCE }),
    );
    expect(result.outcome).toBe("applied");
    expect(result.target?.officeSlug).toBe("atlanta");

    const atlanta = await pg.query(
      `SELECT send_delivery_status FROM office_atlanta.weekly_reports WHERE id = $1::uuid`,
      [atlantaReport],
    );
    expect((atlanta.rows[0] as { send_delivery_status: string }).send_delivery_status).toBe("bounced");
    // The Dallas report of the same week is untouched — the whole point of resolving rather than scanning.
    expect((await reportRow(dallas.reportId)).send_delivery_status).toBeNull();
  });

  it("answers `unknown_key` for a key this platform never minted, and writes nothing", async () => {
    // The route turns this into the SAME 202 as everything else — a delivery key identifies a specific
    // client's correspondence, and an endpoint that distinguished them would let anyone enumerate them.
    const { reportId } = await sentWeek(WEEK_OF);
    const result = await ingest(
      providerEvent({
        type: "email.bounced",
        createdAt: T_MID,
        deliveryKey: "00000000-0000-4000-8000-999999999999",
        bounce: HARD_BOUNCE,
      }),
    );
    expect(result).toEqual({ outcome: "unknown_key", target: null });
    expect((await reportRow(reportId)).send_delivery_status).toBeNull();
  });
});

describe("what the rest of the platform then says", () => {
  it("stops calling a bounced version something a correction REPLACES", async () => {
    // `isCorrection` decides a sentence a paying client reads. Keyed on acceptance alone, a v1 that
    // hard-bounced counted as "reached the client", so v2 told them it replaces a copy they never got and
    // sent them hunting through their mailbox for it.
    const { reportId: v1, projectId } = await seedApprovedReport({ weekOf: WEEK_OF });
    const key1 = await sendReport(v1);
    await markAccepted(v1);

    const beforeBounce = await seedApprovedReport({ weekOf: PRIOR_WEEK, projectId });
    expect(beforeBounce.reportId).toBeTruthy();

    const correction = await inTransaction(() => createWeeklyReportCorrection(db, v1, SENDER));
    const asCorrection = await buildWeeklyReportSendDraft(db, correction.id, SENDER);
    expect(asCorrection.isCorrection).toBe(true);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey: key1, bounce: HARD_BOUNCE }));

    const afterBounce = await buildWeeklyReportSendDraft(db, correction.id, SENDER);
    expect(afterBounce.isCorrection).toBe(false);
    expect(afterBounce.bodyPreview).not.toMatch(/replaces/i);
  });

  it("still calls it a correction after a COMPLAINT, because they did receive it", async () => {
    const { reportId: v1 } = await seedApprovedReport({ weekOf: WEEK_OF });
    const key1 = await sendReport(v1);
    await markAccepted(v1);
    await ingest(providerEvent({ type: "email.complained", createdAt: T_MID, deliveryKey: key1 }));

    const correction = await inTransaction(() => createWeeklyReportCorrection(db, v1, SENDER));
    expect((await buildWeeklyReportSendDraft(db, correction.id, SENDER)).isCorrection).toBe(true);
  });

  it("refuses a retry on a bounced send and says WHY, instead of `already accepted`", async () => {
    // The refusal itself does not change — a retry replays the same message to the same address under
    // the same idempotency key, so it cannot reach anybody. What changes is the wording: "already
    // accepted by the mail provider" points a PM at a correction as though the client merely needs a
    // newer copy, when what they need is a different address.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));

    await expectAppError(
      inTransaction(() => retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT)),
      409,
      /not delivered/i,
    );
    await expectAppError(
      inTransaction(() => retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT)),
      409,
      /bad address/i,
    );
  });

  it("keeps the plain acceptance wording when no verdict has arrived", async () => {
    // The control. Without it the branch above could be reached for every delivered report and this
    // suite would not notice.
    const { reportId } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);
    await expectAppError(
      inTransaction(() => retryWeeklyReportSend(db, reportId, SENDER, OFFICE_CONTEXT)),
      409,
      /accepted by the mail provider/i,
    );
  });

  it("keeps a bounced week ON the board instead of filing it away as sent", async () => {
    // A bounced report has `send_delivered_at` SET, so it is in none of the board's three undelivered
    // shapes and a past week carrying one was dropped with the rest of the archive — the client never
    // receives their report and the page built to catch that says nothing.
    const { reportId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);

    const filedAway = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(filedAway.rows.some((row) => row.weekOf === PRIOR_WEEK)).toBe(false);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row).toBeDefined();
    expect(row!.sendBounced).toBe(true);
    expect(row!.sendDeliveryStatus).toBe("bounced");
    // The three older verdicts stay FALSE, which is the fact that made this invisible in the first place.
    expect(row!.sendFailed).toBe(false);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendPending).toBe(false);
    expect(row!.sendDeliveredAt).not.toBeNull();
    expect(row!.waitingOn).toBe("Adam Sherwood");
  });

  it("does not put a delivered week back on the board", async () => {
    // The control for the case above: only a FAILURE verdict reopens a filed week. A `delivered` one
    // reopening it would put every successfully delivered report back on the board forever.
    const { reportId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_MID, deliveryKey }));

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.some((row) => row.weekOf === PRIOR_WEEK)).toBe(false);
  });
});

/**
 * "Two surfaces, one definition of 'still owed'" — now that a THIRD way to be still-owed exists.
 *
 * The Projects tab's four aggregates all key on `send_delivered_at`, which a bounced report HAS: the
 * provider accepted the message and the receiving server refused it afterwards. So This Week showed a red
 * "Not delivered" while the tab beside it counted the same report under "Reports sent" (whose own comment
 * says "The count is DELIVERED reports"), showed no "N not delivered" badge, and printed "Last sent · wk
 * …" for a week nothing was delivered in — a number a director reads aloud to the client.
 */
describe("the Projects tab counts the same sends the board does", () => {
  it("stops counting a bounced report as one the client received", async () => {
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);

    // THE CONTROL, taken first: with nothing but acceptance on the row this IS a delivered report as far
    // as anything can tell, and the tab must go on counting it. Without this the assertions below would
    // be satisfied by a tab that counted nothing at all.
    const accepted = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(accepted.reportsSent).toBe(1);
    expect(accepted.lastSentWeekOf).toBe(WEEK_OF);
    expect(accepted.lastSentAt).not.toBeNull();
    expect(accepted.undeliveredSends).toBe(0);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.find((row) => row.weekOf === WEEK_OF)!.sendBounced).toBe(true);

    const bounced = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(bounced.reportsSent).toBe(0);
    expect(bounced.undeliveredSends).toBe(1);
    expect(bounced.lastSentAt).toBeNull();
    expect(bounced.lastSentWeekOf).toBeNull();
  });

  it("goes on counting a COMPLAINT as delivered, because it was", async () => {
    // The second control, and the one that keeps the predicate honest about which verdicts mean the
    // client has nothing. A spam complaint can only follow a delivery; counting it as undelivered would
    // put a permanent red badge on a report the client demonstrably read.
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.complained", createdAt: T_MID, deliveryKey }));

    const summary = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(summary.reportsSent).toBe(1);
    expect(summary.undeliveredSends).toBe(0);
    expect(summary.lastSentWeekOf).toBe(WEEK_OF);
  });

  it("accounts on the BOARD for a bounced week the cadence no longer generates", async () => {
    // The other half of the same invariant, and the reason the tab's predicate could not simply be
    // widened on its own. This aggregate counts every send on every `wrp.is_active` setup; the board
    // reaches most weeks through the cadence, which a completed setup generates nothing for. Counting the
    // bounce here while the board had no row for it would be the exact drift PR5 removed for undelivered
    // sends — a red number on one tab with no chip and no row on the other.
    const { reportId, projectId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));
    // The common end state: the last report of a job bounces and somebody marks the setup completed.
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'completed' WHERE id = $1::uuid`, [
      projectId,
    ]);

    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(1);

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    const row = board.rows.find((entry) => entry.weekOf === PRIOR_WEEK);
    expect(row).toBeDefined();
    expect(row!.sendBounced).toBe(true);
    expect(row!.sendDeliveryStatus).toBe("bounced");
    // Not "Sending…" and not "Send stuck": the provider has spoken, and both of those chips would send a
    // PM to wait for a delivery that is never coming.
    expect(row!.sendPending).toBe(false);
    expect(row!.sendStalled).toBe(false);
    expect(row!.sendFailed).toBe(false);
    // A retry cannot reach a refused address, and `retryWeeklyReportSend` refuses one — so the board must
    // not offer the button.
    expect(row!.sendRetryReportId).toBeNull();
    expect(row!.waitingOn).toBe("Adam Sherwood");
  });

  it("leaves a delivered week off the board when its cadence has stopped", async () => {
    // The control for the pass above: it must be driven by the FAILURE, not by "the cadence stopped".
    const { reportId, projectId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_MID, deliveryKey }));
    await pg.query(`UPDATE office_dallas.weekly_report_projects SET status = 'completed' WHERE id = $1::uuid`, [
      projectId,
    ]);

    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(0);
    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF });
    expect(board.rows.some((entry) => entry.weekOf === PRIOR_WEEK)).toBe(false);
  });
});

/**
 * Drafting a correction over a bounced week must not take the bounce off the board.
 *
 * The same disappearance PR5 fixed for undelivered sends with a second query: `sendBounced` was read off
 * the DISTINCT ON … version DESC live row, and a correction is a higher version that is not superseded
 * until it is SENT — so it becomes live the moment the PM clicks the button the confirm copy tells them
 * to click, carrying `send_delivery_status = NULL`. The red chip and the row's entry in the "Send
 * failures" card both vanished on that click.
 */
describe("a correction drafted over a bounce", () => {
  it("keeps the bounce on the board and in the tab's count until the correction is SENT", async () => {
    const { reportId, deliveryKey } = await sentWeek(WEEK_OF);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));

    const before = (await getWeeklyReportDashboard(db, { asOf: WEEK_OF })).rows.find((r) => r.weekOf === WEEK_OF)!;
    expect(before.sendBounced).toBe(true);
    expect(before.sendDeliveryStatus).toBe("bounced");

    const correction = await inTransaction(() => createWeeklyReportCorrection(db, reportId, SENDER));

    const during = (await getWeeklyReportDashboard(db, { asOf: WEEK_OF })).rows.find((r) => r.weekOf === WEEK_OF)!;
    // The week's LIVE state really is the unsent correction — that part was never wrong.
    expect(during.state).toBe("approved");
    expect(during.reportId).toBe(correction.id);
    // What must not follow from it is the failure disappearing. The client still has no report.
    expect(during.sendBounced).toBe(true);
    expect(during.sendDeliveryStatus).toBe("bounced");
    expect(during.waitingOn).toBe("Adam Sherwood");
    expect((await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!.undeliveredSends).toBe(1);

    // THE CONTROL. Once the correction has actually gone out and been accepted, the original is
    // superseded and the bounce stops being outstanding — a chip that could never clear would be its own
    // kind of lie, and the retry gate depends on this releasing.
    await sendReport(correction.id);
    await markAccepted(correction.id);

    const after = (await getWeeklyReportDashboard(db, { asOf: WEEK_OF })).rows.find((r) => r.weekOf === WEEK_OF)!;
    expect(after.sendBounced).toBe(false);
    expect(after.state).toBe("sent");
    const tab = (await listWeeklyReportProjectSummaries(db, WEEK_OF))[0]!;
    expect(tab.undeliveredSends).toBe(0);
    expect(tab.reportsSent).toBe(1);
  });
});

/**
 * THE "AND N OLDER" TALLY, which is where this webhook and the delivered-version lookup MEET.
 *
 * Beyond the lookback window a week is never rendered — it is only counted — so `settled` in the tally
 * loop is the ONLY thing standing between a bounced week and total silence. Nothing else on the board
 * mentions it: no row, no chip, no Retry, and the banner a director reads says the backlog is one week
 * shorter than it is.
 *
 * The trap is that `deliveredByKey` cannot see a bounce. It asks `send_delivered_at IS NOT NULL`, which is
 * provider ACCEPTANCE, and a bounced report was accepted before it was refused — so a bounced week is in
 * the delivered set AND absent from the undelivered set, and a `settled` that consults only those two
 * files it away as a week the client has. Neither branch alone can produce that state, which is why
 * neither branch's suite covers it: the bounce verdict and the delivered lookup arrive from different
 * PRs, and the defect exists only once both are in the same file.
 */
describe("a bounced week beyond the lookback window", () => {
  it("stays in the older-outstanding tally instead of being filed away as delivered", async () => {
    // ABSOLUTE ARITHMETIC, not a before/after delta. `cadenceStartDate` is 2026-07-27 and the board date
    // is 2026-08-13, so the Thursdays expected are 07-30, 08-06 and 08-13 — three weeks, of which
    // `lookbackWeeks: 1` renders the last and tallies the other two. 07-30 was never filed, so it is
    // outstanding in every scenario below and the tally floor is 1.
    const { reportId, projectId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);

    // THE CONTROL, taken first: with nothing but acceptance on the row PRIOR_WEEK really is settled, and
    // the tally must be the floor. Without it the assertion below would be satisfied by a tally that
    // counted every week unconditionally.
    const accepted = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 1 });
    expect(accepted.rows.some((row) => row.weekOf === PRIOR_WEEK)).toBe(false);
    expect(accepted.olderOutstandingCounts[projectId]).toBe(1);

    await ingest(providerEvent({ type: "email.bounced", createdAt: T_MID, deliveryKey, bounce: HARD_BOUNCE }));

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 1 });
    // Still no ROW — past the window nothing is rendered — which is precisely why the count is the only
    // thing that can carry the failure, and why getting it wrong is silent.
    expect(board.rows.some((row) => row.weekOf === PRIOR_WEEK)).toBe(false);
    expect(board.olderOutstandingCounts[projectId]).toBe(2);
  });

  it("still files a genuinely DELIVERED week away, so the tally is not simply counting everything", async () => {
    // The other control, and the one that keeps the guard from degenerating into "never settle a sent
    // week". A `delivered` verdict must leave the tally at the floor.
    const { reportId, projectId, deliveryKey } = await sentWeek(PRIOR_WEEK);
    await markAccepted(reportId);
    await ingest(providerEvent({ type: "email.delivered", createdAt: T_MID, deliveryKey }));

    const board = await getWeeklyReportDashboard(db, { asOf: WEEK_OF, lookbackWeeks: 1 });
    expect(board.olderOutstandingCounts[projectId]).toBe(1);
  });
});
