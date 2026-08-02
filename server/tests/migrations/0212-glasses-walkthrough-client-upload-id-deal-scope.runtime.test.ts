// Executes Migration 0212 FROM DISK against a real Postgres (PGlite).
//
// 0212 re-keys the `files` rows that glasses-walkthrough completions wrote BEFORE the stored
// `client_upload_id` became deal-scoped (`deriveGlassesWalkthroughClientUploadId`). Without it, those rows
// are not merely stale — they are a 500. `files.r2_key` carries its OWN unique constraint, and the R2 key
// derivation did not change, so a retried completion of an already-filed walk inserts a row whose
// client_upload_id no longer collides (skipping the ON CONFLICT arbiter entirely) and whose r2_key still
// does: SQLSTATE 23505, raised inside the request transaction, on the exact retry path idempotency exists
// to make safe. One walk is already filed in production this way.
//
// What only a real-SQL test can establish here:
//   1. The SQL digest and the TypeScript digest agree BYTE FOR BYTE. Two independent implementations of one
//      derivation is the whole risk of a backfill like this; if they diverge, every backfilled row is
//      simply a different kind of orphan and the retry still duplicates.
//   2. Re-running is a no-op (the runner replays nothing, but a migration that double-digests is a
//      migration nobody can safely re-apply by hand).
//   3. It touches glasses-walkthrough rows and NOTHING else — `files` is the busiest table in the tenant
//      and `client_upload_id` is shared with the field-photo queue and scorecard evidence.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { deriveGlassesWalkthroughClientUploadId } from "../../src/modules/walkthrough-capture/glasses-walkthrough-service.js";

const MIGRATION_SQL = readFileSync(
  join(__dirname, "../../../migrations/0212_glasses_walkthrough_client_upload_id_deal_scope.sql"),
  "utf-8"
);

const DEAL_A = "00000000-0000-4000-8000-00000000a001";
const DEAL_B = "00000000-0000-4000-8000-00000000b002";

let pg: PGlite;

/** Only the columns 0212 reads or writes, in a schema whose name the migration's `office\_%` loop matches.
 *  The partial unique index is included because it is what makes a bad backfill fail loudly here rather
 *  than in production. */
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_dallas;
    CREATE TABLE office_dallas.files (
      id serial PRIMARY KEY,
      subcategory varchar(100),
      client_upload_id varchar(64),
      deal_id uuid,
      r2_key varchar(1000) NOT NULL UNIQUE
    );
    CREATE UNIQUE INDEX files_client_upload_id_key
      ON office_dallas.files (client_upload_id) WHERE client_upload_id IS NOT NULL;
  `);
});

afterEach(async () => {
  await pg.close();
});

async function idsByR2Key(): Promise<Record<string, string | null>> {
  const { rows } = await pg.query<{ r2_key: string; client_upload_id: string | null }>(
    "SELECT r2_key, client_upload_id FROM office_dallas.files ORDER BY r2_key"
  );
  return Object.fromEntries(rows.map((r) => [r.r2_key, r.client_upload_id]));
}

describe("0212 glasses-walkthrough client_upload_id deal scope", () => {
  it("re-keys a legacy glasses row to EXACTLY what the service now derives", async () => {
    await pg.exec(`
      INSERT INTO office_dallas.files (subcategory, client_upload_id, deal_id, r2_key) VALUES
        ('glasses-walkthrough', 'walk-7:video', '${DEAL_A}', 'dallas/deals/a/walk-7/video.mp4');
    `);

    await pg.exec(MIGRATION_SQL);

    // The one assertion the whole migration rests on: SQL's sha256 over
    // (deal_id, NUL, raw key) must equal Node's, prefix and truncation included.
    expect((await idsByR2Key())["dallas/deals/a/walk-7/video.mp4"]).toBe(
      deriveGlassesWalkthroughClientUploadId(DEAL_A, "walk-7:video")
    );
  });

  it("re-keys the SAME raw key under two deals to two DISTINCT ids", async () => {
    // The defect being repaired could only ever produce one of these two rows — the second deal's insert
    // lost the conflict. A backfill that mapped them to one value would recreate that collision in the
    // repaired data and fail on the unique index right here.
    await pg.exec(`
      INSERT INTO office_dallas.files (subcategory, client_upload_id, deal_id, r2_key) VALUES
        ('glasses-walkthrough', 'walk-7:video', '${DEAL_A}', 'dallas/deals/a/walk-7/video.mp4'),
        ('glasses-walkthrough', 'walk-7:audio', '${DEAL_B}', 'dallas/deals/b/walk-7/audio.m4a');
    `);

    await pg.exec(MIGRATION_SQL);

    const ids = await idsByR2Key();
    expect(ids["dallas/deals/a/walk-7/video.mp4"]).toBe(deriveGlassesWalkthroughClientUploadId(DEAL_A, "walk-7:video"));
    expect(ids["dallas/deals/b/walk-7/audio.m4a"]).toBe(deriveGlassesWalkthroughClientUploadId(DEAL_B, "walk-7:audio"));
  });

  it("is a no-op on a second run — an already-scoped id is never digested again", async () => {
    await pg.exec(`
      INSERT INTO office_dallas.files (subcategory, client_upload_id, deal_id, r2_key) VALUES
        ('glasses-walkthrough', 'walk-7:video', '${DEAL_A}', 'dallas/deals/a/walk-7/video.mp4');
    `);

    await pg.exec(MIGRATION_SQL);
    const afterFirst = await idsByR2Key();
    await pg.exec(MIGRATION_SQL);

    expect(await idsByR2Key()).toEqual(afterFirst);
  });

  it("leaves every other producer's client_upload_id alone", async () => {
    // `client_upload_id` is shared with the field-photo queue and scorecard edit evidence, whose keys are
    // client-minted UUIDs the mobile app still matches its own queue entries against. Rewriting one of
    // those would break a dedupe that has nothing to do with this change.
    await pg.exec(`
      INSERT INTO office_dallas.files (subcategory, client_upload_id, deal_id, r2_key) VALUES
        ('field-photo', 'f47ac10b-58cc-4372-a567-0e02b2c3d479', '${DEAL_A}', 'dallas/deals/a/photo.jpg'),
        (NULL, 'no-subcategory-at-all', '${DEAL_A}', 'dallas/deals/a/loose.pdf'),
        ('glasses-walkthrough', NULL, '${DEAL_A}', 'dallas/deals/a/legacy-no-key.mp4');
    `);

    await pg.exec(MIGRATION_SQL);

    expect(await idsByR2Key()).toEqual({
      "dallas/deals/a/photo.jpg": "f47ac10b-58cc-4372-a567-0e02b2c3d479",
      "dallas/deals/a/loose.pdf": "no-subcategory-at-all",
      "dallas/deals/a/legacy-no-key.mp4": null,
    });
  });

  it("leaves a glasses row with no deal_id alone rather than NULLing its id", async () => {
    // sha256 of a NULL is NULL, and `SET client_upload_id = NULL` would silently drop that row out of the
    // dedupe index entirely — a repair that loses idempotency is worse than the row it was repairing.
    // Unreachable through the ingress (dealId is a required path segment), which is exactly why the guard
    // has to be in the WHERE clause rather than in an assumption.
    await pg.exec(`
      INSERT INTO office_dallas.files (subcategory, client_upload_id, deal_id, r2_key) VALUES
        ('glasses-walkthrough', 'orphan:video', NULL, 'dallas/deals/none/walk.mp4');
    `);

    await pg.exec(MIGRATION_SQL);

    expect((await idsByR2Key())["dallas/deals/none/walk.mp4"]).toBe("orphan:video");
  });
});
