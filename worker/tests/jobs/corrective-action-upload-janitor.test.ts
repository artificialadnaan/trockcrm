import { describe, expect, it, vi } from "vitest";
import { runCorrectiveActionUploadJanitor } from "../../src/jobs/corrective-action-upload-janitor.js";

const silent = { log: () => {}, warn: () => {}, error: () => {} };

/**
 * Content-routing mocks for the abandoned-upload janitor. Reclamation is now a TWO-PHASE flow (finding 2):
 *   1) a lock-FREE snapshot SELECT (deps.query) of stale + unattached candidate (file_id, scorecard_id) pairs;
 *   2) per candidate, a transaction on a checked-out client (deps.connect) that BEGINs, takes the parent-
 *      scorecard `SELECT ... FOR UPDATE` lock, RE-CHECKS stale/active/unattached under the lock, and only then
 *      soft-deletes the file + deletes the ledger row in ONE CTE — so a concurrent submit that attaches the file
 *      first is caught by the under-lock re-check and NOT reclaimed.
 *
 * The tests assert:
 *   - the snapshot runs per active office schema (only where the ledger table exists);
 *   - each candidate is reclaimed under its own BEGIN + FOR UPDATE lock + COMMIT;
 *   - the under-lock re-check CTE encodes the STALE + UNATTACHED discrimination and mirrors deleteFile's
 *     soft-delete;
 *   - a candidate that gets ATTACHED under the lock (the re-check CTE reclaims 0 rows) is NOT counted;
 *   - the sweep is best-effort (one office / one candidate failing doesn't abort the rest).
 */
function makeQuery(opts: {
  offices?: { slug: string }[];
  tableExists?: Record<string, boolean>;
  // Per office schema: the candidate (file_id, scorecard_id) pairs the lock-free snapshot returns.
  candidates?: Record<string, { file_id: string; scorecard_id: string }[]>;
  // Per file_id: whether the UNDER-LOCK re-check CTE still reclaims it (true) or finds it attached/gone (false,
  // e.g. a concurrent submit linked it first → the NOT EXISTS fails → 0 rows). Defaults to true.
  reclaimUnderLock?: Record<string, boolean>;
  // Per office schema: throw when the snapshot SELECT runs (models an office-wide failure).
  throwSnapshot?: Record<string, boolean>;
  // Per file_id: throw inside the per-candidate transaction (models a single-candidate failure → ROLLBACK).
  throwReclaim?: Record<string, boolean>;
}) {
  const calls: { sql: string; params: unknown[] }[] = [];
  // Client-level calls (BEGIN / lock / CTE / COMMIT / ROLLBACK), across all checked-out clients.
  const clientCalls: { sql: string; params: unknown[] }[] = [];
  let released = 0;

  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    calls.push({ sql, params });

    if (/FROM public\.offices WHERE is_active = true/i.test(sql)) {
      const offices = opts.offices ?? [{ slug: "dallas" }];
      return { rows: offices, rowCount: offices.length };
    }
    if (/information_schema\.tables/i.test(sql)) {
      const schema = String((params as any[])[0]);
      const exists = opts.tableExists ? opts.tableExists[schema] !== false : true;
      return { rows: exists ? [{ "?column?": 1 }] : [], rowCount: exists ? 1 : 0 };
    }
    // The lock-free candidate snapshot: SELECT u.file_id, u.scorecard_id ... (no WITH stale, no FOR UPDATE).
    if (/SELECT u\.file_id, u\.scorecard_id/i.test(sql)) {
      const m = sql.match(/"(office_[a-z0-9_]+)"\./i);
      const schema = m ? m[1] : "office_dallas";
      if (opts.throwSnapshot?.[schema]) throw new Error(`boom snapshot ${schema}`);
      const cands = opts.candidates?.[schema] ?? [];
      return { rows: cands, rowCount: cands.length };
    }
    return { rows: [], rowCount: 0 };
  });

  const connect = vi.fn(async () => {
    const clientQuery = vi.fn(async (sql: string, params: unknown[] = []) => {
      clientCalls.push({ sql, params });
      if (/^\s*BEGIN/i.test(sql)) return { rows: [] };
      if (/^\s*COMMIT/i.test(sql)) return { rows: [] };
      if (/^\s*ROLLBACK/i.test(sql)) return { rows: [] };
      if (/FOR UPDATE/i.test(sql)) return { rows: [{ id: (params as any[])[0] }] };
      if (/WITH stale AS/i.test(sql)) {
        const fileId = String((params as any[])[0]);
        if (opts.throwReclaim?.[fileId]) throw new Error(`boom reclaim ${fileId}`);
        const reclaim = opts.reclaimUnderLock ? opts.reclaimUnderLock[fileId] !== false : true;
        return { rows: reclaim ? [{ file_id: fileId }] : [], rowCount: reclaim ? 1 : 0 };
      }
      return { rows: [], rowCount: 0 };
    });
    return {
      query: clientQuery as any,
      release: () => {
        released += 1;
      },
    };
  });

  return {
    query: query as any,
    connect: connect as any,
    calls,
    clientCalls,
    releasedCount: () => released,
  };
}

