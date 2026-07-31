import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import { insertAiReportRunTx, isInFlightRunConflict } from "../../../src/modules/field/ai-report-runs.js";

/**
 * REAL SQL, no mocks. The route suite mocks insertAiReportRunTx, so it cannot see whether the statement is
 * even valid — and the first version of this insert was NOT: a bare `${array}` in a drizzle template is
 * expanded as a value list (`($1, $2)::uuid[]`), which is a syntax error that would have failed every single
 * AI-report enqueue in production while every mocked test stayed green.
 *
 * These run the actual migration and the actual statements against PGlite.
 */

// Resolved relative to THIS FILE, not process.cwd(). cwd is the repo root under the root vitest config but
// `server/` under `--workspace=server` (which is what CI's runtime pass uses), so a cwd-relative path loads
// here and fails there — the file errors at import and its tests are silently skipped rather than failing
// loudly. Same form every other server runtime test uses.
const MIGRATION = fileURLToPath(new URL("../../../../migrations/0208_field_ai_report_runs.sql", import.meta.url));

let client: PGlite;
let db: ReturnType<typeof drizzle>;
let officeId: string;
let userId: string;

const DEAL = "11111111-1111-1111-1111-111111111111";
const PHOTOS = ["aaaaaaaa-1111-1111-1111-111111111111", "bbbbbbbb-2222-2222-2222-222222222222"];

beforeAll(async () => {
  client = new PGlite();
  await client.exec(`
    CREATE TABLE public.offices (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), slug text NOT NULL);
    CREATE TABLE public.users   (id uuid PRIMARY KEY DEFAULT gen_random_uuid(), email text NOT NULL);
  `);
  await client.exec(readFileSync(MIGRATION, "utf8"));
  db = drizzle(client);
  officeId = (await client.query<{ id: string }>(`INSERT INTO public.offices (slug) VALUES ('dallas') RETURNING id`)).rows[0].id;
  userId = (await client.query<{ id: string }>(`INSERT INTO public.users (email) VALUES ('a@b.c') RETURNING id`)).rows[0].id;
});

/** The EXACT statement shape insertAiReportRunTx issues. */
async function insertRun(dealId = DEAL, requestedBy?: string, photoIds = PHOTOS) {
  const result = await db.execute(sql`
    INSERT INTO public.field_ai_report_runs
      (deal_id, office_id, office_slug, requested_by, photo_ids, report_title, focus_prompt, status)
    VALUES (
      ${dealId}::uuid,
      ${officeId}::uuid,
      ${"dallas"},
      ${requestedBy ?? userId}::uuid,
      ${sql.param(photoIds)}::uuid[],
      ${"Title"},
      ${"roof drainage only"},
      'queued'
    )
    RETURNING *
  `);
  return (result as unknown as { rows: Array<Record<string, unknown>> }).rows[0];
}

