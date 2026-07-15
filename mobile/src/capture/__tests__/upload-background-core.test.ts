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
    const getQueuedCount = jest.fn(async (ownerKey: string) => {
      if (ownerKey === "user:office-b") throw second;
      return 1;
    });
    const drainOwner = jest.fn(async (owner: BackgroundUploadOwner) => {
      if (owner.ownerKey === "user:office-a") throw first;
    });

    await expect(drainBackgroundOwnerQueues(owners, { getQueuedCount, drainOwner })).rejects.toBe(first);

    expect(getQueuedCount).toHaveBeenCalledTimes(3);
    expect(drainOwner.mock.calls.map(([owner]) => owner.ownerKey)).toEqual([
      "user:office-a",
      "user:office-c",
    ]);
  });

  it("skips empty queues and resolves after every successful owner", async () => {
    const getQueuedCount = jest.fn(async (ownerKey: string) => ownerKey === "user:office-b" ? 0 : 1);
    const drainOwner = jest.fn(async (_owner: BackgroundUploadOwner) => undefined);

    await expect(drainBackgroundOwnerQueues(owners, { getQueuedCount, drainOwner })).resolves.toBeUndefined();

    expect(drainOwner.mock.calls.map(([owner]) => owner.ownerKey)).toEqual([
      "user:office-a",
      "user:office-c",
    ]);
  });
});