describe("runCorrectiveActionUploadJanitor", () => {
  it("reclaims a stale, unattached upload under a per-scorecard FOR UPDATE lock, then soft-deletes + deletes the ledger", async () => {
    const { query, connect, calls, clientCalls, releasedCount } = makeQuery({
      offices: [{ slug: "dallas" }],
      candidates: { office_dallas: [{ file_id: "f1", scorecard_id: "s1" }] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });

    // The lock-free snapshot ran, selecting the scorecard_id (the lock key).
    const snapshot = calls.find((c) => /SELECT u\.file_id, u\.scorecard_id/i.test(c.sql));
    expect(snapshot).toBeDefined();
    expect(snapshot!.sql).toMatch(/created_at < now\(\) - interval '24 hours'/i);
    expect(snapshot!.sql).toMatch(/NOT EXISTS/i);
    expect(snapshot!.sql).toMatch(/field_scorecard_photos/i);

    // The candidate was reclaimed inside a transaction: BEGIN → FOR UPDATE lock on ITS scorecard → CTE → COMMIT.
    const begin = clientCalls.find((c) => /^\s*BEGIN/i.test(c.sql));
    const lock = clientCalls.find((c) => /FOR UPDATE/i.test(c.sql));
    const cte = clientCalls.find((c) => /WITH stale AS/i.test(c.sql));
    const commit = clientCalls.find((c) => /^\s*COMMIT/i.test(c.sql));
    expect(begin).toBeDefined();
    expect(lock).toBeDefined();
    expect(cte).toBeDefined();
    expect(commit).toBeDefined();

    // The lock is on the candidate's parent scorecard (same lock the submit/discard paths take).
    expect(lock!.sql).toMatch(/FROM "office_dallas"\.field_scorecards WHERE id = \$1::uuid LIMIT 1 FOR UPDATE/i);
    expect(lock!.params).toEqual(["s1"]);

    // The under-lock re-check CTE encodes the STALE + UNATTACHED discrimination, mirrors deleteFile's soft-
    // delete, is keyed to THIS candidate's file_id, and removes the ledger row.
    expect(cte!.sql).toMatch(/created_at < now\(\) - interval '24 hours'/i);
    expect(cte!.sql).toMatch(/f\.is_active = true/i);
    expect(cte!.sql).toMatch(/f\.deleted_at IS NULL/i);
    expect(cte!.sql).toMatch(/NOT EXISTS/i);
    expect(cte!.sql).toMatch(/field_scorecard_photos/i);
    expect(cte!.sql).toMatch(/SET is_active = false, deleted_at = now\(\)/i);
    expect(cte!.sql).toMatch(/DELETE FROM "office_dallas"\.scorecard_corrective_action_uploads/i);
    expect(cte!.params).toEqual(["f1"]);

    // The checked-out client was released.
    expect(releasedCount()).toBe(1);
  });

  it("does NOT reclaim a candidate that gets ATTACHED under the lock (concurrent submit wins)", async () => {
    // The snapshot saw the file unattached, but a concurrent submit linked it (field_scorecard_photos) before
    // the janitor's lock. Under the lock, the re-check CTE's NOT EXISTS now fails → it reclaims 0 rows → the
    // file is left in the finalized response (never soft-deleted).
    const { query, connect, clientCalls } = makeQuery({
      offices: [{ slug: "dallas" }],
      candidates: { office_dallas: [{ file_id: "f1", scorecard_id: "s1" }] },
      reclaimUnderLock: { f1: false }, // attached before the lock → CTE reclaims nothing
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    // The office was swept but nothing reclaimed (the concurrent submit won).
    expect(result).toEqual({ reclaimed: 0, officesSwept: 1 });
    // The lock + re-check STILL ran (we didn't skip the transaction) — the re-check is what caught the attach.
    expect(clientCalls.find((c) => /FOR UPDATE/i.test(c.sql))).toBeDefined();
    expect(clientCalls.find((c) => /WITH stale AS/i.test(c.sql))).toBeDefined();
    // It committed (the empty CTE is a clean no-op, not a rollback).
    expect(clientCalls.find((c) => /^\s*COMMIT/i.test(c.sql))).toBeDefined();
  });

  it("leaves ATTACHED and RECENT uploads out of the snapshot entirely (nothing reclaimed, no lock taken)", async () => {
    // An ATTACHED file and a RECENT unattached file are excluded by the snapshot's WHERE, so no candidate is
    // returned → no per-candidate transaction runs at all.
    const { query, connect, clientCalls } = makeQuery({
      offices: [{ slug: "dallas" }],
      candidates: { office_dallas: [] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    expect(result).toEqual({ reclaimed: 0, officesSwept: 1 });
    // No client was ever checked out (no candidate to reclaim).
    expect(clientCalls).toHaveLength(0);
    expect(connect).not.toHaveBeenCalled();
  });

  it("skips an office whose ledger table does not exist (pre-feature schema)", async () => {
    const { query, connect, calls } = makeQuery({
      offices: [{ slug: "dallas" }, { slug: "atlanta" }],
      tableExists: { office_atlanta: false },
      candidates: { office_dallas: [{ file_id: "f1", scorecard_id: "s1" }] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });
    // No snapshot ever runs against atlanta (skipped before reclamation).
    expect(
      calls.find((c) => /SELECT u\.file_id, u\.scorecard_id/i.test(c.sql) && /office_atlanta/i.test(c.sql))
    ).toBeUndefined();
  });

  it("reclaims MULTIPLE candidates, each under its own lock, counting only those actually reclaimed", async () => {
    const { query, connect, clientCalls, releasedCount } = makeQuery({
      offices: [{ slug: "dallas" }],
      candidates: {
        office_dallas: [
          { file_id: "f1", scorecard_id: "s1" },
          { file_id: "f2", scorecard_id: "s2" }, // gets attached under the lock → not reclaimed
          { file_id: "f3", scorecard_id: "s1" },
        ],
      },
      reclaimUnderLock: { f2: false },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    // f1 + f3 reclaimed; f2 attached under lock.
    expect(result).toEqual({ reclaimed: 2, officesSwept: 1 });
    // Each candidate took its own FOR UPDATE lock on its own scorecard.
    const locks = clientCalls.filter((c) => /FOR UPDATE/i.test(c.sql));
    expect(locks.map((l) => l.params[0])).toEqual(["s1", "s2", "s1"]);
    // A client was checked out and released for each candidate.
    expect(releasedCount()).toBe(3);
  });

  it("is best-effort per office: one office's snapshot throwing does not abort the others", async () => {
    const { query, connect } = makeQuery({
      offices: [{ slug: "dallas" }, { slug: "atlanta" }],
      throwSnapshot: { office_dallas: true },
      candidates: { office_atlanta: [{ file_id: "f2", scorecard_id: "s2" }] },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    // Dallas' snapshot threw (caught + logged, so its officesSwept increment never ran); Atlanta reclaimed 1.
    expect(result).toEqual({ reclaimed: 1, officesSwept: 1 });
  });

  it("is best-effort per candidate: one candidate's transaction throwing ROLLS BACK and does not abort the rest", async () => {
    const { query, connect, clientCalls, releasedCount } = makeQuery({
      offices: [{ slug: "dallas" }],
      candidates: {
        office_dallas: [
          { file_id: "f1", scorecard_id: "s1" },
          { file_id: "f2", scorecard_id: "s2" }, // throws inside the transaction
          { file_id: "f3", scorecard_id: "s3" },
        ],
      },
      throwReclaim: { f2: true },
    });

    const result = await runCorrectiveActionUploadJanitor({ query, connect, logger: silent });

    // f1 + f3 reclaimed; f2 threw → rolled back and skipped, the sweep continued.
    expect(result).toEqual({ reclaimed: 2, officesSwept: 1 });
    // The failed candidate rolled back.
    expect(clientCalls.find((c) => /^\s*ROLLBACK/i.test(c.sql))).toBeDefined();
    // Every checked-out client (including the failed one) was released.
    expect(releasedCount()).toBe(3);
  });
});
