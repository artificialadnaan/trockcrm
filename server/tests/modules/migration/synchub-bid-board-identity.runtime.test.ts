import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { readFileSync } from "node:fs";

const MIGRATION_SQL = readFileSync(
  new URL("../../../../migrations/0186_synchub_bid_board_identity.sql", import.meta.url),
  "utf8"
);

const DEAL = {
  created: "00000000-0000-0000-0000-000000000101",
  updateOnly: "00000000-0000-0000-0000-000000000102",
  duplicateFirst: "00000000-0000-0000-0000-000000000103",
  duplicateLater: "00000000-0000-0000-0000-000000000104",
  unrelated: "00000000-0000-0000-0000-000000000105",
  ambiguousUpdateOnly: "00000000-0000-0000-0000-000000000106",
};

let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.deals (
      id uuid PRIMARY KEY,
      name text NOT NULL,
      updated_at timestamptz NOT NULL DEFAULT now()
    );
    CREATE FUNCTION office_dallas.set_updated_at() RETURNS trigger
      LANGUAGE plpgsql AS $$
      BEGIN
        NEW.updated_at = now();
        RETURN NEW;
      END;
    $$;
    CREATE TRIGGER set_deals_updated_at
      BEFORE UPDATE ON office_dallas.deals
      FOR EACH ROW EXECUTE FUNCTION office_dallas.set_updated_at();
    CREATE TABLE office_dallas.audit_log (
      id bigserial PRIMARY KEY,
      table_name text NOT NULL,
      record_id uuid NOT NULL,
      action text NOT NULL,
      actor_system_process text,
      full_row jsonb,
      created_at timestamptz NOT NULL
    );

    INSERT INTO office_dallas.deals (id, name, updated_at) VALUES
      ('${DEAL.created}', 'Created by SyncHub', '2025-12-01T00:00:00Z'),
      ('${DEAL.updateOnly}', 'Linked by SyncHub', '2025-12-02T00:00:00Z'),
      ('${DEAL.duplicateFirst}', 'First duplicate', '2025-12-03T00:00:00Z'),
      ('${DEAL.duplicateLater}', 'Later duplicate', '2025-12-04T00:00:00Z'),
      ('${DEAL.unrelated}', 'Manual deal', '2025-12-05T00:00:00Z'),
      ('${DEAL.ambiguousUpdateOnly}', 'Ambiguous legacy link', '2025-12-06T00:00:00Z');

    INSERT INTO office_dallas.audit_log
      (table_name, record_id, action, actor_system_process, full_row, created_at)
    VALUES
      ('deals', '${DEAL.created}', 'insert', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-created","procoreBidId":null}', '2026-01-01T00:00:00Z'),
      ('deals', '${DEAL.created}', 'update', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-collision","procoreBidId":null}', '2026-01-02T00:00:00Z'),
      ('deals', '${DEAL.updateOnly}', 'update', 'Procore SyncHub Webhook',
       '{"bidBoardId":9002,"procoreBidId":null}', '2026-01-03T00:00:00Z'),
      ('deals', '${DEAL.duplicateFirst}', 'insert', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-duplicate"}', '2026-01-04T00:00:00Z'),
      ('deals', '${DEAL.duplicateLater}', 'insert', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-duplicate"}', '2026-01-05T00:00:00Z'),
      ('deals', '${DEAL.unrelated}', 'insert', 'Another Process',
       '{"bidBoardId":"bb-unrelated"}', '2026-01-06T00:00:00Z'),
      ('deals', '${DEAL.ambiguousUpdateOnly}', 'update', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-ambiguous-a"}', '2026-01-07T00:00:00Z'),
      ('deals', '${DEAL.ambiguousUpdateOnly}', 'update', 'Procore SyncHub Webhook',
       '{"bidBoardId":"bb-ambiguous-b"}', '2026-01-08T00:00:00Z');
  `);

  await pg.exec(MIGRATION_SQL);
}, 30_000);

afterAll(async () => {
  await pg?.close();
});

describe("migration 0186 — durable SyncHub Bid Board identity", () => {
  it("backfills audited identities without guessing through names or duplicate history", async () => {
    const result = await pg.query<{ id: string; synchub_bid_board_id: string | null }>(`
      SELECT id::text, synchub_bid_board_id
      FROM office_dallas.deals
      ORDER BY id
    `);
    const identities = new Map(result.rows.map((row) => [row.id, row.synchub_bid_board_id]));

    expect(identities.get(DEAL.created)).toBe("bb-created");
    expect(identities.get(DEAL.updateOnly)).toBe("9002");
    expect(identities.get(DEAL.duplicateFirst)).toBe("bb-duplicate");
    expect(identities.get(DEAL.duplicateLater)).toBeNull();
    expect(identities.get(DEAL.unrelated)).toBeNull();
    expect(identities.get(DEAL.ambiguousUpdateOnly)).toBeNull();

    const freshness = await pg.query<{ updated_at: string }>(
      `SELECT updated_at::text FROM office_dallas.deals WHERE id = $1`,
      [DEAL.created]
    );
    expect(new Date(freshness.rows[0]!.updated_at).toISOString()).toBe("2025-12-01T00:00:00.000Z");
  });

  it("is rerunnable and enforces one stable identity per tenant", async () => {
    await expect(pg.exec(MIGRATION_SQL)).resolves.toBeDefined();
    await expect(
      pg.query(
        `UPDATE office_dallas.deals SET synchub_bid_board_id = $1 WHERE id = $2`,
        ["bb-created", DEAL.unrelated]
      )
    ).rejects.toThrow();
  });
});
