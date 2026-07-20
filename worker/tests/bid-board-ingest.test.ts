import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// The heavy lifting (inbox state machine, per-office serialization, recovery SQL) lives in the SERVER
// workspace and is exhaustively covered by server/tests/modules/bid-board-sync/inbox.runtime.test.ts (which
// runs in the CI gate). This file smoke-tests the thin worker WRAPPER's guard so a malformed job can't blow
// up the poller. (Worker tests are local-only per the repo convention; the wrapper is also compile-checked
// by `npm run build`.)

const connectMock = vi.hoisted(() => vi.fn());
vi.mock("../src/db.js", () => ({ pool: { connect: connectMock } }));

const { handleBidBoardIngestJob, timedPoolQuery } = await import("../src/jobs/bid-board-ingest.js");

describe("handleBidBoardIngestJob (worker wrapper guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no-ops on a job missing inboxId without touching the DB or importing the server module", async () => {
    await expect(handleBidBoardIngestJob({}, null)).resolves.toBeUndefined();
    await expect(handleBidBoardIngestJob(null, null)).resolves.toBeUndefined();
    expect(connectMock).not.toHaveBeenCalled();
  });
});

describe("timedPoolQuery (dead-socket safety)", () => {
  beforeEach(() => vi.clearAllMocks());
  afterEach(() => vi.useRealTimers());

  it("DESTROYS the checked-out client on timeout so a dead socket can't leak a pool slot", async () => {
    vi.useFakeTimers();
    const release = vi.fn();
    // A client whose query() never settles — the silent dead-socket case this guard exists for.
    connectMock.mockResolvedValue({ query: vi.fn(() => new Promise(() => {})), release });

    const p = timedPoolQuery("SELECT 1");
    const assertion = expect(p).rejects.toThrow(/inbox query timed out/);
    await vi.advanceTimersByTimeAsync(30_000); // trip INBOX_QUERY_TIMEOUT_MS
    await assertion;

    // release(err) — NOT release() — is what removes the connection from the pool instead of returning it.
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBeInstanceOf(Error);
  });

  it("returns the client CLEAN (release()) on a normal result", async () => {
    const release = vi.fn();
    connectMock.mockResolvedValue({
      query: vi.fn(async () => ({ rows: [{ ok: 1 }], rowCount: 1 })),
      release,
    });

    const res = await timedPoolQuery("SELECT 1");
    expect(res.rows).toEqual([{ ok: 1 }]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(release.mock.calls[0][0]).toBeUndefined(); // returned to the pool, not destroyed
  });
});
