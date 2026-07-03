import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import {
  buildDescriptionHistoryEntry,
  listDealDescriptionHistory,
  lockCurrentDealDescription,
  recordDescriptionHistoryChange,
} from "../../../src/modules/deals/deal-description-history.js";

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const DEAL = U("d01");
const OTHER_DEAL = U("d02");
const ALICE = U("a01");
const BOB = U("b01");
const LEAD = U("ea01");
const DEAL_PLAIN = U("dead01");
const DEAL_LEAD = U("dead02");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text, email text);
    CREATE TABLE deal_history (
      id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
      deal_id uuid NOT NULL,
      field_name text NOT NULL,
      old_value text,
      new_value text,
      changed_by uuid NOT NULL,
      source text,
      reason text,
      changed_at timestamptz NOT NULL DEFAULT now()
    );
    INSERT INTO users (id, display_name, email) VALUES
      ('${ALICE}', 'Alice Rep', 'alice@x'),
      ('${BOB}', 'Bob Director', 'bob@x');
    INSERT INTO deal_history (id, deal_id, field_name, old_value, new_value, changed_by, source, changed_at) VALUES
      ('${U("01")}', '${DEAL}', 'description', NULL, 'First draft', '${ALICE}', 'deal_edit', '2026-01-01T10:00:00Z'),
      ('${U("02")}', '${DEAL}', 'description', 'First draft', 'Second, clearer scope', '${BOB}', 'deal_edit', '2026-02-01T10:00:00Z'),
      -- a non-description change on the same deal must NOT appear in the description log
      ('${U("03")}', '${DEAL}', 'project_type', '{"a":1}', '{"a":2}', '${ALICE}', NULL, '2026-03-01T10:00:00Z'),
      -- another deal's description edit must NOT leak in
      ('${U("04")}', '${OTHER_DEAL}', 'description', NULL, 'Someone else', '${ALICE}', 'deal_edit', '2026-01-15T10:00:00Z'),
      -- a description edit by a since-deleted user (no users row) -> changedByName null
      ('${U("05")}', '${DEAL}', 'description', 'Second, clearer scope', 'Third revision', '${U("f01")}', 'deal_edit', '2026-04-01T10:00:00Z');

    -- minimal deals/leads for the locked-old-value helper
    CREATE TABLE leads (id uuid PRIMARY KEY, description text);
    CREATE TABLE deals (id uuid PRIMARY KEY, description text, source_lead_id uuid);
    INSERT INTO leads (id, description) VALUES ('${LEAD}', 'lead authoritative desc');
    INSERT INTO deals (id, description, source_lead_id) VALUES
      ('${DEAL_PLAIN}', 'plain deal desc', NULL),
      ('${DEAL_LEAD}', 'stale deal mirror', '${LEAD}');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

describe("buildDescriptionHistoryEntry", () => {
  it("records the first description (null -> text) with field_name 'description' and source 'deal_edit'", () => {
    const entry = buildDescriptionHistoryEntry(null, "First draft", ALICE);
    expect(entry).toEqual({
      fieldName: "description",
      oldValue: null,
      newValue: "First draft",
      changedBy: ALICE,
      source: "deal_edit",
    });
  });

  it("records a text -> different text edit", () => {
    const entry = buildDescriptionHistoryEntry("old", "new", BOB);
    expect(entry).toMatchObject({ oldValue: "old", newValue: "new", changedBy: BOB });
  });

  it("records clearing the description (text -> null)", () => {
    const entry = buildDescriptionHistoryEntry("had text", null, ALICE);
    expect(entry).toMatchObject({ oldValue: "had text", newValue: null });
  });

  it("returns null when nothing changed (same text)", () => {
    expect(buildDescriptionHistoryEntry("same", "same", ALICE)).toBeNull();
  });

  it("returns null when both empty (null and undefined are the same empty)", () => {
    expect(buildDescriptionHistoryEntry(null, null, ALICE)).toBeNull();
    expect(buildDescriptionHistoryEntry(undefined, null, ALICE)).toBeNull();
    expect(buildDescriptionHistoryEntry(null, undefined, ALICE)).toBeNull();
  });

  it("uses the provided source, defaulting to deal_edit (scope_summary for the scoping workspace write)", () => {
    expect(buildDescriptionHistoryEntry("a", "b", ALICE)?.source).toBe("deal_edit");
    expect(buildDescriptionHistoryEntry("a", "b", ALICE, "scope_summary")?.source).toBe("scope_summary");
  });
});

