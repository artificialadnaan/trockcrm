// Executes Migration 0213 FROM DISK against a real Postgres (PGlite).
//
// 0213 is the only thing standing between two OVERLAPPING walk completions and two billed TROCK Scope
// forwards: the service's dedupe lookup is a SELECT, which takes no lock, so the constraint has to be on
// the table. An index is not testable from the type system and its PREDICATE is where the whole design
// lives, so this belongs in the real-SQL lane.
//
// Every case below is a row shape the glasses-walkthrough ingress genuinely produces, and each is a
// different way to get the predicate wrong:
//   - drop `status <> 'dead'` and dead-row re-enqueue starts throwing 23505, stranding a walk that can
//     never be re-recorded (a site visit is not repeatable);
//   - drop `payload->>'dealId'` and the second deal's forward silently never happens;
//   - drop the `job_type` predicate and every other producer's payload has to carry a unique walkId.
// The service's own runtime suite (glasses-walkthrough-service.runtime.test.ts) loads this same file and
// proves the ingress resolves a race through it; this one proves the file says what the ingress assumes.
import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { migrationSql } from "../helpers/migration-sql.js";

// CONCURRENTLY exists to keep a plain CREATE INDEX from holding a SHARE lock on a continuously-written
// production job_queue. PGlite is a single connection with no concurrent writers, cannot run it, and
// running it here would exercise the migration runner's autocommit behaviour rather than the constraint.
const MIGRATION_SQL = migrationSql("0213_job_queue_glasses_walkthrough_forward_live_uniq").replace(
  " CONCURRENTLY",
  ""
);

const WALK = "walk-7";
const DEAL_A = "00000000-0000-4000-8000-00000000a001";
const DEAL_B = "00000000-0000-4000-8000-00000000b002";

let pg: PGlite;

/** Only the columns 0213's index reads. `status` is a plain text column rather than the real `job_status`
 *  enum on purpose: the predicate compares it to a literal, so the enum adds a fixture to maintain and
 *  nothing to the property under test. */
beforeEach(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY,
      job_type varchar(100) NOT NULL,
      payload jsonb NOT NULL,
      status text NOT NULL DEFAULT 'pending'
    );
  `);
  await pg.exec(MIGRATION_SQL);
});

afterEach(async () => {
  await pg.close();
});

async function enqueue(walkId: string, dealId: string, status = "pending", jobType = "glasses_walkthrough_forward") {
  await pg.query("INSERT INTO public.job_queue (job_type, payload, status) VALUES ($1, $2::jsonb, $3)", [
    jobType,
    JSON.stringify({ walkId, dealId }),
    status,
  ]);
}

async function jobCount(): Promise<number> {
  const { rows } = await pg.query<{ n: string }>("SELECT count(*)::text AS n FROM public.job_queue");
  return Number(rows[0]!.n);
}

describe("0213 job_queue glasses-walkthrough forward live-uniqueness", () => {
  it("refuses a SECOND live forward for the same (walkId, dealId) — the duplicate that bills twice", async () => {
    await enqueue(WALK, DEAL_A);
    await expect(enqueue(WALK, DEAL_A)).rejects.toMatchObject({ message: expect.stringContaining("duplicate key") });
    expect(await jobCount()).toBe(1);
  });

  it("refuses it across DIFFERENT live statuses, not just two pendings", async () => {
    // A completion that lands while the worker is mid-forward must not be allowed to schedule a second one
    // — nor must one that lands after the forward COMPLETED, which would buy the whole transcription and
    // scope extraction again. "Live" is every status except dead, exactly as the service's own lookup
    // reads it.
    await enqueue(WALK, DEAL_A, "processing");
    await expect(enqueue(WALK, DEAL_A, "pending")).rejects.toThrow();
    await expect(enqueue(WALK, DEAL_A, "completed")).rejects.toThrow();
  });

  it("ALLOWS a live replacement alongside a DEAD row for the same pair", async () => {
    // The recovery path this feature cannot live without: a dead-lettered walk is re-enqueued (inheriting
    // the dead row's TROCK Scope checkpoint), and the dead row is deliberately left in place for the human
    // reconciliation it asked for. A unique index over ALL statuses would make that a 23505 and strand a
    // site visit nobody can re-record.
    await enqueue(WALK, DEAL_A, "dead");
    await enqueue(WALK, DEAL_A, "pending");
    expect(await jobCount()).toBe(2);
  });

  it("ALLOWS several DEAD rows for one pair, which successive failed attempts leave behind", async () => {
    await enqueue(WALK, DEAL_A, "dead");
    await enqueue(WALK, DEAL_A, "dead");
    await enqueue(WALK, DEAL_A, "dead");
    expect(await jobCount()).toBe(3);
  });

  it("ALLOWS the same walkId under a DIFFERENT deal — both forwards must happen", async () => {
    // walkId is minted on the phone and is not unique across deals. Keyed on walkId alone this index would
    // convert the second deal's forward into a silent no-op: a 201, a full project folder, and no scope.
    await enqueue(WALK, DEAL_A);
    await enqueue(WALK, DEAL_B);
    expect(await jobCount()).toBe(2);
  });

  it("constrains ONLY this job type, leaving every other producer's payload alone", async () => {
    // job_queue is shared by every job in the system and most payloads have no walkId at all — for those
    // the indexed expressions are both NULL, and NULLs are distinct in a unique index, so they would not
    // collide anyway. The job_type predicate is what keeps that from being an accident: it also keeps the
    // index small on a table that retains completed and dead rows forever.
    await enqueue(WALK, DEAL_A, "pending", "rfp_bidboard_create");
    await enqueue(WALK, DEAL_A, "pending", "rfp_bidboard_create");
    await enqueue(WALK, DEAL_A, "pending", "glasses_walkthrough_forward");
    expect(await jobCount()).toBe(3);
  });

  it("is created UNIQUE and partial, not merely present", async () => {
    // 0211 already indexes the same two expressions non-uniquely. An index that exists under the right name
    // but arbitrates nothing would leave every test above passing for the wrong reason — the inserts would
    // simply all succeed — so the definition itself is asserted.
    const { rows } = await pg.query<{ indexdef: string }>(
      "SELECT indexdef FROM pg_indexes WHERE indexname = 'job_queue_glasses_walkthrough_forward_live_uniq'"
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]!.indexdef).toContain("CREATE UNIQUE INDEX");
    expect(rows[0]!.indexdef).toContain("WHERE");
  });

  it("is idempotent: re-running the file is a no-op rather than a duplicate-name error", async () => {
    await pg.exec(MIGRATION_SQL);
    const { rows } = await pg.query(
      "SELECT 1 FROM pg_indexes WHERE indexname = 'job_queue_glasses_walkthrough_forward_live_uniq'"
    );
    expect(rows).toHaveLength(1);
  });
});
