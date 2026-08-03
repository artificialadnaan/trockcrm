import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  __resetGlassesWalkthroughForwardSweepStateForTest,
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
    scopeWalkthroughId: null,
    lastError: "TROCK Scope walkthrough create failed: 500 {\"error\":\"boom\"}",
    frontendUrl: "https://trockcrm.com",
    ...overrides,
  };
}

/** The `last_error` a supersede-for-reconciliation leaves, abridged to its opening sentence — the shape
 *  `buildSupersededForwardDeadLetterMessage`
 *  (server/src/modules/walkthrough-capture/glasses-walkthrough-service.ts) writes when a COMPLETED forward
 *  is flipped to 'dead' because the walk grew after it finished. Spelled out here rather than imported:
 *  it crosses a package boundary, and the alert's classification has to keep faith with the text that
 *  actually lands in the column. */
const SUPERSEDED_LAST_ERROR =
  "Superseded for reconciliation: walk walk-1 (deal deal-1) was completed again carrying 2 artifact(s) this " +
  "forward never held (a7, a8). The row was 'completed' when they were filed, so its artifact list could not " +
  "be widened in flight.";

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

  it("names the attempt the job stopped on — stopping early is not the same as stopping first", () => {
    // "Attempt < max" covers two different stories: a config error that never got off the ground, and a
    // deadJob(...) returned mid-life (the unconfirmed-create stop, which lands on whichever attempt first
    // read the pending marker back). A fixed "attempt 1" reports the second as the first and quietly
    // disagrees with the job_queue row the reader is looking at.
    const stoppedLate = buildGlassesWalkthroughForwardAlertEmail(baseEmailInput({ attempts: 4, maxAttempts: 10 }));
    expect(stoppedLate.text).toContain("(attempt 4 of 10)");
    expect(stoppedLate.text).not.toContain("attempt 1 of 10");
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

  // ── The explanation has to come from the REASON, not from the attempt count ───────────────────────
  //
  // "attempts < max_attempts" was reading as "it never got off the ground, so check the URL and the
  // token". Two of this seam's dead letters break that inference outright, and both land well inside the
  // retry budget: a supersede-for-reconciliation flips a COMPLETED row to 'dead' (attempts is whatever the
  // successful forward used — normally 1), and an unconfirmed-create stop returns deadJob(...) on whichever
  // attempt first read the pending marker back. Those rows can have created a TROCK Scope walkthrough and
  // uploaded some or all of its clips, and their `last_error` carries a specific row repair. Telling the
  // responder it is "almost always a deploy-config problem" sends them to the environment variables while
  // the row waits for the one edit that actually fixes it.

  it("does not blame deploy config for a supersede-for-reconciliation dead letter", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({
        attempts: 1,
        maxAttempts: 10,
        scopeWalkthroughId: "8f1c0a6e-1111-4222-8333-444455556666",
        lastError: SUPERSEDED_LAST_ERROR,
      }),
    );
    expect(email.text).not.toContain("deploy-config problem");
    // Still names the attempt it stopped on — the number was never the problem, the inference drawn from
    // it was — and still points the reader at the error, which is where the repair is written down.
    expect(email.text).toContain("(attempt 1 of 10)");
  });

  it("does not blame deploy config for an unconfirmed-create dead letter", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({
        attempts: 4,
        maxAttempts: 10,
        lastError:
          "A TROCK Scope walkthrough create was already sent for walk walk-1 (external ref " +
          "trockcrm:glasses-walkthrough:walk-1:deal:deal-1) and this job never learned whether it succeeded.",
      }),
    );
    expect(email.text).not.toContain("deploy-config problem");
    expect(email.text).toContain("(attempt 4 of 10)");
  });

  it("GUARD: still calls a genuinely unset env var what it is, however early the job stopped", () => {
    // The inference is wrong, the conclusion is not — a config dead letter really IS a deploy-config
    // problem, and narrowing the branch must not cost the one case it was always right about.
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({
        attempts: 1,
        maxAttempts: 10,
        lastError: "TROCK_SCOPE_BASE_URL is not configured for glasses_walkthrough_forward.",
      }),
    );
    expect(email.text).toContain("deploy-config problem");
    expect(email.text).toContain("(attempt 1 of 10)");
  });

  it("stops telling the reader no scope was ever generated when the row records a created walkthrough", () => {
    // The ADJACENT half of the same assumption, and it is stated twice — once in the lead paragraph of the
    // text body and once in the HTML sub-heading. "The walk is safely filed in the project folder, but no
    // scope was ever generated from it" is false for exactly the rows above: a supersede flips a forward
    // that FINISHED, and TROCK Scope's own worker transcribes and extracts from the clips it received. A
    // responder who believes nothing landed has no reason to check what the remote walkthrough already
    // holds, which is the first step every one of these repairs asks for.
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({
        attempts: 1,
        maxAttempts: 10,
        scopeWalkthroughId: "8f1c0a6e-1111-4222-8333-444455556666",
        lastError: SUPERSEDED_LAST_ERROR,
      }),
    );
    expect(email.text).not.toContain("no scope was ever generated");
    expect(email.html).not.toContain("no scope was ever generated");
    // And the id itself is printed, because "check what that walkthrough already holds" is unactionable
    // without it.
    expect(email.text).toContain("8f1c0a6e-1111-4222-8333-444455556666");
  });

  it("GUARD: still says no scope was generated when nothing remote was ever created", () => {
    const email = buildGlassesWalkthroughForwardAlertEmail(
      baseEmailInput({
        attempts: 1,
        maxAttempts: 10,
        scopeWalkthroughId: null,
        lastError: "TROCK_SCOPE_BASE_URL is not configured for glasses_walkthrough_forward.",
      }),
    );
    expect(email.text).toContain("no scope was ever generated");
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
  // The sweep is single-flight process-wide now, and the flag is module state. A case that ends with a
  // sweep still in flight would otherwise leave it set for the rest of the FILE, and every later case
  // would fail on an email its own sweep silently never sent.
  beforeEach(() => {
    __resetGlassesWalkthroughForwardSweepStateForTest();
  });
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

  /**
   * PGlite is a single embedded connection, so `connect` hands back the same query surface — but it must
   * BE there: the sweep now refuses to run without it rather than falling back to `db.query`, because the
   * per-row BEGIN / claim / send / COMMIT is only a transaction if one connection carries all four. Every
   * case in this file used to take that fallback, which meant none of them were exercising the sweep's
   * real connection contract.
   */
  function makeClient(db: PGlite) {
    const queryable = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    return { ...queryable, connect: async () => ({ ...queryable, release: () => {} }) };
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

  it("refuses to run at all against an adapter that cannot check out a connection", async () => {
    // The sweep's claim marker is only safe because a throw between BEGIN and COMMIT rolls it back with
    // everything else. Handed a bare `query`, the pool is free to route each statement to a different
    // connection — the BEGIN opens a transaction nothing else joins, the ROLLBACK undoes nothing, and the
    // claim survives a failed send as a permanently stranded 'claimed'. Silently doing that is worse than
    // not running: it looks like it worked.
    const db = await seed();
    const bareQueryOnly = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await expect(
      runGlassesWalkthroughForwardDeadLetterSweep({
        db: bareQueryOnly as any,
        sendEmail,
        env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
      }),
    ).rejects.toThrow(/single connection/);

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("recovers a row a crash left stranded at alertSent='claimed' instead of never alerting on it", async () => {
    // GUARD on the tri-state marker's reason for existing. 'claimed' is written INSIDE the transaction, so
    // an ordinary failure rolls it back — but a worker killed between COMMIT of the claim and the send
    // (SIGKILL, an OOM, a Railway redeploy mid-sweep) can leave it committed with no email ever sent. If
    // the candidate query treated 'claimed' as "someone else has this", that walk's alert would be lost
    // permanently and the only sign would be silence.
    const db = await seed();
    await db.query(
      `UPDATE public.job_queue SET payload = jsonb_set(payload, '{alertSent}', '"claimed"'::jsonb, true) WHERE id = 1`,
    );
    const client = makeClient(db);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
    });

    expect(handled).toBe(2); // the stranded row AND the untouched one
    expect(sendEmail).toHaveBeenCalledTimes(2);
    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual(["true", "true"]);
  });

  it("reports the attempt the job actually STOPPED on, not a hardcoded first attempt", async () => {
    // An unconfirmed-create dead letter is returned by deadJob(...) on whichever attempt first read the
    // pending marker back — attempts < max_attempts, exactly like a config error, but emphatically not
    // attempt 1. Printing "attempt 1 of 10" over a row whose attempts column says 4 makes the email
    // contradict the queue, and it is precisely the case where a reader needs to know how much of the
    // retry budget went by before the job gave up.
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error, attempts, max_attempts)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, $2, 'dead', $3, 4, 10)`,
      [
        `{"walkId":"walk-4","dealId":"${DEAL_CONFIG_ERROR}","title":"Unconfirmed create walk","officeSlug":"test","artifacts":${artifactsJson(1)}}`,
        OFFICE,
        "A TROCK Scope walkthrough create was already sent for walk walk-4 and this job never learned whether it succeeded.",
      ],
    );
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await runGlassesWalkthroughForwardDeadLetterSweep({
      db: makeClient(db) as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
    });

    const call = sendEmail.mock.calls.find((c) => String(c[1]).includes("Unconfirmed create walk"));
    expect(call).toBeDefined();
    expect(String(call![2])).toContain("(attempt 4 of 10)");
    expect(String(call![2])).not.toContain("attempt 1 of 10");
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

  // ── Nothing unbounded inside the claim transaction ────────────────────────────────────────────────
  //
  // The per-row work is BEGIN / claim / enrich / send / COMMIT on ONE checked-out connection, and two of
  // those five steps are network calls that answer to nobody's clock. Resend's SDK awaits a plain `fetch`
  // and takes no AbortSignal (PostOptions is { query, headers }); the enrichment SELECT has no cancellation
  // either. A provider that accepts the connection and then goes quiet therefore did not merely delay one
  // alert — it pinned a pooled client and this row's lock against every other sweeper for the life of the
  // process. And the sweep is driven by a bare setInterval with NO reentrancy guard (index.ts), so the next
  // tick opens a SECOND wedged sweep 60 seconds later, and a third after that, until the pool (max 10) is
  // gone and every unrelated worker job stops with it.
  //
  // A hanging fake is the whole point of these two cases: with no ceiling they do not fail, they never
  // return at all.
  function capturingLogger() {
    return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  }

  it("abandons an alert send that never answers, instead of holding the claim transaction open on it", async () => {
    const db = await seed();
    const client = makeClient(db);
    const logger = capturingLogger();
    // A provider that took the request and then said nothing — the exact shape production gets from a
    // Resend that is up enough to accept a socket and not up enough to answer on it.
    const sendEmail = vi.fn(() => new Promise<never>(() => {}));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail: sendEmail as any,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
      stepTimeoutMs: 25,
      logger,
    });

    expect(handled).toBe(0);
    // Abandoning the wait is a throw like any other, so the claim rolls back with it: the row is left
    // unclaimed and 'dead', retried on the next tick — never stranded at 'claimed', and never marked
    // alerted for an email nobody can prove was delivered.
    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual([null, null]);
    // And the sweep STOPS at the first stall rather than paying the same ceiling on every remaining row
    // while holding its one pooled connection for the sum of them. A provider that will not answer for one
    // job will not answer for the next twenty-four either.
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls.flat().join(" ")).toContain("Abandoning this sweep");
  }, 5_000);

  it("abandons the best-effort deal-label lookup too, and still sends the alert with the raw id", async () => {
    // The enrichment SELECT sits between the same BEGIN and COMMIT as the send, so it holds the connection
    // and the row lock identically — a ceiling on one of the two bounds nothing. It is best-effort by
    // design though, so hitting the ceiling must degrade the EMAIL (raw id instead of a label), never cost
    // the alert: an ops address that never hears about a lost site visit is the failure this sweep exists
    // to prevent.
    const db = await seed();
    let dealReads = 0;
    const queryable = {
      query: (sql: string, params?: unknown[]) => {
        if (sql.includes(".deals")) {
          dealReads += 1;
          return new Promise<never>(() => {}); // the office-schema read that never answers
        }
        return db.query(sql, params as never[]) as any;
      },
    };
    const client = { ...queryable, connect: async () => ({ ...queryable, release: () => {} }) };
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: client as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
      stepTimeoutMs: 25,
      logger: capturingLogger(),
    });

    expect(handled).toBe(2);
    expect(sendEmail).toHaveBeenCalledTimes(2);
    expect(String(sendEmail.mock.calls[0][2])).toContain(`Deal ${DEAL_CONFIG_ERROR}`); // label unresolved → raw id
    // ONE row pays the ceiling, not every row: a schema that would not answer for the first will not answer
    // for the twenty-fifth, and the sweep holds a single connection for the sum of them.
    expect(dealReads).toBe(1);
    const jobs = (await db.query(`SELECT payload->>'alertSent' AS alerted FROM public.job_queue ORDER BY id`))
      .rows as any[];
    expect(jobs.map((j) => j.alerted)).toEqual(["true", "true"]);
  }, 5_000);

  it("DESTROYS the pooled connection an abandoned deal-label read is sitting on, not just the wait for it", async () => {
    // The one assertion that separates a fixed leak from a relabelled one. A deadline raced against a
    // top-level `db.query` returns the CALLER on time and proves nothing: pg has already checked a
    // connection out for that statement and holds it until the statement settles, which for the case this
    // ceiling exists to survive — a `deals` read blocked on a lock, where the socket is perfectly healthy
    // and keepalive will therefore never evict it — is never. So a test that only measured how long the
    // sweep took would pass against the very code this replaces.
    //
    // What must be true instead: the enrichment read rides its OWN checked-out client, and when the clock
    // wins that client is released WITH AN ERROR — pg's signal to discard the socket rather than hand a
    // connection with an orphaned statement on it to the next caller. Without that, `dealLabelLookupAbandoned`
    // suppresses only the rest of THIS sweep, and the 60-second interval strands one more slot per tick
    // until the pool (max 10) is gone.
    const db = await seed();
    // Modelled on a real pg.Pool: each connect() is a distinct checkout with its own release() lifecycle,
    // and pool-level `query` is a separate surface entirely — which is exactly how the leak becomes visible.
    const checkouts: Array<{ sawDealRead: boolean; released: boolean; releasedWith: unknown }> = [];
    const poolLevelQueries: string[] = [];
    const pool = {
      query: (sql: string, params?: unknown[]) => {
        poolLevelQueries.push(sql);
        if (sql.includes(".deals")) return new Promise<never>(() => {});
        return db.query(sql, params as never[]) as any;
      },
      connect: async () => {
        const checkout = { sawDealRead: false, released: false, releasedWith: undefined as unknown };
        checkouts.push(checkout);
        return {
          query: (sql: string, params?: unknown[]) => {
            if (sql.includes(".deals")) {
              checkout.sawDealRead = true;
              return new Promise<never>(() => {}); // the lock-blocked office-schema read
            }
            return db.query(sql, params as never[]) as any;
          },
          release: (err?: unknown) => {
            checkout.released = true;
            checkout.releasedWith = err;
          },
        };
      },
    };
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const handled = await runGlassesWalkthroughForwardDeadLetterSweep({
      db: pool as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
      stepTimeoutMs: 25,
      logger: capturingLogger(),
    });

    // The read never goes out on the pool's convenience `query` — that surface owns a connection nobody
    // holds a handle to, so nothing can ever destroy it.
    expect(poolLevelQueries.some((sql) => sql.includes(".deals"))).toBe(false);
    const enrichment = checkouts.filter((c) => c.sawDealRead);
    expect(enrichment).toHaveLength(1);
    expect(enrichment[0].released).toBe(true);
    expect(enrichment[0].releasedWith).toBeInstanceOf(Error); // destroyed — NOT returned to the pool poisoned

    // The transaction's own client is untouched by this: it is still healthy, so it goes back CLEAN, and
    // every alert still goes out (best-effort enrichment degrades the email, never the alert).
    const transactional = checkouts.filter((c) => !c.sawDealRead);
    expect(transactional).toHaveLength(1);
    expect(transactional[0].releasedWith).toBeUndefined();
    expect(handled).toBe(2);
    expect(String(sendEmail.mock.calls[0][2])).toContain(`Deal ${DEAL_CONFIG_ERROR}`);
  }, 5_000);

  // ── The sweep's OWN job_queue statements ──────────────────────────────────────────────────────────
  //
  // The two ceilings above cover the send and the enrichment read — the steps that leave this process.
  // Every OTHER statement here is a `client.query` on the one connection this sweep checked out, and none
  // of them was bounded at all: the candidate SELECT, the BEGIN, the re-lock, the claim UPDATE, the
  // alertSent UPDATE, the COMMIT and the ROLLBACK. `job_queue` is a table every poller writes to, so an
  // UPDATE parked behind another transaction's row lock is unremarkable, and a pooled socket that was
  // accepted and went quiet gives the same shape (the worker pool sets no statement_timeout — db.ts).
  // Either one leaves a promise that never settles, so the sweep never reaches its `finally`, never
  // releases, and never returns. Nothing notices: `runGlassesWalkthroughForwardDeadLetterSweep` is driven
  // by a bare setInterval with no reentrancy guard (index.ts), so 60 seconds later a SECOND sweep checks
  // out a second connection, and so on until the pool (max 10) is gone and every unrelated worker job
  // stops behind an alert about a lost site visit.
  //
  // A statement that hit its ceiling also cannot be cleaned up in place: it still owns this connection, so
  // the ROLLBACK the per-row catch would normally issue queues behind it and never answers either. The
  // connection has to be DESTROYED — which is also what ends the open transaction, because Postgres aborts
  // an uncommitted one when its backend sees the socket close.

  /** Like the pool above, but the hang is keyed to a SQL pattern so a case can pick which of the sweep's
   *  own statements is the one that stops answering, and every statement it issues is recorded. */
  function makeHangingPool(db: PGlite, hangOn: RegExp) {
    const checkouts: Array<{ released: boolean; releasedWith: unknown; statements: string[] }> = [];
    const pool = {
      query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any,
      connect: async () => {
        const checkout = { released: false, releasedWith: undefined as unknown, statements: [] as string[] };
        checkouts.push(checkout);
        return {
          query: (sql: string, params?: unknown[]) => {
            checkout.statements.push(sql);
            if (hangOn.test(sql)) return new Promise<never>(() => {});
            return db.query(sql, params as never[]) as any;
          },
          release: (err?: unknown) => {
            checkout.released = true;
            checkout.releasedWith = err;
          },
        };
      },
    };
    return { pool, checkouts };
  }

  async function outcomeWithin<T>(work: Promise<T>, ms: number): Promise<T | Error | "never settled"> {
    return Promise.race([
      work.then(
        (value) => value,
        (err) => (err instanceof Error ? err : new Error(String(err))),
      ),
      new Promise<"never settled">((resolve) => setTimeout(() => resolve("never settled"), ms)),
    ]);
  }

  it("abandons a candidate query that never answers, and destroys the connection it is stuck on", async () => {
    const db = await seed();
    const { pool, checkouts } = makeHangingPool(db, /FROM public\.job_queue/);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    const outcome = await outcomeWithin(
      runGlassesWalkthroughForwardDeadLetterSweep({
        db: pool as any,
        sendEmail,
        env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
        stepTimeoutMs: 25,
        logger: capturingLogger(),
      }),
      1_000,
    );

    expect(outcome).toBeInstanceOf(Error);
    expect(sendEmail).not.toHaveBeenCalled();
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].released).toBe(true);
    expect(checkouts[0].releasedWith).toBeInstanceOf(Error); // destroyed — the slot goes back to the pool
  }, 5_000);

  it("abandons a claim UPDATE that never answers WITHOUT issuing a rollback down the same stuck connection", async () => {
    // The claim marker is written inside the transaction so that a throw rolls it back. That contract has
    // one hole a ceiling opens: the statement that hit the ceiling is still running server-side and still
    // owns this connection, so the recovery ROLLBACK would queue behind it and hang in its place — the same
    // wedge, one statement later. Destroying the connection is what has to undo the claim instead.
    const db = await seed();
    const { pool, checkouts } = makeHangingPool(db, /'\{alertSent\}', '"claimed"'/);
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));
    const logger = capturingLogger();

    const outcome = await outcomeWithin(
      runGlassesWalkthroughForwardDeadLetterSweep({
        db: pool as any,
        sendEmail,
        env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
        stepTimeoutMs: 25,
        logger,
      }),
      1_000,
    );

    expect(outcome).toBe(0); // it returns, having alerted on nothing
    expect(sendEmail).not.toHaveBeenCalled();
    expect(checkouts).toHaveLength(1);
    expect(checkouts[0].releasedWith).toBeInstanceOf(Error);
    // No ROLLBACK on the poisoned connection, and no attempt at the SECOND row either: one stuck statement
    // means the far end is not answering, and the remaining rows are untouched for the next tick.
    expect(checkouts[0].statements.some((sql) => /ROLLBACK/.test(sql))).toBe(false);
    expect(checkouts[0].statements.filter((sql) => /BEGIN/.test(sql))).toHaveLength(1);
  }, 5_000);

  it("refuses to start a second sweep while one is still running, rather than checking out another connection", async () => {
    // The other half of "one stuck connection is the wrong unit". Even with every statement bounded, a
    // sweep of 25 rows against a slow-but-answering provider can outlive the 60-second interval that
    // started it — and an overlapping sweep is not merely wasted work, it is a second pooled connection
    // out of ten, held for the same reason the first one is.
    const db = await seed();
    let connects = 0;
    const queryable = { query: (sql: string, params?: unknown[]) => db.query(sql, params as never[]) as any };
    const pool = {
      ...queryable,
      connect: async () => {
        connects += 1;
        return { ...queryable, release: () => {} };
      },
    };
    let releaseSend: () => void = () => {};
    const sendGate = new Promise<void>((resolve) => {
      releaseSend = resolve;
    });
    const sendEmail = vi.fn(async () => {
      await sendGate;
      return { success: true, messageId: "m1" };
    });
    const env = { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any;

    const first = runGlassesWalkthroughForwardDeadLetterSweep({ db: pool as any, sendEmail, env });
    // Let the first sweep get as far as its (gated) send, so it is genuinely mid-flight.
    for (let i = 0; i < 100 && sendEmail.mock.calls.length === 0; i++) {
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(sendEmail).toHaveBeenCalledTimes(1);

    // Bounded, because an UNGUARDED second sweep does not merely do redundant work — it opens its own
    // transaction on a row the first one is holding and blocks on the same gate, which is the wedge itself.
    const connectsBeforeSecond = connects;
    const second = await outcomeWithin(
      runGlassesWalkthroughForwardDeadLetterSweep({ db: pool as any, sendEmail, env }),
      500,
    );

    expect(connects).toBe(connectsBeforeSecond); // the overlapping tick checked nothing out at all
    expect(second).toBe(0);
    releaseSend();
    expect(await first).toBe(2);
  }, 10_000);

  it("classifies the dead-letter reason from last_error, not from how much retry budget was left", async () => {
    // End to end through the sweep, because the classification is only useful if the payload and the error
    // it reads actually reach the renderer. A supersede-for-reconciliation row: 'dead', attempts 1 of 10,
    // a recorded TROCK Scope walkthrough, and a last_error asking for a specific repair.
    const db = await seed();
    await db.query(
      `INSERT INTO public.job_queue (job_type, payload, office_id, status, last_error, attempts, max_attempts)
       VALUES ('glasses_walkthrough_forward', $1::jsonb, $2, 'dead', $3, 1, 10)`,
      [
        `{"walkId":"walk-9","dealId":"${DEAL_CONFIG_ERROR}","title":"Superseded walk","officeSlug":"test","scopeWalkthroughId":"8f1c0a6e-1111-4222-8333-444455556666","artifacts":${artifactsJson(3)}}`,
        OFFICE,
        SUPERSEDED_LAST_ERROR,
      ],
    );
    const sendEmail = vi.fn(async () => ({ success: true, messageId: "m1" }));

    await runGlassesWalkthroughForwardDeadLetterSweep({
      db: makeClient(db) as any,
      sendEmail,
      env: { GLASSES_WALKTHROUGH_FORWARD_EMAIL_RECIPIENTS: "ops@x.com" } as any,
    });

    const call = sendEmail.mock.calls.find((c) => String(c[1]).includes("Superseded walk"));
    expect(call).toBeDefined();
    const body = String(call![2]);
    expect(body).not.toContain("deploy-config problem");
    expect(body).not.toContain("no scope was ever generated");
    expect(body).toContain("8f1c0a6e-1111-4222-8333-444455556666");
  });
});
