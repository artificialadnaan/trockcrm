import { beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { getAiReviewQueue } from "../../../src/modules/ai-copilot/service.js";

/**
 * RUNTIME (PGlite) cover for getAiReviewQueue, because a mock cannot see an invalid query.
 *
 * The mocked both-ends test beside this one proves the SELECT and the mapper agree. It cannot prove the
 * SQL is legal, and that gap shipped a real defect: adding `d.is_change_order` to this SELECT without
 * adding it to `GROUP BY p.id, d.name, d.deal_number` makes Postgres reject the whole query — a failed
 * request, not a wrong label. `GROUP BY p.id` gives functional dependency for `p` only; every `d.*`
 * column of the LEFT JOINed deals row has to be listed itself.
 *
 * Two hazards a mocked `execute` is blind to, both live whenever a column is added to a query:
 *   - GROUP BY completeness (this one), and
 *   - CTE / alias scope (an outer SELECT naming a column its CTE never projected — the same class of
 *     defect found in reports/service forecast variance this round).
 * The only way to see either is to run the SQL.
 */
const PACKET = "11111111-1111-1111-1111-111111111111";
const PACKET_CO = "11111111-1111-1111-1111-111111111112";
const DEAL = "22222222-2222-2222-2222-222222222222";
const DEAL_CO = "22222222-2222-2222-2222-222222222223";

let tdb: any;

beforeAll(async () => {
  const pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, is_change_order boolean NOT NULL DEFAULT false, deal_number text
    );
    CREATE TABLE ai_copilot_packets (
      id uuid PRIMARY KEY, deal_id uuid, status text, summary_text text, confidence numeric,
      generated_at timestamptz, created_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE TABLE ai_task_suggestions (id uuid PRIMARY KEY, packet_id uuid, status text);
    CREATE TABLE ai_risk_flags (id uuid PRIMARY KEY, packet_id uuid, status text);
    CREATE TABLE ai_feedback (id uuid PRIMARY KEY, target_type text, target_id uuid, feedback_value text);
    SET search_path TO public;

    INSERT INTO deals (id, name, is_change_order, deal_number) VALUES
      ('${DEAL}','Tides Park Lane', false, 'DFW-1'),
      ('${DEAL_CO}','Tides Park Lane — Change Order 2', true, 'DFW-2');
    INSERT INTO ai_copilot_packets (id, deal_id, status, summary_text, confidence, generated_at) VALUES
      ('${PACKET}','${DEAL}','pending_review','s', 0.9, now()),
      ('${PACKET_CO}','${DEAL_CO}','pending_review','s', 0.9, now());
    -- Two suggestions on one packet so the aggregate actually groups more than one row.
    INSERT INTO ai_task_suggestions (id, packet_id, status) VALUES
      ('33333333-3333-3333-3333-333333333331','${PACKET_CO}','accepted'),
      ('33333333-3333-3333-3333-333333333332','${PACKET_CO}','dismissed');
  `);
  tdb = drizzle(pg);
});

describe("getAiReviewQueue against real Postgres", () => {
  it("executes — the grouped query is valid with deals.is_change_order selected", async () => {
    // If `d.is_change_order` were missing from the GROUP BY this rejects outright, which is exactly the
    // failure the mocked test cannot produce.
    const entries = await getAiReviewQueue(tdb, {});
    expect(entries).toHaveLength(2);
  });

  it("returns the real flag per packet, and aggregates still group correctly", async () => {
    const entries = await getAiReviewQueue(tdb, {});
    const byId = new Map(entries.map((e: any) => [e.id ?? e.packetId, e]));
    const co = entries.find((e: any) => e.dealId === DEAL_CO);
    const plain = entries.find((e: any) => e.dealId === DEAL);
    void byId;

    expect(co?.dealIsChangeOrder).toBe(true);
    expect(plain?.dealIsChangeOrder).toBe(false);
    // The extra GROUP BY column must not fan the aggregate out into duplicate rows.
    expect(co?.suggestedCount).toBe(2);
    expect(co?.acceptedCount).toBe(1);
    expect(co?.dismissedCount).toBe(1);
  });
});
