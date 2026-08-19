import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { handleWeeklyReportSend } from "../../src/jobs/weekly-report-send.js";

// The delivery bookkeeping, EXECUTED rather than string-matched.
//
// `recordAttempt`'s UPDATE is the only thing that turns a send into a fact anyone can see, and the rest of
// this job's suite asserts it by capturing the SQL text and checking substrings — which cannot tell a
// clause that is present from a clause that works. Running it against a real Postgres (PGlite) is what
// proves the WHERE actually refuses a row it should refuse, and that the jsonb surgery does what it says.
//
// The table below carries the columns 0222 and 0226 give `weekly_reports`; the migrations themselves are
// loaded from disk and asserted column-by-column in the API's runtime suite, which has the deals/files
// dependencies 0222 needs. What is under test here is the worker's statement, not the schema.

const SCHEMA = "office_dallas";
const REPORT = "6b1f6f2e-9d1a-4e4a-9c2b-1f4d8a0c5e31";
const OTHER = "7c2f7f3e-8d2a-4e4a-9c2b-1f4d8a0c5e32";
const DELIVERY_KEY = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";
const SHARE_URL = "https://reports.example.com/wr/AbCdEfGh";

const SILENT_LOGGER = { log: () => {}, warn: () => {}, error: () => {} };

const SEND_REQUEST = {
  recipients: ["jay@example.com"],
  subject: "4123 Cedar Springs — Weekly Progress Report, Week of 8/13/26",
  greetingName: "Jay Stauble",
  contextParagraph: "Framing is complete on levels 3 and 4.",
  shareUrl: SHARE_URL,
  sender: { name: "Adam Sherwood", email: "adam@trockconstruction.com", phone: "(214) 555-0142" },
  attachPdf: false,
  isCorrection: false,
  requestedBy: "00000000-0000-4000-8000-000000000001",
  requestedAt: "2026-08-13T21:00:00.000Z",
  requestVersion: 1,
};

let pg: PGlite;

const query = (async (text: string, params?: unknown[]) => {
  const result = await pg.query(text, params as any[]);
  return {
    rows: result.rows as any[],
    rowCount: (result as { affectedRows?: number }).affectedRows ?? result.rows.length,
  };
}) as any;

async function row(id = REPORT): Promise<Record<string, any>> {
  const result = await pg.query(`SELECT * FROM ${SCHEMA}.weekly_reports WHERE id = $1::uuid`, [id]);
  return result.rows[0] as Record<string, any>;
}

function payload(overrides: Record<string, unknown> = {}) {
  return {
    reportId: REPORT,
    officeSlug: "dallas",
    tenantSchema: SCHEMA,
    deliveryKey: DELIVERY_KEY,
    ...overrides,
  };
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`CREATE SCHEMA IF NOT EXISTS ${SCHEMA};`);
  await pg.exec(`
    CREATE TABLE ${SCHEMA}.weekly_reports (
      id                   uuid PRIMARY KEY,
      is_active            boolean NOT NULL DEFAULT true,
      status               text NOT NULL,
      week_of              date NOT NULL,
      version              integer NOT NULL DEFAULT 1,
      snapshot             jsonb,
      sent_at              timestamptz,
      send_request         jsonb,
      send_delivery_key    uuid,
      send_delivered_at    timestamptz,
      send_last_attempt_at timestamptz,
      send_attempts        integer NOT NULL DEFAULT 0,
      send_error           text,
      -- Stamped on an older version when a LATER one is actually sent. The handler reads it, so the
      -- column has to be here or its SELECT is a syntax error rather than a guard.
      superseded_by_id     uuid
    );
  `);
});

afterAll(async () => {
  await pg.close();
});

