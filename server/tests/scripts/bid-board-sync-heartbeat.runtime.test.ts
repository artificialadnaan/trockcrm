import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  getDeadLetteredInboxRows,
  getLastCommittedSuccessAt,
  markDeadLettersAlerted,
  readAlertState,
  runHeartbeatForOffice,
  sweepDeadLettersForOffice,
} from "../../src/scripts/bid-board-sync-heartbeat.js";

/**
 * Runtime (PGlite) proof of the heartbeat against real Postgres: the committed-success query, and the
 * end-to-end stall→throttle→recovery state machine persisted in public.bid_board_sync_alert_state.
 *
 * The headline assertion is the INCIDENT regression: failed ingests roll back and leave no run row,
 * so the heartbeat must trip on an OLD last-success (absence of success), not on any recorded failure.
 */

const NOW = new Date("2026-06-18T22:00:00Z");
const MIN = 60_000;
const ago = (mins: number) => new Date(NOW.getTime() - mins * MIN);

let pg: PGlite;
let client: { query: (text: string, params?: unknown[]) => Promise<{ rows: any[] }> };

beforeAll(async () => {
  pg = new PGlite();
  client = { query: async (text, params) => pg.query(text, params as any[]) as any };
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.bid_board_sync_runs (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.bid_board_sync_alert_state (
      office_slug text PRIMARY KEY,
      state text NOT NULL DEFAULT 'ok',
      last_alerted_at timestamptz,
      last_success_at timestamptz,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE public.bid_board_ingestion_inbox (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      office_slug text NOT NULL,
      payload_hash text NOT NULL,
      source_filename text,
      status text NOT NULL DEFAULT 'queued',
      last_error text,
      finished_at timestamptz,
      dead_letter_alerted_at timestamptz
    );
  `);
}, 30000); // PGlite cold-start can exceed the default 10s hook timeout when runtime suites start in parallel

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(
    `TRUNCATE office_dallas.bid_board_sync_runs; TRUNCATE public.bid_board_sync_alert_state; TRUNCATE public.bid_board_ingestion_inbox;`
  );
});

async function seedRun(status: string, createdAt: Date) {
  await client.query(`INSERT INTO office_dallas.bid_board_sync_runs (status, created_at) VALUES ($1, $2)`, [
    status,
    createdAt,
  ]);
}

let inboxSeq = 0;
async function seedInbox(
  status: string,
  opts: { finishedAt?: Date; sourceFilename?: string; lastError?: string; office?: string; alertedAt?: Date } = {},
): Promise<string> {
  inboxSeq++;
  const { rows } = await client.query(
    `INSERT INTO public.bid_board_ingestion_inbox
       (office_slug, payload_hash, source_filename, status, last_error, finished_at, dead_letter_alerted_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7) RETURNING id`,
    [
      opts.office ?? "dallas",
      `hash-${inboxSeq}`,
      opts.sourceFilename ?? `ProjectList-${inboxSeq}.xlsx`,
      status,
      opts.lastError ?? null,
      opts.finishedAt ?? null,
      opts.alertedAt ?? null,
    ]
  );
  return rows[0].id as string;
}

/** Count of still-unalerted 'failed' inbox rows for an office (the sweep's eligibility set). */
async function unalertedFailedCount(office = "dallas"): Promise<number> {
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM public.bid_board_ingestion_inbox
      WHERE office_slug = $1 AND status = 'failed' AND dead_letter_alerted_at IS NULL`,
    [office]
  );
  return rows[0].n as number;
}

describe("getLastCommittedSuccessAt", () => {
  it("returns the latest success/completed_with_unmatched and IGNORES failed/processing", async () => {
    await seedRun("success", ago(200));
    await seedRun("completed_with_unmatched", ago(40)); // newer committed success
    await seedRun("failed", ago(5)); // (in reality rolls back; here proves we never count it)
    await seedRun("processing", ago(2));

    const last = await getLastCommittedSuccessAt(client, "dallas");
    expect(last?.toISOString()).toBe(ago(40).toISOString());
  });

  it("returns null when no committed-success run exists", async () => {
    await seedRun("processing", ago(2));
    expect(await getLastCommittedSuccessAt(client, "dallas")).toBeNull();
  });
});

describe("runHeartbeatForOffice — incident + throttle + recovery (persisted)", () => {
  const okSender = async () => true; // a successful send
  const opts = { office: "dallas", thresholdMinutes: 60, realertMinutes: 60, sendAlert: okSender };

  it("WOULD HAVE CAUGHT THE INCIDENT: only an old success, no failure row → stalled + alert + persisted", async () => {
    // The last good push was >24h ago; every push since 500'd and rolled back (no row at all).
    await seedRun("success", ago(25 * 60));

    const r = await runHeartbeatForOffice(client, { ...opts, now: NOW });
    expect(r.decision.stalled).toBe(true);
    expect(r.decision.action).toBe("alert_stalled");

    const state = await readAlertState(client, "dallas");
    expect(state?.state).toBe("stalled");
    expect(state?.last_alerted_at?.toISOString()).toBe(NOW.toISOString());
  });

  it("throttles: a second check inside the re-alert window does NOT re-alert", async () => {
    await seedRun("success", ago(25 * 60));
    await runHeartbeatForOffice(client, { ...opts, now: NOW }); // first alert

    const second = await runHeartbeatForOffice(client, {
      ...opts,
      now: new Date(NOW.getTime() + 10 * MIN), // 10 min later, window is 60
    });
    expect(second.decision.stalled).toBe(true);
    expect(second.decision.action).toBe("none");
  });

  it("re-alerts once the re-alert window has elapsed", async () => {
    await seedRun("success", ago(25 * 60));
    await runHeartbeatForOffice(client, { ...opts, now: NOW });

    const later = await runHeartbeatForOffice(client, {
      ...opts,
      now: new Date(NOW.getTime() + 75 * MIN), // 75 > 60 → due
    });
    expect(later.decision.action).toBe("alert_stalled");
  });

  it("sends exactly one recovery alert when a fresh success lands, then goes quiet", async () => {
    await seedRun("success", ago(25 * 60));
    await runHeartbeatForOffice(client, { ...opts, now: NOW }); // stalled

    // A fresh successful push lands.
    const recoveredAt = new Date(NOW.getTime() + 20 * MIN);
    await seedRun("success", recoveredAt);

    const recover = await runHeartbeatForOffice(client, { ...opts, now: new Date(NOW.getTime() + 21 * MIN) });
    expect(recover.decision.action).toBe("alert_recovered");
    expect((await readAlertState(client, "dallas"))?.state).toBe("ok");

    // Subsequent healthy check is quiet.
    await seedRun("success", new Date(NOW.getTime() + 40 * MIN));
    const quiet = await runHeartbeatForOffice(client, { ...opts, now: new Date(NOW.getTime() + 41 * MIN) });
    expect(quiet.decision.action).toBe("none");
  });

  it("healthy from the start: a recent success never alerts", async () => {
    await seedRun("success", ago(15));
    const r = await runHeartbeatForOffice(client, { ...opts, now: NOW });
    expect(r.decision.action).toBe("none");
    expect((await readAlertState(client, "dallas"))?.state).toBe("ok");
  });

  // Throttle must advance only on a SUCCESSFUL send: a failed first send re-alerts on the NEXT cycle,
  // not after a full window — otherwise a transient transport blip silences the P0 alert for ~an hour.
  it("a failed send does NOT advance the throttle; the next cycle re-alerts", async () => {
    await seedRun("success", ago(25 * 60));
    const failOnce = await runHeartbeatForOffice(client, { ...opts, now: NOW, sendAlert: async () => false });
    expect(failOnce.decision.action).toBe("alert_stalled");
    expect(failOnce.sent).toBe(false);
    expect((await readAlertState(client, "dallas"))?.last_alerted_at).toBeNull(); // not advanced

    const retry = await runHeartbeatForOffice(client, {
      ...opts,
      now: new Date(NOW.getTime() + 19 * MIN), // next cycle, well inside the 60-min window
      sendAlert: okSender,
    });
    expect(retry.decision.action).toBe("alert_stalled"); // re-alerts because the first never sent
    expect(retry.sent).toBe(true);
  });

  it("a thrown sender is swallowed (no crash), counts as not-sent, and does NOT advance the throttle", async () => {
    await seedRun("success", ago(25 * 60));
    const r = await runHeartbeatForOffice(client, {
      ...opts,
      now: NOW,
      sendAlert: async () => {
        throw new Error("resend down");
      },
    });
    expect(r.sent).toBe(false);
    const state = await readAlertState(client, "dallas");
    expect(state?.state).toBe("stalled");
    expect(state?.last_alerted_at).toBeNull(); // throttle not advanced — re-alerts next cycle
  });

  // Recovery email must be reliable too: if it fails, stay stalled and retry next healthy cycle, so a
  // transient transport failure can't drop the "recovered" notice (Codex P3).
  it("a failed recovery send keeps state 'stalled' and retries; a later successful recovery flips to ok", async () => {
    await seedRun("success", ago(25 * 60));
    await runHeartbeatForOffice(client, { ...opts, now: NOW }); // stalled (sent ok)

    await seedRun("success", new Date(NOW.getTime() + 20 * MIN)); // a fresh success lands
    const failedRecovery = await runHeartbeatForOffice(client, {
      ...opts,
      now: new Date(NOW.getTime() + 21 * MIN),
      sendAlert: async () => false, // recovery email fails
    });
    expect(failedRecovery.decision.action).toBe("alert_recovered");
    expect(failedRecovery.sent).toBe(false);
    expect((await readAlertState(client, "dallas"))?.state).toBe("stalled"); // NOT flipped to ok

    const retried = await runHeartbeatForOffice(client, { ...opts, now: new Date(NOW.getTime() + 41 * MIN) });
    expect(retried.decision.action).toBe("alert_recovered"); // retried
    expect((await readAlertState(client, "dallas"))?.state).toBe("ok");
  });
});

describe("dead-letter sweep", () => {
  // Ages comfortably past the default 15-min reconcile grace, so these rows are eligible. The grace itself is
  // exercised by its own test below.
  it("getDeadLetteredInboxRows returns only still-UNALERTED 'failed' rows, oldest-first", async () => {
    await seedInbox("failed", { finishedAt: ago(60), lastError: "boom-old" });
    await seedInbox("failed", { finishedAt: ago(30), lastError: "boom-new" });
    await seedInbox("failed", { finishedAt: ago(45), lastError: "already", alertedAt: ago(1) }); // already stamped → excluded
    await seedInbox("succeeded", { finishedAt: ago(5) }); // not a failure
    await seedInbox("queued"); // not a failure

    const rows = await getDeadLetteredInboxRows(client, "dallas");
    expect(rows.map((r) => r.lastError)).toEqual(["boom-old", "boom-new"]); // oldest-first, unalerted failures only
  });

  // A row that just terminalized 'failed' can still be flipped back to 'succeeded' by the inbox's
  // reconcileFailedButCommitted path (a slow final-attempt import that commits after recovery), so the sweep
  // must NOT alert it until it ages past the grace window — else it sends a false terminal alert and stamps a
  // row that is about to recover. The grace compares finished_at against the DB's NOW(), so finished_at must
  // be anchored to the real clock (not the fixed test NOW) for this eligibility test.
  it("does NOT alert a just-'failed' row until it ages past the reconcile grace", async () => {
    const id = await seedInbox("failed", { lastError: "maybe-still-reconciling" });
    // finished_at = NOW() - 3 min (inside the default 15-min grace).
    await client.query(
      `UPDATE public.bid_board_ingestion_inbox SET finished_at = NOW() - make_interval(mins => 3) WHERE id = $1`,
      [id]
    );
    // Inside the grace: excluded from the eligibility set and not swept.
    expect(await getDeadLetteredInboxRows(client, "dallas", 15)).toHaveLength(0);
    const early = await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert: async () => true });
    expect(early).toMatchObject({ count: 0, sent: false });
    expect(await unalertedFailedCount()).toBe(1); // still eligible for a future sweep — NOT stamped

    // Age the SAME row past the grace (finished_at = NOW() - 20 min): now eligible and alerted.
    await client.query(
      `UPDATE public.bid_board_ingestion_inbox SET finished_at = NOW() - make_interval(mins => 20) WHERE id = $1`,
      [id]
    );
    expect(await getDeadLetteredInboxRows(client, "dallas", 15)).toHaveLength(1);
    const late = await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert: async () => true });
    expect(late).toMatchObject({ count: 1, sent: true });
    expect(await unalertedFailedCount()).toBe(0); // now alerted + stamped
  });

  it("sweeps unalerted dead-letters into ONE batch email, marks them alerted, then no-ops", async () => {
    await seedInbox("failed", { finishedAt: ago(60), sourceFilename: "A.xlsx", lastError: "e1" });
    await seedInbox("failed", { finishedAt: ago(30), sourceFilename: "B.xlsx", lastError: "e2" });
    const calls: { subject: string; html: string }[] = [];
    const sendAlert = async (subject: string, html: string) => (calls.push({ subject, html }), true);

    const first = await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert });
    expect(first).toMatchObject({ count: 2, sent: true });
    expect(calls).toHaveLength(1); // ONE batched email, not one per row
    expect(calls[0].subject).toMatch(/2 failed imports/);
    expect(calls[0].html).toContain("A.xlsx");
    expect(calls[0].html).toContain("B.xlsx");
    expect(await unalertedFailedCount()).toBe(0); // both stamped

    const second = await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert });
    expect(second).toMatchObject({ count: 0, sent: false });
    expect(calls).toHaveLength(1); // nothing new → no second email
  });

  it("a failure committing OUT OF ORDER (older finished_at than an already-alerted row) is STILL alerted", async () => {
    // The exact P1 a timestamp watermark misses: alert a newer failure first, then a slow failure commits with
    // an OLDER finished_at. The per-row NULL marker still selects it; a `finished_at > watermark` cursor wouldn't.
    // Both are aged past the grace window so eligibility isn't what's under test.
    await seedInbox("failed", { finishedAt: ago(30), lastError: "newer-first" });
    const send1: string[] = [];
    await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert: async (_s, h) => (send1.push(h), true) });
    expect(send1[0]).toContain("newer-first");
    expect(await unalertedFailedCount()).toBe(0);

    await seedInbox("failed", { finishedAt: ago(60), lastError: "older-straggler" }); // earlier timestamp, later commit
    const send2: string[] = [];
    const r = await sweepDeadLettersForOffice(client, {
      office: "dallas",
      now: new Date(NOW.getTime() + MIN),
      sendAlert: async (_s, h) => (send2.push(h), true),
    });
    expect(r.count).toBe(1);
    expect(send2[0]).toContain("older-straggler"); // NOT skipped despite its older timestamp
  });

  it("does NOT mark rows on a failed send — the same batch re-alerts next run", async () => {
    await seedInbox("failed", { finishedAt: ago(30), lastError: "e" }); // aged past the grace window
    const failed = await sweepDeadLettersForOffice(client, { office: "dallas", now: NOW, sendAlert: async () => false });
    expect(failed).toMatchObject({ count: 1, sent: false });
    expect(await unalertedFailedCount()).toBe(1); // NOT stamped

    const retried = await sweepDeadLettersForOffice(client, {
      office: "dallas",
      now: new Date(NOW.getTime() + MIN),
      sendAlert: async () => true,
    });
    expect(retried).toMatchObject({ count: 1, sent: true }); // re-alerted the same row
    expect(await unalertedFailedCount()).toBe(0); // now stamped
  });

  // Codex P2: reconcileFailedButCommitted can flip a row 'failed' → 'succeeded' AFTER the sweep SELECTs it but
  // BEFORE the marker UPDATE. markDeadLettersAlerted's `AND status = 'failed'` guard must then skip that now-
  // 'succeeded' row so a reconciled import never carries a stale dead-letter marker.
  it("markDeadLettersAlerted skips a row that reconciled to 'succeeded' between select and mark", async () => {
    const stillFailed = await seedInbox("failed", { finishedAt: ago(30), lastError: "genuinely-dead" });
    const reconciled = await seedInbox("failed", { finishedAt: ago(30), lastError: "raced-to-success" });

    // Simulate the reconcile that lands after the sweep's SELECT: this row is now 'succeeded'.
    await client.query(
      `UPDATE public.bid_board_ingestion_inbox SET status = 'succeeded', last_error = NULL WHERE id = $1`,
      [reconciled]
    );

    // Mark BOTH ids (as the sweep would after a send): only the still-'failed' one is stamped.
    await markDeadLettersAlerted(client, [stillFailed, reconciled], NOW);

    const { rows } = await client.query(
      `SELECT id, status, dead_letter_alerted_at FROM public.bid_board_ingestion_inbox WHERE id = ANY($1::uuid[])`,
      [[stillFailed, reconciled]]
    );
    const byId = Object.fromEntries(rows.map((r) => [r.id, r]));
    expect(byId[stillFailed].dead_letter_alerted_at).not.toBeNull(); // genuine dead-letter → stamped
    expect(byId[reconciled].status).toBe("succeeded");
    expect(byId[reconciled].dead_letter_alerted_at).toBeNull(); // reconciled row NOT stamped
  });

  it("skips cleanly (no throw, no send) when the inbox table is absent (migration 0188 not applied)", async () => {
    await pg.exec(`ALTER TABLE public.bid_board_ingestion_inbox RENAME TO bid_board_ingestion_inbox_tmp;`);
    try {
      let sends = 0;
      const r = await sweepDeadLettersForOffice(client, {
        office: "dallas",
        now: NOW,
        sendAlert: async () => (sends++, true),
      });
      expect(r).toMatchObject({ count: 0, sent: false });
      expect(sends).toBe(0);
    } finally {
      await pg.exec(`ALTER TABLE public.bid_board_ingestion_inbox_tmp RENAME TO bid_board_ingestion_inbox;`);
    }
  });
});
