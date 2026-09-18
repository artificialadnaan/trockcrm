import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { aliasedPendingRfpAttentionFirstSql } from "../../../src/modules/deals/pending-rfp-service.js";

// EXECUTES the ordering key against real rows rather than asserting the SQL string. A substring check
// would pass on a fragment that orders backwards, or that misses pending_outbox — which is exactly the
// class of bug this ordering exists to prevent, so the test has to actually sort.

let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY,
      name text,
      rfp_approval_status text,
      rfp_approval_requested_at timestamptz
    );
    INSERT INTO deals (id, name, rfp_approval_status, rfp_approval_requested_at) VALUES
      ('00000000-0000-0000-0000-00000000a001','awaiting-oldest','pending',        '2026-01-01T00:00:00Z'),
      ('00000000-0000-0000-0000-00000000a002','awaiting-outbox','pending_outbox', '2026-02-01T00:00:00Z'),
      ('00000000-0000-0000-0000-00000000b001','attention-newest','send_failed',   '2026-09-01T00:00:00Z'),
      ('00000000-0000-0000-0000-00000000b002','attention-older','declined',       '2026-08-01T00:00:00Z'),
      ('00000000-0000-0000-0000-00000000b003','attention-conflict','conflict',    '2026-08-15T00:00:00Z');
  `);
  tdb = drizzle(pg as any);
});

afterAll(async () => {
  await pg.close();
});

async function orderedNames() {
  const rows: any = await tdb.execute(sql`
    SELECT name FROM deals
    ORDER BY ${aliasedPendingRfpAttentionFirstSql("deals")} DESC,
             rfp_approval_requested_at ASC,
             id DESC
  `);
  return (rows.rows ?? rows).map((r: any) => r.name);
}

describe("aliasedPendingRfpAttentionFirstSql", () => {
  it("floats every attention status above every awaiting one, regardless of age", async () => {
    const names = await orderedNames();

    // The three attention deals are ALL newer than both awaiting deals, so an age-only sort would put
    // them last. Attention-first has to beat the age tiebreak, not merely coexist with it.
    expect(names.slice(0, 3)).toEqual([
      "attention-older",
      "attention-conflict",
      "attention-newest",
    ]);
    expect(names.slice(3)).toEqual(["awaiting-oldest", "awaiting-outbox"]);
  });

  it("keeps oldest-first within each group", async () => {
    const names = await orderedNames();

    // attention: 08-01 before 08-15 before 09-01; awaiting: 01-01 before 02-01.
    expect(names.indexOf("attention-older")).toBeLessThan(names.indexOf("attention-newest"));
    expect(names.indexOf("awaiting-oldest")).toBeLessThan(names.indexOf("awaiting-outbox"));
  });

  it("treats pending_outbox as awaiting, not as needing action", async () => {
    // The status most likely to be mishandled: a hand-written `status = 'pending'` check would sort
    // pending_outbox into the attention group and mark it as needing action on the board.
    const names = await orderedNames();

    expect(names.indexOf("awaiting-outbox")).toBeGreaterThan(names.indexOf("attention-newest"));
  });
});