beforeEach(async () => {
  vi.stubEnv("NODE_ENV", "production");
  // An AUTHORISED production worker. The job refuses to email a customer from a deployment that has not
  // said so explicitly, and NODE_ENV cannot be that signal — Dockerfile.worker bakes `production` into the
  // image, so it reads identically on a staging worker running that same image.
  vi.stubEnv("WEEKLY_REPORT_CLIENT_EMAIL_ENABLED", "true");
  await pg.exec(`DELETE FROM ${SCHEMA}.weekly_reports;`);
  await pg.query(
    `INSERT INTO ${SCHEMA}.weekly_reports
       (id, status, week_of, snapshot, sent_at, send_request, send_delivery_key)
     VALUES ($1::uuid, 'sent', '2026-08-13', $2::jsonb, now(), $3::jsonb, $4::uuid)`,
    [
      REPORT,
      JSON.stringify({ propertyDisplayName: "4123 Cedar Springs" }),
      JSON.stringify(SEND_REQUEST),
      DELIVERY_KEY,
    ],
  );
});

describe("recording a delivery", () => {
  it("DROPS the raw client link from the row once the email has gone", async () => {
    // `send_request.shareUrl` is the only place the unhashed 180-day token comes to rest.
    // public.weekly_report_tokens stores a SHA-256 hash precisely so that a database read — a support
    // query, a backup, a pg_dump — cannot reconstruct a live link to a client's report, and a jsonb
    // column that keeps the URL forever hands that property straight back for every report the office has
    // ever sent. The URL is needed only until the message is out.
    expect((await row()).send_request.shareUrl).toBe(SHARE_URL);

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail: async () => ({ success: true, messageId: "m1" }),
      logger: SILENT_LOGGER,
    });

    const after = await row();
    expect(after.send_delivered_at).not.toBeNull();
    // Asserted as key ABSENCE. A `shareUrl: null` would satisfy a null check and still be a schema in
    // which the key is populated again the next time somebody edits this statement.
    expect(Object.keys(after.send_request)).not.toContain("shareUrl");
    // And nothing else about the request was lost with it — the row still describes what was sent.
    expect(after.send_request.recipients).toEqual(["jay@example.com"]);
    expect(after.send_request.subject).toBe(SEND_REQUEST.subject);
    expect(after.send_request.sender.phone).toBe("(214) 555-0142");
  });

  it("KEEPS the link on a failed attempt, because the retry has to send the same message", async () => {
    await expect(
      handleWeeklyReportSend(payload(), null, {
        query,
        sendEmail: async () => {
          throw new Error("Resend timed out");
        },
        logger: SILENT_LOGGER,
      }),
    ).rejects.toThrow(/Resend timed out/);

    const after = await row();
    expect(after.send_request.shareUrl).toBe(SHARE_URL);
    expect(after.send_delivered_at).toBeNull();
    expect(after.send_error).toBe("Resend timed out");
    expect(Number(after.send_attempts)).toBe(1);
    expect(after.send_last_attempt_at).not.toBeNull();
  });

  it("writes nothing to a report a concurrent success has already delivered", async () => {
    // The WHERE is not decoration: without it a stamp from a slow attempt lands on a row that has since
    // moved on, reporting a failure for a delivery that succeeded. Executed, not grepped.
    await pg.query(
      `UPDATE ${SCHEMA}.weekly_reports SET send_delivered_at = now() - interval '1 minute'
        WHERE id = $1::uuid`,
      [REPORT],
    );
    const before = await row();

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail: async () => ({ success: true, messageId: "m1" }),
      logger: SILENT_LOGGER,
    });

    const after = await row();
    expect(after.send_delivered_at).toEqual(before.send_delivered_at);
    expect(Number(after.send_attempts)).toBe(0);
  });

  it("SENDS NOTHING for a version a correction has already replaced", async () => {
    // The worker is the last line, and it needs its own: a delivery queued for v1 can still be sitting in
    // job_queue when the PM sends v2. When it is picked up the payload is perfectly well-formed — status
    // still `sent`, delivery key still matching, nothing delivered — so every other guard here waves it
    // through, and the message it would build carries `isCorrection: false`, so nothing in it would
    // explain to the client why the older report arrived after the newer one. The link in it opens a page
    // that then tells them their version is out of date.
    //
    // The API's retry route refuses this state too. Both are needed because they are two different ways
    // in, and the CRM button is a third.
    await pg.query(
      `UPDATE ${SCHEMA}.weekly_reports SET superseded_by_id = $2::uuid WHERE id = $1::uuid`,
      [REPORT, OTHER],
    );
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });

    expect(sendEmail).not.toHaveBeenCalled();
    const after = await row();
    // Skipped, not recorded as an attempt: no amount of retrying makes a superseded report the right
    // thing to send, so it must not burn attempts or leave a failure a PM would try to act on.
    expect(after.send_delivered_at).toBeNull();
    expect(Number(after.send_attempts)).toBe(0);
    expect(after.send_error).toBeNull();
    // And the stored request is untouched — this row is history now, not an outbox entry.
    expect(after.send_request.shareUrl).toBe(SHARE_URL);
  });

  it("SENDS NOTHING for a version a correction replaced WHILE ITS PDF WAS RENDERING", async () => {
    // The guard above reads `superseded_by_id` at the top of the handler and, until this was fixed, nothing
    // read it again — across the longest thing this job does. Resolving the PDF downloads and transcodes
    // every photo in the report and uploads the result to R2: seconds of network and CPU, during which a PM
    // can complete a correction. `sendWeeklyReport` stamps `superseded_by_id` on THIS row and queues v2, and
    // v1's worker sent anyway.
    //
    // The client then received BOTH, and neither message admitted the other existed: v1 carries a frozen
    // `isCorrection: false`, and v2's own `isCorrection` was computed from `send_delivered_at IS NOT NULL`
    // on v1 — still NULL at the moment v2 was committed — so v2 claimed not to be a correction either.
    //
    // Executed against real Postgres rather than a captured SQL string, because the re-read is a statement
    // whose WHERE has to actually match the row.
    await pg.query(
      `UPDATE ${SCHEMA}.weekly_reports
          SET send_request = jsonb_set(send_request, '{attachPdf}', 'true'::jsonb)
        WHERE id = $1::uuid`,
      [REPORT],
    );
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      // The correction lands mid-render, exactly as it would in production.
      resolvePdfKey: async () => {
        await pg.query(
          `UPDATE ${SCHEMA}.weekly_reports SET superseded_by_id = $2::uuid WHERE id = $1::uuid`,
          [REPORT, OTHER],
        );
        return null;
      },
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).not.toHaveBeenCalled();
    const after = await row();
    expect(after.send_delivered_at).toBeNull();
    expect(Number(after.send_attempts)).toBe(0);
    expect(after.send_error).toBeNull();
  });

  it("still delivers a version nothing has replaced", async () => {
    // The control. Without it the guards above are satisfied by a handler that never sends anything.
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    await handleWeeklyReportSend(payload(), null, { query, sendEmail, logger: SILENT_LOGGER });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await row()).send_delivered_at).not.toBeNull();
  });

  it("CONTROL: still delivers when the render finishes and nothing has changed", async () => {
    // The same shape as the mid-render guard, minus the correction — so that guard cannot be satisfied by a
    // handler that simply stopped sending whenever a PDF was rendered.
    await pg.query(
      `UPDATE ${SCHEMA}.weekly_reports
          SET send_request = jsonb_set(send_request, '{attachPdf}', 'true'::jsonb)
        WHERE id = $1::uuid`,
      [REPORT],
    );
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail,
      resolvePdfKey: async () => null,
      logger: SILENT_LOGGER,
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect((await row()).send_delivered_at).not.toBeNull();
  });

  it("touches only its own report", async () => {
    await pg.query(
      `INSERT INTO ${SCHEMA}.weekly_reports (id, status, week_of, send_request, send_delivery_key)
       VALUES ($1::uuid, 'sent', '2026-08-06', $2::jsonb, $3::uuid)`,
      [OTHER, JSON.stringify(SEND_REQUEST), DELIVERY_KEY],
    );

    await handleWeeklyReportSend(payload(), null, {
      query,
      sendEmail: async () => ({ success: true, messageId: "m1" }),
      logger: SILENT_LOGGER,
    });

    const other = await row(OTHER);
    expect(other.send_delivered_at).toBeNull();
    expect(other.send_request.shareUrl).toBe(SHARE_URL);
  });
});
