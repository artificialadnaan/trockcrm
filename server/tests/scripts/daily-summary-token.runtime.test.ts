import { PGlite } from "@electric-sql/pglite";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  storeDailySummarySnapshot,
  readDailySummaryByToken,
  hashSummaryToken,
  type DailySummaryPayload,
} from "../../src/modules/daily-summary/service.js";

let db: PGlite;
const client = () => ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as unknown[]) }) as never;

const payload = (date: string): DailySummaryPayload => ({
  date, office: "dallas", asOfLabel: "as of 5:00 PM CT",
  headline: { activeReps: 1, totalReps: 2, totalActions: 9, biggestMover: { name: "Kaleb", actions: 9 } },
  leaderboard: [{ rank: 1, name: "Kaleb", actions: 9 }],
  majorMoves: [], teamHealth: { active: 1, quiet: 1, quietNames: ["Zoe"] },
});
const future = new Date(Date.now() + 30 * 864e5);
const past = new Date(Date.now() - 864e5);

beforeAll(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE TABLE public.daily_summary_snapshots (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      summary_date date NOT NULL, office_code text NOT NULL,
      as_of timestamptz NOT NULL, payload jsonb NOT NULL,
      token text NOT NULL UNIQUE, expires_at timestamptz, revoked_at timestamptz,
      last_accessed_at timestamptz, access_count integer NOT NULL DEFAULT 0,
      created_at timestamptz NOT NULL DEFAULT now(),
      UNIQUE (summary_date, office_code)
    );
  `);
});
afterAll(async () => { await db?.close(); });

describe("daily-summary token security + snapshot", () => {
  it("a valid token returns the frozen payload and bumps access_count", async () => {
    const { rawToken } = await storeDailySummarySnapshot(client(), { date: "2026-06-12", office: "dallas", asOf: new Date(), payload: payload("2026-06-12"), expiresAt: future });
    expect(rawToken).toBeTruthy();
    const got = await readDailySummaryByToken(client(), rawToken!);
    expect(got?.date).toBe("2026-06-12");
    expect(got?.headline.biggestMover?.name).toBe("Kaleb");
    const { rows } = await db.query<{ access_count: number }>(`SELECT access_count FROM public.daily_summary_snapshots WHERE token = $1`, [hashSummaryToken(rawToken!)]);
    expect(rows[0].access_count).toBe(1);
  });

  it("rejects a missing/empty token", async () => {
    expect(await readDailySummaryByToken(client(), "")).toBeNull();
  });

  it("rejects a malformed/unknown token", async () => {
    expect(await readDailySummaryByToken(client(), "not-a-real-token")).toBeNull();
  });

  it("rejects an expired token", async () => {
    const { rawToken } = await storeDailySummarySnapshot(client(), { date: "2026-06-10", office: "dallas", asOf: new Date(), payload: payload("2026-06-10"), expiresAt: past });
    expect(await readDailySummaryByToken(client(), rawToken!)).toBeNull();
  });

  it("rejects a revoked token", async () => {
    const { rawToken } = await storeDailySummarySnapshot(client(), { date: "2026-06-09", office: "dallas", asOf: new Date(), payload: payload("2026-06-09"), expiresAt: future });
    await db.query(`UPDATE public.daily_summary_snapshots SET revoked_at = now() WHERE token = $1`, [hashSummaryToken(rawToken!)]);
    expect(await readDailySummaryByToken(client(), rawToken!)).toBeNull();
  });

  it("is idempotent: a second store for the same (date, office) no-ops (rawToken null)", async () => {
    const first = await storeDailySummarySnapshot(client(), { date: "2026-06-08", office: "dallas", asOf: new Date(), payload: payload("2026-06-08"), expiresAt: future });
    expect(first.rawToken).toBeTruthy();
    const second = await storeDailySummarySnapshot(client(), { date: "2026-06-08", office: "dallas", asOf: new Date(), payload: payload("2026-06-08"), expiresAt: future });
    expect(second.rawToken).toBeNull();
  });
});