describe("field_ai_report_runs — real SQL", () => {
  it("inserts a run with its photo_ids bound as a single uuid[] parameter", async () => {
    const row = await insertRun();
    expect(row.status).toBe("queued");
    // The regression this file exists for: a value-list expansion would have thrown before reaching here.
    expect(row.photo_ids).toEqual(PHOTOS);
    expect(row.focus_prompt).toBe("roof drainage only");
  });

  it("rejects a second in-flight run, and the PRODUCTION predicate recognises the wrapped driver error", async () => {
    const dealId = "22222222-2222-2222-2222-222222222222";
    await insertRun(dealId);

    const error = await insertRun(dealId).then(
      () => { throw new Error("expected the in-flight index to reject the second insert"); },
      (e) => e,
    );

    // drizzle WRAPS the pg error (the thrown object is a DrizzleQueryError whose message is the failed SQL;
    // the pg error with code/constraint hangs off .cause). A predicate that only inspected the top-level
    // error would never match, turning the whole double-tap path into dead code that 500s. Assert through
    // the real predicate so that can't regress.
    expect(isInFlightRunConflict(error)).toBe(true);
    // ...and it must not claim every error is a double-tap.
    expect(isInFlightRunConflict(new Error("something else"))).toBe(false);
    expect(isInFlightRunConflict({ code: "23505", constraint: "some_other_uidx" })).toBe(false);
  });

  it("frees the slot once the run reaches a terminal state", async () => {
    const dealId = "33333333-3333-3333-3333-333333333333";
    const first = await insertRun(dealId);
    await client.query(`UPDATE public.field_ai_report_runs SET status='succeeded' WHERE id=$1`, [first.id as string]);
    await expect(insertRun(dealId)).resolves.toBeTruthy();
  });

  it("does not block a different requester on the same project", async () => {
    const dealId = "44444444-4444-4444-4444-444444444444";
    const other = (await client.query<{ id: string }>(`INSERT INTO public.users (email) VALUES ('c@d.e') RETURNING id`)).rows[0].id;
    await insertRun(dealId);
    await expect(insertRun(dealId, other)).resolves.toBeTruthy();
  });

  it("enforces the photo-count bounds at the database, not only in the route", async () => {
    // The route caps the selection at 60, but the worker reads photo_ids straight back out and hands every
    // element to the model — so the spend bound has to exist below the route too.
    const codeOf = (e: unknown): string | undefined => {
      for (let c: any = e, d = 0; c && d < 5; d += 1, c = c.cause) if (c.code) return c.code;
      return undefined;
    };
    const empty = await insertRun("55555555-5555-5555-5555-555555555555", undefined, []).catch((e) => e);
    expect(codeOf(empty)).toBe("23514");
    const tooMany = Array.from({ length: 61 }, (_, i) => `${String(i).padStart(8, "0")}-1111-1111-1111-111111111111`);
    const over = await insertRun("66666666-6666-6666-6666-666666666666", undefined, tooMany).catch((e) => e);
    expect(codeOf(over)).toBe("23514");
  });

  it("rejects an unknown status", async () => {
    await expect(
      client.query(`UPDATE public.field_ai_report_runs SET status='bogus' WHERE deal_id=$1`, [DEAL]),
    ).rejects.toMatchObject({ code: "23514" });
  });

  it("re-claims a stale running row but leaves a fresh one alone", async () => {
    const dealId = "77777777-7777-7777-7777-777777777777";
    const row = await insertRun(dealId);
    const id = row.id as string;

    // The EXACT claim predicate from markAiReportRunRunning.
    const claim = () =>
      client.query(
        `UPDATE public.field_ai_report_runs
            SET status='running', started_at=now(), updated_at=now()
          WHERE id = $1::uuid
            AND (status = 'queued' OR (status = 'running' AND started_at < now() - ($2 || ' minutes')::interval))`,
        [id, "20"],
      );

    expect((await claim()).affectedRows).toBe(1); // queued → running
    expect((await claim()).affectedRows).toBe(0); // a live run is NOT re-claimable (no double Claude pass)

    await client.query(`UPDATE public.field_ai_report_runs SET started_at = now() - interval '45 minutes' WHERE id=$1`, [id]);
    // A run abandoned by a dead worker IS re-claimable, or a redelivered job could never finish it.
    expect((await claim()).affectedRows).toBe(1);
  });

  it("only writes a terminal state over a run that is still running", async () => {
    // Guards the resurrect-after-reap race: if the stale sweep already failed a run and the user started a
    // new one, the old worker finishing late must not overwrite the ledger.
    const dealId = "88888888-8888-8888-8888-888888888888";
    const row = await insertRun(dealId);
    const id = row.id as string;
    await client.query(`UPDATE public.field_ai_report_runs SET status='failed' WHERE id=$1`, [id]);

    const succeed = await client.query(
      `UPDATE public.field_ai_report_runs SET status='succeeded', file_id=gen_random_uuid()
        WHERE id=$1::uuid AND status='running'`,
      [id],
    );
    expect(succeed.affectedRows).toBe(0);
    const after = await client.query<{ status: string }>(`SELECT status FROM public.field_ai_report_runs WHERE id=$1`, [id]);
    expect(after.rows[0].status).toBe("failed");
  });

  it("enqueues through the REAL insert path, taking a requester lock that does not leak", async () => {
    // The quota predicate lives inside the INSERT, but that is still a READ COMMITTED snapshot: parallel
    // enqueues for DIFFERENT projects each fail to see the others' uncommitted rows, and the in-flight
    // unique index only collides on the same (deal, requester) — so the lock is what actually serialises
    // them. PGlite is single-connection and cannot stage that race, but running the REAL function here does
    // prove two things a mocked db never could: that the added statement is valid Postgres (a bad hashtext()
    // call would 500 every enqueue), and that the lock is TRANSACTION-scoped.
    const quotaUser = (
      await client.query<{ id: string }>(`INSERT INTO public.users (email) VALUES ('quota@t.co') RETURNING id`)
    ).rows[0].id;

    // Run it inside an explicit transaction, the way the route does, so the lock can be OBSERVED while it is
    // still held. Asserting only after the fact would pass just as happily with no lock at all.
    const created = await db.transaction(async (tx) => {
      const run = await insertAiReportRunTx(tx as unknown as Parameters<typeof insertAiReportRunTx>[0], {
        dealId: "aaaaaaaa-9999-9999-9999-999999999999",
        officeId,
        officeSlug: "dallas",
        requestedBy: quotaUser,
        photoIds: PHOTOS,
        reportTitle: "Title",
        focusPrompt: null,
      });
      const held = await tx.execute<{ n: number }>(
        sql`SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
      );
      // The lock is held for the rest of the caller's transaction — this is the assertion that fails if the
      // statement is ever dropped, and the reason the quota holds under a parallel burst.
      expect((held as unknown as { rows: Array<{ n: number }> }).rows[0].n).toBe(1);
      return run;
    });

    expect(created.status).toBe("queued");
    expect(created.photoIds).toEqual(PHOTOS);
    // ...and released by the commit. A session-scoped pg_advisory_lock would still be held here and would
    // accumulate one entry per enqueue for the life of the connection.
    const locks = await client.query<{ n: number }>(
      `SELECT count(*)::int AS n FROM pg_locks WHERE locktype = 'advisory'`,
    );
    expect(locks.rows[0].n).toBe(0);
  });

  it("renews a live run's lease out from under the reaper, but cannot revive a terminal one", async () => {
    // The lease is what stops a slow-but-healthy run being reaped mid-render: Phase D is deliberately
    // unbounded, so a run that spends most of its model budget and then renders slowly crosses the 20-minute
    // window while it is still working. Its own requester, so the user-scoped reaper below can't be
    // perturbed by rows other tests left behind.
    const dealId = "99999999-9999-9999-9999-999999999999";
    const leaseUser = (
      await client.query<{ id: string }>(`INSERT INTO public.users (email) VALUES ('lease@t.co') RETURNING id`)
    ).rows[0].id;
    const id = (await insertRun(dealId, leaseUser)).id as string;

    // Working for 25 minutes: past the window, but alive.
    await client.query(
      `UPDATE public.field_ai_report_runs SET status='running', started_at = now() - interval '25 minutes' WHERE id=$1`,
      [id],
    );

    // The EXACT reaper predicate from expireStaleAiReportRuns.
    const reap = () =>
      client.query(
        `UPDATE public.field_ai_report_runs
            SET status='failed', finished_at=now(), updated_at=now()
          WHERE requested_by = $1::uuid
            AND status IN ('queued', 'running')
            AND COALESCE(started_at, created_at) < now() - ($2 || ' minutes')::interval`,
        [leaseUser, "20"],
      );
    // The EXACT statement touchAiReportRunLease issues.
    const renew = () =>
      client.query(
        `UPDATE public.field_ai_report_runs
            SET started_at = now(), updated_at = now()
          WHERE id = $1::uuid AND status = 'running'`,
        [id],
      );

    expect((await renew()).affectedRows).toBe(1);
    // Renewed, so the reaper now has nothing to take — which is the entire point of the heartbeat.
    expect((await reap()).affectedRows).toBe(0);

    // Once the row IS terminal the renewal must not resurrect it: a reaped attempt reviving itself would
    // hold the in-flight slot open against the replacement the user already started.
    await client.query(`UPDATE public.field_ai_report_runs SET status='failed' WHERE id=$1`, [id]);
    expect((await renew()).affectedRows).toBe(0);
    const after = await client.query<{ status: string }>(`SELECT status FROM public.field_ai_report_runs WHERE id=$1`, [id]);
    expect(after.rows[0].status).toBe("failed");
  });
});
