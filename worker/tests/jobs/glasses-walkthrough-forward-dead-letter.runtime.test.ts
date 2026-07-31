import { afterEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  buildGlassesWalkthroughForwardAlertEmail,
  resolveGlassesWalkthroughForwardAlertRecipients,
  runGlassesWalkthroughForwardDeadLetterSweep,
} from "../../src/jobs/glasses-walkthrough-forward.js";

// ---- buildGlassesWalkthroughForwardAlertEmail (pure renderer, no DB/transport) ----

function baseEmailInput(overrides: Partial<Parameters<typeof buildGlassesWalkthroughForwardAlertEmail>[0]> = {}) {
  return {
    jobId: 42,
    dealId: "deal-1",
    dealLabel: null,
    title: "North wing walkthrough",
    siteLabel: "Building A",
    capturedAt: "2026-07-30T15:04:00.000Z",
    officeSlug: "dallas",
    officeId: "office-1",
    artifactCount: 3,
    attempts: 10,
    maxAttempts: 10,
    lastError: "TROCK Scope walkthrough create failed: 500 {\"error\":\"boom\"}",
    frontendUrl: "https://trockcrm.com",
    ...overrides,
  };
}

describe("buildGlassesWalkthroughForwardAlertEmail", () => {
  it("includes the deal, walk, captured time, attempt count, verbatim error, and a deal link", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput());
    expect(email.subject).toContain("North wing walkthrough");
    expect(email.html).toContain("Deal deal-1"); // no dealLabel supplied -> falls back to the raw id
    expect(email.html).toContain("North wing walkthrough");
    expect(email.html).toContain("Building A");
    expect(email.html).toContain("Exhausted all 10 of 10 retry attempts");
    expect(email.html).toContain("boom");
    expect(email.html).toContain("https://trockcrm.com/deals/deal-1?officeId=office-1");
    expect(email.text).toContain("boom");
    expect(email.text).toContain("https://trockcrm.com/deals/deal-1?officeId=office-1");
  });

  it("prefers the resolved deal label over the raw id when one is supplied", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({ dealLabel: "TR-1234 — Acme Renovation" }),
    );
    expect(email.html).toContain("TR-1234 — Acme Renovation");
    expect(email.html).not.toContain("Deal deal-1");
  });

  it("distinguishes an immediate config-error dead-letter from an exhausted-retries dead-letter", () => {
    const immediate = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({ attempts: 1, maxAttempts: 10, lastError: "TROCK_SCOPE_SERVICE_TOKEN is not configured for glasses_walkthrough_forward." }),
    );
    expect(immediate.text).toContain("Failed immediately, without retrying (attempt 1 of 10)");
    expect(immediate.text).toContain("deploy-config problem");

    const exhausted = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput({ attempts: 10, maxAttempts: 10 }));
    expect(exhausted.text).toContain("Exhausted all 10 of 10 retry attempts");
  });

  it("never mentions or embeds the TROCK Scope service token value, even when it is set in the environment", () => {
    // The builder takes no env/token input at all — this asserts the guarantee structurally by construction
    // (there is no code path that could interpolate a token this function was never given), and pins the
    // config-error message to naming the VARIABLE, never a value.
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({ lastError: "TROCK_SCOPE_SERVICE_TOKEN is not configured for glasses_walkthrough_forward." }),
    );
    expect(email.html).toContain("TROCK_SCOPE_SERVICE_TOKEN is not configured");
    expect(email.html).not.toMatch(/Bearer\s+\S+/);
    expect(email.text).not.toMatch(/Bearer\s+\S+/);
  });

  it("pluralizes the filed-artifact count correctly", () => {
    const one = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput({ artifactCount: 1 }));
    expect(one.html).toContain("1 artifact filed");
    const many = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput({ artifactCount: 3 }));
    expect(many.html).toContain("3 artifacts filed");
  });

  it("falls back to a generic message when no error text was captured", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput({ lastError: null }));
    expect(email.text).toContain("(no error message captured)");
  });
});

// ---- resolveGlassesWalkthroughForwardAlertRecipients ----

describe("resolveGlassesWalkthroughForwardAlertRecipients", () => {
  it("parses, trims, lower-cases, and de-dupes a comma-separated list", () => {
    const recipients = resolveGlassesWalkthroughForwardAlertRecipients({
      GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: " Ops@x.com, ops@x.com ,tyler@x.com",
    } as any);
    expect(recipients).toEqual(["ops@x.com", "tyler@x.com"]);
  });

  it("falls back to a single dev address in development/test when unset", () => {
    expect(resolveGlassesWalkthroughForwardAlertRecipients({ NODE_ENV: "test" } as any)).toEqual([
      "adnaan.iqbal@gmail.com",
    ]);
  });

  it("fails closed (returns []) when unset in production, rather than silently using a dev address", () => {
    expect(resolveGlassesWalkthroughForwardAlertRecipients({ NODE_ENV: "production" } as any)).toEqual([]);
  });

  it("drops malformed entries", () => {
    expect(
      resolveGlassesWalkthroughForwardAlertRecipients({
        GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "not-an-email, ok@x.com",
      } as any),
    ).toEqual(["ok@x.com"]);
  });
});

// ---- runGlassesWalkthroughForwardDeadLetterSweep (real SQL / PGlite) ----

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const OFFICE = U("0f1");
const DEAL_CONFIG_ERROR = U("d01"); // dead-lettered immediately (attempts < max_attempts), deal resolves to a label
const DEAL_RETRIES_EXHAUSTED = U("d02"); // dead-lettered after exhausting retries, no matching deal row (deleted)