describe("listDealDescriptionHistory", () => {
  it("returns only this deal's description edits, newest first, with the editor's name resolved", async () => {
    const rows = await listDealDescriptionHistory(tdb, DEAL);
    // 3 description edits on DEAL (ids 05, 02, 01) — the project_type row and the other deal are excluded.
    expect(rows.map((r) => r.id)).toEqual([U("05"), U("02"), U("01")]);
    expect(rows[0]).toMatchObject({
      oldValue: "Second, clearer scope",
      newValue: "Third revision",
      changedByName: null, // deleted user
    });
    expect(rows[1]).toMatchObject({ newValue: "Second, clearer scope", changedByName: "Bob Director" });
    expect(rows[2]).toMatchObject({ oldValue: null, newValue: "First draft", changedByName: "Alice Rep" });
    // changedAt is serialized to an ISO string
    expect(typeof rows[0].changedAt).toBe("string");
    expect(rows[0].changedAt).toContain("2026-04-01");
  });

  it("returns an empty array for a deal with no description history", async () => {
    expect(await listDealDescriptionHistory(tdb, U("dff"))).toEqual([]);
  });
});

describe("recordDescriptionHistoryChange (the shared write seam)", () => {
  const REC = U("dab1");
  const NOOP = U("dab2");

  it("inserts a row (honoring source + a shared changedAt) when the description changed", async () => {
    await recordDescriptionHistoryChange(tdb, {
      dealId: REC,
      oldDescription: "old scope",
      newDescription: "new scope",
      changedBy: ALICE,
      source: "scope_summary",
      changedAt: new Date("2026-05-01T12:00:00.000Z"),
    });
    const rows = await listDealDescriptionHistory(tdb, REC);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      oldValue: "old scope",
      newValue: "new scope",
      source: "scope_summary",
      changedByName: "Alice Rep",
    });
    expect(rows[0].changedAt).toContain("2026-05-01");
  });

  it("is a no-op when the description did not change (null and undefined are the same empty)", async () => {
    await recordDescriptionHistoryChange(tdb, { dealId: NOOP, oldDescription: "same", newDescription: "same", changedBy: ALICE });
    await recordDescriptionHistoryChange(tdb, { dealId: NOOP, oldDescription: null, newDescription: undefined, changedBy: ALICE });
    expect(await listDealDescriptionHistory(tdb, NOOP)).toEqual([]);
  });

  it("stamps changedAt from the DB clock (clock_timestamp) when no changedAt is passed", async () => {
    const before = Date.now();
    await recordDescriptionHistoryChange(tdb, { dealId: U("dab3"), oldDescription: "a", newDescription: "b", changedBy: ALICE });
    const [row] = await listDealDescriptionHistory(tdb, U("dab3"));
    expect(row).toBeDefined();
    // A real timestamp near "now" (not null, not the epoch) — proves the insert stamped it.
    const stamped = Date.parse(row.changedAt);
    expect(stamped).toBeGreaterThanOrEqual(before - 60_000);
    expect(stamped).toBeLessThanOrEqual(Date.now() + 60_000);
  });
});

describe("lockCurrentDealDescription (deal-mirror locked before-value)", () => {
  it("reads deals.description for a non-source-lead deal", async () => {
    expect(await lockCurrentDealDescription(tdb, DEAL_PLAIN)).toBe("plain deal desc");
  });

  it("reads the DEAL mirror even for a source-lead deal (the detail panel renders deals.description, not the lead)", async () => {
    expect(await lockCurrentDealDescription(tdb, DEAL_LEAD)).toBe("stale deal mirror");
  });

  it("returns null when the deal is absent", async () => {
    expect(await lockCurrentDealDescription(tdb, U("deadbee1"))).toBeNull();
  });
});
