import { runConcurrentUploads } from "../concurrency";

describe("runConcurrentUploads", () => {
  it("processes every item and preserves input order in results", async () => {
    const results = await runConcurrentUploads([1, 2, 3, 4, 5], 2, async (n) => n * 2);
    const values = results.map((r) => (r.status === "fulfilled" ? r.value : null));
    expect(values).toEqual([2, 4, 6, 8, 10]);
  });

  it("captures individual rejections without failing the whole batch", async () => {
    const results = await runConcurrentUploads([1, 2, 3], 3, async (n) => {
      if (n === 2) throw new Error("boom");
      return n;
    });
    expect(results[0].status).toBe("fulfilled");
    expect(results[1].status).toBe("rejected");
    expect(results[2].status).toBe("fulfilled");
  });

  it("never runs more than `concurrency` workers at once", async () => {
    let active = 0;
    let maxActive = 0;
    const work = async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((r) => setTimeout(r, 5));
      active -= 1;
      return 1;
    };
    await runConcurrentUploads([1, 2, 3, 4, 5, 6], 2, work);
    expect(maxActive).toBeLessThanOrEqual(2);
  });
});