function artifactsJson(n: number) {
  return JSON.stringify(
    Array.from({ length: n }, (_, i) => ({
      fileId: `f${i}`,
      idempotencyKey: `a${i}`,
      kind: "video",
      r2Key: `k${i}`,
      mimeType: "video/mp4",
      originalFilename: `clip-${i}.mp4`,
      fileSizeBytes: 10,
      capturedAtMs: 0,
    })),
  );
}

describe("runGlassesWalkthroughForwardDeadLetterSweep (real SQL)", () => {
  let pg: PGlite | null = null;
  afterEach(async () => {
    await pg?.close();
    pg = null;
  });

  async function seed() {
    const db = new PGlite();
    pg = db;
    await db.exec(`
      CREATE TABLE public.job_queue (
        id bigserial PRIMARY KEY, job_type text NOT NULL, payload jsonb NOT NULL, office_id uuid,
        status text NOT NULL, last_error text, attempts integer NOT NULL DEFAULT 0,
        max_attempts integer NOT NULL DEFAULT 3, created_at timestamptz NOT NULL DEFAULT now()
      );
      CREATE SCHEMA office_test;
      CREATE TABLE office_test.deals (
        id uuid PRIMARY KEY, name text, deal_number text, project_number text
      );
      INSERT INTO office_test.deals (id, name, deal_number, project_number) VALUES
        ('${DEAL_CONFIG_ERROR}', 'Acme Renovation', 'D-9', 'TR-1234');
      -- DEAL_RETRIES_EXHAUSTED has NO matching deal row (simulates a deleted/archived deal) — the alert
      -- must still send, falling back to the raw id.
      INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error, attempts, max_attempts) VALUES
        ('glasses_walkthrough_forward',
         '{"walkId":"walk-1","dealId":"${DEAL_CONFIG_ERROR}","title":"North wing walkthrough","siteLabel":"Building A","capturedAt":"2026-07-30T15:04:00.000Z","officeSlug":"test","artifacts":${artifactsJson(2)}}'::jsonb,
         '${OFFICE}', 'dead', 'TROCK_SCOPE_SERVICE_TOKEN is not configured for glasses_walkthrough_forward.', 1, 10),
        ('glasses_walkthrough_forward',
         '{"walkId":"walk-2","dealId":"${DEAL_RETRIES_EXHAUSTED}","title":"South lot walkthrough","siteLabel":null,"capturedAt":"2026-07-29T10:00:00.000Z","officeSlug":"test","artifacts":${artifactsJson(1)}}'::jsonb,
         '${OFFICE}', 'dead', 'TROCK Scope walkthrough create failed: 500 {"error":"boom"}', 10, 10);
    `);
    return db;
  }

  function makeClient(db: PGlite) {
    return { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
  }

  it("alerts exactly once per dead-lettered job, covering both the config-error and exhausted-retries paths", async () => {
    const db = await seed();
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com", FRONTEND_URL: "https://trockcrm.com" } as any,
    });

    expect(handled).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);

    const [configErrorCall, retriesExhaustedCall] = sendEmail.mock.calls;
    expect(configErrorCall[0]).toEqual(["ops@x.com"]);
    expect(configErrorCall[1]).toContain("North wing walkthrough");
    expect(configErrorCall[2]).toContain("TR-1234 — Acme Renovation"); // resolved deal label
    expect(configErrorCall[2]).toContain("Failed immediately, without retrying (attempt 1 of 10)");
    expect(configErrorCall[3].idempotencyKey).toMatch(/^glasses-walkthrough-forward-dead-\d+$/);

    expect(retriesExhaustedCall[2]).toContain(`Deal ${DEAL_RETRIES_EXHAUSTED}`); // no matching deal row → raw id fallback
    expect(retriesExhaustedCall[2]).toContain("Exhausted all 10 of 10 retry attempts");
    expect(retriesExhaustedCall[2]).toContain("boom");

    // Both dead jobs are marked so a re-run doesn't double-alert.
    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual(["true", "true"]);
  });

  it("is idempotent: a second sweep finds nothing left to handle and sends no further email", async () => {
    const db = await seed();
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    const env = { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any;

    await runGlassesWalkthroughForwardDeadLetterSweep({ db: client as any, sendEmail, env });
    const second = await runGlassesWalkthroughForwardDeadLetterSweep({ db: client as any, sendEmail, env });

    expect(second).toBe(0);
    expect(sendEmail).toHaveBeenCalledTimes(2); // still just the first run's two sends
  });

  it("ignores jobs that are not (yet) dead — only a terminal 'dead' status is ever alerted on", async () => {
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, attempts, max_attempts) VALUES
        ('glasses_walkthrough_forward', '{"walkId":"walk-3","dealId":"${DEAL_CONFIG_ERROR}","title":"still retrying","officeSlug":"test","artifacts":${artifactsJson(1)}}'::jsonb, '${OFFICE}', 'pending', 3, 10)`,
    );
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
    });

    expect(handled).toBe(2); // only the two ALREADY-dead rows from seed(), never the pending one
    expect(sendEmail.mock.calls.every((call) => !String(call[1]).includes("still retrying"))).toBe(true);
  });

  it("fails loudly and leaves the row retryable (never marks alertSent) when no recipients are configured", async () => {
    const db = await seed();
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail,
      env: { NODE_ENV: "production" } as any, // no recipients configured, and prod does not dev-fallback
    });

    expect(handled).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
    // The claim is rolled back on the throw, so the marker is back to unset (never a stuck 'claimed').
    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual([null, null]);
  });

  it("never lets a mail-provider failure escape the sweep, and leaves that job retryable for the next tick", async () => {
    const db = await seed();
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => {
      throw new Error("Resend is down");
    });

    await expect(
      runGlassesWalkthroughForwardDeadLetterSweep({
        db: client as any,
        sendEmail,
        env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
      }),
    ).resolves.toBe(0);

    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual([null, null]);
  });
});
