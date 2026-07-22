import { drainBackgroundOwnerQueues, type BackgroundUploadOwner } from "../upload-background-core";

const owners: BackgroundUploadOwner[] = [
  { ownerKey: "user:office-a", officeId: "office-a" },
  { ownerKey: "user:office-b", officeId: "office-b" },
  { ownerKey: "user:office-c", officeId: "office-c" },
];

describe("drainBackgroundOwnerQueues", () => {
  it("continues after owner failures, then rethrows the first error", async () => {
    const first = new Error("office a unavailable");
    const second = new Error("office b index unreadable");
    const getSchedulableCount = jest.fn(async (ownerKey: string) => {
      if (ownerKey === "user:office-b") throw second;
      return 1;
    });
    const drainOwner = jest.fn(async (owner: BackgroundUploadOwner) => {
      if (owner.ownerKey === "user:office-a") throw first;
    });

    await expect(drainBackgroundOwnerQueues(owners, { getSchedulableCount, drainOwner })).rejects.toBe(first);

    expect(getSchedulableCount).toHaveBeenCalledTimes(3);
    expect(drainOwner.mock.calls.map(([owner]) => owner.ownerKey)).toEqual([
      "user:office-a",
      "user:office-c",
    ]);
  });

  it("skips empty queues and resolves after every successful owner", async () => {
    const getSchedulableCount = jest.fn(async (ownerKey: string) => ownerKey === "user:office-b" ? 0 : 1);
    const drainOwner = jest.fn(async (_owner: BackgroundUploadOwner) => undefined);

    await expect(drainBackgroundOwnerQueues(owners, { getSchedulableCount, drainOwner })).resolves.toBeUndefined();

    expect(drainOwner.mock.calls.map(([owner]) => owner.ownerKey)).toEqual([
      "user:office-a",
      "user:office-c",
    ]);
  });

  it("drains an owner whose only rows are mid-enqueue staging (schedulable > 0, drainable would be 0)", async () => {
    // A lone capture interrupted mid-enqueue leaves a `staging` row: 0 DRAINABLE but 1 SCHEDULABLE. Gating on
    // the schedulable count (not drainable-only) is what lets the drain run to reconcile + ship it — the whole
    // point of finding 2. Simulate that owner reporting 1 schedulable row.
    const getSchedulableCount = jest.fn(async (ownerKey: string) => (ownerKey === "user:office-b" ? 1 : 0));
    const drainOwner = jest.fn(async (_owner: BackgroundUploadOwner) => undefined);

    await expect(drainBackgroundOwnerQueues(owners, { getSchedulableCount, drainOwner })).resolves.toBeUndefined();

    // Only office-b (the staging-only owner) is drained; the truly-empty owners are skipped.
    expect(drainOwner.mock.calls.map(([owner]) => owner.ownerKey)).toEqual(["user:office-b"]);
  });
});
