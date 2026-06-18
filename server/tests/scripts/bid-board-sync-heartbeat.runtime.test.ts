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
  const opts = { office: "dallas", thresholdMinutes: 60, realertMinutes: 60 };

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
});
