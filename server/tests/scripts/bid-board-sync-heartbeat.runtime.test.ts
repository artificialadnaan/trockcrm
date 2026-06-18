import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import {
  getLastCommittedSuccessAt,
  readAlertState,
  runHeartbeatForOffice,
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
  `);
}, 30000); // PGlite cold-start can exceed the default 10s hook timeout when runtime suites start in parallel

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await pg.exec(`TRUNCATE office_dallas.bid_board_sync_runs; TRUNCATE public.bid_board_sync_alert_state;`);
});

async function seedRun(status: string, createdAt: Date) {
  await client.query(`INSERT INTO office_dallas.bid_board_sync_runs (status, created_at) VALUES ($1, $2)`, [
    status,
    createdAt,
  ]);
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
