import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../../migrations/0215_backfill_needs_quantity.sql"),
  "utf-8"
);

let pg: PGlite;

async function seed(schema: string) {
  await pg.exec(`
    CREATE SCHEMA IF NOT EXISTS ${schema};
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_extractions (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      status text NOT NULL,
      quantity numeric(14,3),
      updated_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

/**
 * The full promote chain, for the remediation half of the migration. The base `seed` deliberately does
 * NOT create these: the migration guards on `to_regclass`, and a schema without them must still park
 * its extractions rather than fail — which is what the other tests cover.
 */
async function seedPromotionChain(schema: string) {
  await pg.exec(`
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_extraction_matches (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      extraction_id uuid NOT NULL
    );
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_line_items (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      quantity numeric(12,3) NOT NULL DEFAULT 1
    );
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_pricing_recommendations (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      extraction_match_id uuid NOT NULL,
      promoted_estimate_line_item_id uuid,
      source_type text,
      selected_source_type text,
      override_quantity numeric(14,3),
      -- The number promotion actually wrote onto the line: resolvePromotionLineValues falls back to
      -- one unit over this column, so COALESCE(recommended_quantity, 1) is what an untouched promoted
      -- line still carries. Widths match the real schema (14,3), so a value this fixture accepts is
      -- one the column would.
      recommended_quantity numeric(14,3)
    );
    CREATE TABLE IF NOT EXISTS ${schema}.estimate_review_events (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      project_id uuid,
      subject_type text NOT NULL,
      subject_id uuid NOT NULL,
      event_type text NOT NULL,
      before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      after_json jsonb NOT NULL DEFAULT '{}'::jsonb,
      reason text,
      user_id uuid,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

async function statuses(schema: string): Promise<Record<string, string>> {
  const { rows } = (await pg.query(
    `SELECT id::text AS id, status FROM ${schema}.estimate_extractions ORDER BY id`
  )) as { rows: Array<{ id: string; status: string }> };
  return Object.fromEntries(rows.map((row) => [row.id, row.status]));
}

beforeEach(async () => {
  pg = new PGlite();
});

afterEach(async () => {
  await pg.close();
});

describe("migration 0215 — parking already-priced rows that never had a usable quantity", () => {
  it("moves ONLY unpriceable processed rows, including NaN", async () => {
    // The reason a migration is needed at all: deploying the fix alone strands these. A `processed` row
    // is outside the worker's `pending` candidate filter, so it is never re-examined; the new promote
    // predicate refuses its recommendation; and its status keeps it out of the needs-quantity bucket.
    // Invisible in every direction, with no edit required to get there.
    await seed("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('00000000-0000-4000-8000-000000000001', 'processed', NULL),
        ('00000000-0000-4000-8000-000000000002', 'processed', 0),
        ('00000000-0000-4000-8000-000000000003', 'processed', -5),
        -- NaN is named explicitly in the migration because Postgres orders numeric NaN ABOVE every
        -- finite value: a positive test alone is TRUE for it and would leave it behind.
        ('00000000-0000-4000-8000-000000000004', 'processed', 'NaN'),
        -- Priced and perfectly fine: must not be disturbed.
        ('00000000-0000-4000-8000-000000000005', 'processed', 700),
        -- Human decisions are not this migration's to overwrite.
        ('00000000-0000-4000-8000-000000000006', 'approved', NULL),
        ('00000000-0000-4000-8000-000000000007', 'rejected', NULL),
        ('00000000-0000-4000-8000-000000000008', 'overridden', NULL),
        -- The worker will flag this itself on its next run.
        ('00000000-0000-4000-8000-000000000009', 'pending', NULL);
    `);

    await pg.exec(MIGRATION_SQL);

    const after = await statuses("office_dallas");
    expect(after["00000000-0000-4000-8000-000000000001"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000002"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000003"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000004"]).toBe("needs_quantity");
    expect(after["00000000-0000-4000-8000-000000000005"]).toBe("processed");
    expect(after["00000000-0000-4000-8000-000000000006"]).toBe("approved");
    expect(after["00000000-0000-4000-8000-000000000007"]).toBe("rejected");
    expect(after["00000000-0000-4000-8000-000000000008"]).toBe("overridden");
    expect(after["00000000-0000-4000-8000-000000000009"]).toBe("pending");
  });

  it("FLAGS an already-promoted line, because parking the source does not undo the price", async () => {
    // The gap this closes: the extraction moves to `needs_quantity`, but the line it already produced
    // is sitting in a client-facing estimate at the fabricated quantity of 1, still counted in the
    // total. Supplying the real quantity and rerunning then adds a CORRECTED line beside the stale one,
    // so the mispricing can end up double-counted rather than merely surviving.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 1);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id) VALUES
        ('44444444-4444-4444-8444-444444444444',
         '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222',
         '33333333-3333-4333-8333-333333333333');
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id, subject_type, event_type, reason,
              before_json->>'quantity' AS quantity
         FROM office_dallas.estimate_review_events`
    )) as { rows: Array<Record<string, string>> };

    expect(rows).toHaveLength(1);
    expect(rows[0]!.subject_id).toBe("33333333-3333-4333-8333-333333333333");
    expect(rows[0]!.subject_type).toBe("estimate_line_item");
    expect(rows[0]!.event_type).toBe("remediation_required");
    // The QUOTED quantity is captured, not the extraction's — that is the number a human has to judge.
    expect(rows[0]!.quantity).toBe("1.000");
    expect(rows[0]!.reason).toMatch(/still counted in the estimate total/i);
  });

  it("does NOT flag a line whose extraction was fine, and never flags one twice", async () => {
    // Two claims in one run: the flag follows the same unpriceable definition as the parking above, and
    // the insert is idempotent on replay — a deploy that runs the migration twice must not file a
    // second remediation task for the same line.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL),
        ('66666666-6666-4666-8666-666666666666', 'processed', 12);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'),
        ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 1),
        ('88888888-8888-4888-8888-888888888888', 12);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id) VALUES
        ('44444444-4444-4444-8444-444444444444',
         '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222',
         '33333333-3333-4333-8333-333333333333'),
        ('99999999-9999-4999-8999-999999999999',
         '55555555-5555-4555-8555-555555555555',
         '77777777-7777-4777-8777-777777777777',
         '88888888-8888-4888-8888-888888888888');
    `);

    await pg.exec(MIGRATION_SQL);
    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    expect(rows.map((row) => row.subject_id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("does NOT flag a line that never took its number from the extraction", async () => {
    // A manual recommendation promotes its own manualQuantity; an override with a quantity of its own
    // promotes that. For both the anchor extraction is only an artifact link, so the quoted line can be
    // perfectly correct even though the extraction is unpriceable. Telling an estimator such a line was
    // fabricated as one unit and asking them to void it is a FALSE remediation task — worse than none,
    // because it teaches people to ignore the queue.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL),
        ('66666666-6666-4666-8666-666666666666', 'processed', NULL),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'),
        ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 1),
        ('88888888-8888-4888-8888-888888888888', 40),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 25);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id,
         source_type, selected_source_type, override_quantity) VALUES
        -- extraction-derived: priced as one unit, MUST be flagged
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'extracted', NULL, NULL),
        -- manual: promotes manualQuantity, must NOT be flagged
        ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555',
         '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
         'manual', NULL, NULL),
        -- override with its own quantity: promotes overrideQuantity, must NOT be flagged
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
         'extracted', 'override', 25);
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    expect(rows.map((row) => row.subject_id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("does NOT flag a line an estimator has ALREADY corrected", async () => {
    // The remediation says, in the estimator's own queue, that this line "was priced as ONE UNIT" and
    // asks them to re-price or void it. For a line somebody has already fixed through the estimate-item
    // PATCH that sentence is false: `updateLineItem` (deals/estimate-service.ts) rewrites the quantity
    // and recalculates the total but never clears `promoted_estimate_line_item_id`, so the link this
    // migration joins on survives the correction and the extraction stays unpriceable forever.
    //
    // Flagging it tells somebody their finished work is broken. That is how a remediation queue stops
    // being read — the same reasoning as the manual/override exemption above, applied to the one case
    // where the line WAS fabricated and has since been repaired.
    //
    // The promoted number is `COALESCE(recommended_quantity, 1)`: `resolvePromotionLineValues` does
    // `quantity = row.quantity ?? "1"` over the recommendation's `recommendedQuantity`. A line still
    // carrying it has not been touched; a line carrying anything else has.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL),
        ('66666666-6666-4666-8666-666666666666', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'),
        ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        -- untouched: still the fabricated one unit
        ('33333333-3333-4333-8333-333333333333', 1),
        -- corrected by hand to the real number
        ('88888888-8888-4888-8888-888888888888', 8);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id,
         source_type, selected_source_type, override_quantity, recommended_quantity) VALUES
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'extracted', NULL, NULL, NULL),
        ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555',
         '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
         'extracted', NULL, NULL, NULL);
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    // Only the untouched line. The corrected one is left alone — and the control proves the migration
    // ran rather than that the predicate refused everything.
    expect(rows.map((row) => row.subject_id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("still flags a line whose recommendation carried a real quantity it never used", async () => {
    // The other side of `COALESCE(recommended_quantity, 1)`: when the recommendation DID hold a
    // quantity, the promoted line took that number, so "still carries the promoted value" means equal
    // to it — not equal to 1. Pinning only the `1` case would have let a stale non-1 line escape the
    // remediation it needs.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 3);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id,
         source_type, selected_source_type, override_quantity, recommended_quantity) VALUES
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'extracted', NULL, NULL, 3);
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    expect(rows.map((row) => row.subject_id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("does NOT flag an override carrying ZERO or NaN — that number came from the override", async () => {
    // `resolvePromotionLineValues` does `quantity = row.overrideQuantity ?? quantity`, and `??` falls
    // back on NULL ALONE. A zero, a negative or a NaN override is therefore the number that reached the
    // estimate; the extraction's missing quantity had nothing to do with it. The remediation this
    // migration writes says the line "was priced as ONE UNIT" from the extraction — for these rows that
    // is simply untrue, and a wrong remediation task is worse than none.
    //
    // Such a line may well be broken, for a DIFFERENT reason. That is not this migration's claim to
    // make, and no code path ORIGINATES a non-null `override_quantity` today — the insert in
    // recommendation-persistence-service.ts writes NULL, and the carry-forward inserts in
    // draft-estimate-service.ts only copy an existing value — so the exemption is defensive.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL),
        ('66666666-6666-4666-8666-666666666666', 'processed', NULL),
        ('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111'),
        ('77777777-7777-4777-8777-777777777777', '66666666-6666-4666-8666-666666666666'),
        ('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 1),
        ('88888888-8888-4888-8888-888888888888', 0),
        ('cccccccc-cccc-4ccc-8ccc-cccccccccccc', 0);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id,
         source_type, selected_source_type, override_quantity) VALUES
        -- the control: extraction-derived, priced as one unit, MUST still be flagged so a green
        -- assertion below cannot come from the migration failing to run at all
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'extracted', NULL, NULL),
        -- override of ZERO: nullish-coalescing keeps the 0, so the line took the override's number
        ('99999999-9999-4999-8999-999999999999', '55555555-5555-4555-8555-555555555555',
         '77777777-7777-4777-8777-777777777777', '88888888-8888-4888-8888-888888888888',
         'extracted', 'override', 0),
        -- override of NaN: non-null, so likewise not fabricated from the extraction
        ('dddddddd-dddd-4ddd-8ddd-dddddddddddd', '55555555-5555-4555-8555-555555555555',
         'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
         'extracted', 'override', 'NaN'::numeric);
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    expect(rows.map((row) => row.subject_id)).toEqual([
      "33333333-3333-4333-8333-333333333333",
    ]);
  });

  it("STILL flags an override whose own quantity is unusable, since it falls back to the extraction", async () => {
    // The narrowing must not become a hole: an override with a null quantity falls back to the
    // extraction, so its line WAS priced from the invalid number and does need remediation.
    await seed("office_dallas");
    await seedPromotionChain("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('11111111-1111-4111-8111-111111111111', 'processed', NULL);
      INSERT INTO office_dallas.estimate_extraction_matches (id, extraction_id) VALUES
        ('22222222-2222-4222-8222-222222222222', '11111111-1111-4111-8111-111111111111');
      INSERT INTO office_dallas.estimate_line_items (id, quantity) VALUES
        ('33333333-3333-4333-8333-333333333333', 1);
      INSERT INTO office_dallas.estimate_pricing_recommendations
        (id, deal_id, extraction_match_id, promoted_estimate_line_item_id,
         source_type, selected_source_type, override_quantity) VALUES
        ('44444444-4444-4444-8444-444444444444', '55555555-5555-4555-8555-555555555555',
         '22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333',
         'extracted', 'override', NULL);
    `);

    await pg.exec(MIGRATION_SQL);

    const { rows } = (await pg.query(
      `SELECT subject_id::text AS subject_id FROM office_dallas.estimate_review_events`
    )) as { rows: Array<{ subject_id: string }> };

    expect(rows).toHaveLength(1);
  });

  it("is REPLAYABLE — a second run changes nothing", async () => {
    await seed("office_dallas");
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity) VALUES
        ('00000000-0000-4000-8000-00000000000a', 'processed', NULL);
    `);

    await pg.exec(MIGRATION_SQL);
    const first = await pg.query(
      `SELECT updated_at FROM office_dallas.estimate_extractions LIMIT 1`
    );
    await pg.exec(MIGRATION_SQL);
    const second = await pg.query(
      `SELECT updated_at FROM office_dallas.estimate_extractions LIMIT 1`
    );

    // Already at needs_quantity, so the predicate no longer matches and even updated_at is untouched.
    expect((second.rows[0] as any).updated_at).toEqual((first.rows[0] as any).updated_at);
  });

  it("runs across EVERY office, and skips a half-provisioned schema", async () => {
    await seed("office_dallas");
    await seed("office_atlanta");
    await pg.exec(`CREATE SCHEMA office_halfbuilt;`);
    await pg.exec(`
      INSERT INTO office_dallas.estimate_extractions (id, status, quantity)
        VALUES ('00000000-0000-4000-8000-00000000000b', 'processed', NULL);
      INSERT INTO office_atlanta.estimate_extractions (id, status, quantity)
        VALUES ('00000000-0000-4000-8000-00000000000c', 'processed', 0);
    `);

    await pg.exec(MIGRATION_SQL);

    expect((await statuses("office_dallas"))["00000000-0000-4000-8000-00000000000b"]).toBe(
      "needs_quantity"
    );
    expect((await statuses("office_atlanta"))["00000000-0000-4000-8000-00000000000c"]).toBe(
      "needs_quantity"
    );
  });
});
