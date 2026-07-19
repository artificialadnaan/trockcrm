import { beforeEach, describe, expect, it, vi } from "vitest";

// The heavy lifting (inbox state machine, per-office serialization, recovery SQL) lives in the SERVER
// workspace and is exhaustively covered by server/tests/modules/bid-board-sync/inbox.runtime.test.ts (which
// runs in the CI gate). This file smoke-tests the thin worker WRAPPER's guard so a malformed job can't blow
// up the poller. (Worker tests are local-only per the repo convention; the wrapper is also compile-checked
// by `npm run build`.)

const connectMock = vi.hoisted(() => vi.fn());
vi.mock("../src/db.js", () => ({ pool: { connect: connectMock } }));

const { handleBidBoardIngestJob } = await import("../src/jobs/bid-board-ingest.js");

describe("handleBidBoardIngestJob (worker wrapper guard)", () => {
  beforeEach(() => vi.clearAllMocks());

  it("no-ops on a job missing inboxId without touching the DB or importing the server module", async () => {
    await expect(handleBidBoardIngestJob({}, null)).resolves.toBeUndefined();
    await expect(handleBidBoardIngestJob(null, null)).resolves.toBeUndefined();
    expect(connectMock).not.toHaveBeenCalled();
  });
});
