import { DRAIN_BACKLOG_SHARE, planDrainOrder, type QueuedUpload } from "../upload-queue-core";

/**
 * planDrainOrder decides WHICH queued photo ships next. It replaced strict queue order (FIFO), which on
 * real hardware left a superintendent permanently a day behind: on Sep 10 his phone uploaded 248 photos
 * and all 248 were Sep 9's, so the day's own work never arrived on the day it was needed.
 *
 * Two properties matter and they pull against each other:
 *   1. the NEWEST work goes first, because that is what someone is waiting to see; and
 *   2. the oldest work still ships, because a pure LIFO can starve photos the crew already believes are
 *      uploaded.
 * Plus one invariant the caller depends on: the result is a PERMUTATION. drainUploadQueue chunks the plan
 * and counts attempts per item, so a plan that dropped or duplicated an id would silently lose a photo or
 * burn two attempts on one.
 */

function at(clientUploadId: string, enqueuedAt: number): QueuedUpload {
  return {
    clientUploadId,
    uri: `file://${clientUploadId}.jpg`,
    target: {},
    category: null,
    caption: null,
    tags: [],
    metadata: {},
    enqueuedAt,
    attempts: 0,
  } as QueuedUpload;
}

/** Oldest..newest, one per minute, so index order == age order. */
function ladder(count: number): QueuedUpload[] {
  return Array.from({ length: count }, (_, i) => at(`p${String(i).padStart(2, "0")}`, i * 60_000));
}

const ids = (items: QueuedUpload[]) => items.map((i) => i.clientUploadId);

describe("planDrainOrder", () => {
  // THE load-bearing test. planDrainOrder walks two pointers toward each other and relies on an
  // invariant — one pointer advances per slot, so they meet exactly as the plan fills — rather than on a
  // bounds check. If that invariant is ever broken, the symptom is a plan that emits one photo twice and
  // another never: the drain would burn two attempts on one item and silently never ship the other.
  // Nothing else in the queue would notice. So the property is swept exhaustively over every size and
  // share combination the function can see, not spot-checked at the default.
  it("is a permutation for every size x backlogShare: same members, no duplicates, none dropped", () => {
    const sizes = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 13, 17, 40, 110, 267, 408];
    // Failures are collected rather than asserted in the loop so the message names the exact
    // size/share that broke, instead of jest reporting "expected 40 to be 41" with no coordinates.
    const broken: string[] = [];
    for (const size of sizes) {
      for (const backlogShare of [2, 3, 4, 5, 6]) {
        const input = ladder(size);
        const plan = planDrainOrder(input, { backlogShare });
        const planned = ids(plan);
        const problems: string[] = [];
        if (planned.length !== size) problems.push(`length ${planned.length} != ${size}`);
        if (new Set(planned).size !== planned.length) {
          const dupes = planned.filter((id, i) => planned.indexOf(id) !== i);
          problems.push(`duplicated ${[...new Set(dupes)].join(",")}`);
        }
        const missing = ids(input).filter((id) => !planned.includes(id));
        if (missing.length > 0) problems.push(`dropped ${missing.join(",")}`);
        if (problems.length > 0) broken.push(`size=${size} share=${backlogShare}: ${problems.join("; ")}`);
      }
    }
    expect(broken).toEqual([]);
  });

  it("ships the newest capture first", () => {
    const plan = planDrainOrder(ladder(20));
    expect(plan[0].clientUploadId).toBe("p19");
  });

  it("gives the majority of slots to the newest work and a reserved share to the backlog", () => {
    // 40 items, share 4 → every 4th slot is backlog. Over the first 12 slots that is exactly 3.
    const plan = planDrainOrder(ladder(40));
    const firstTwelve = ids(plan).slice(0, 12);
    // Newest-first work is p39 downward; backlog picks come off p00 upward.
    const backlogPicks = firstTwelve.filter((id) => id <= "p09");
    expect(backlogPicks).toEqual(["p00", "p01", "p02"]);
    expect(firstTwelve.filter((id) => id >= "p30")).toHaveLength(9);
  });

  it("does not starve the oldest item — it ships within the first backlogShare slots", () => {
    const plan = planDrainOrder(ladder(267));
    const oldestPosition = ids(plan).indexOf("p00");
    expect(oldestPosition).toBeGreaterThan(0); // not first: newest work leads
    expect(oldestPosition).toBeLessThan(DRAIN_BACKLOG_SHARE); // but immediately after
  });

  it("delivers a whole day of captures before the previous day's backlog is finished", () => {
    // The exact shape that produced the report: 248 already-queued photos from yesterday, then today's
    // 267 queued on top. Under FIFO none of today's 267 would appear until all 248 had gone.
    const yesterday = Array.from({ length: 248 }, (_, i) => at(`old${String(i).padStart(3, "0")}`, i));
    const today = Array.from({ length: 267 }, (_, i) => at(`new${String(i).padStart(3, "0")}`, 1_000_000 + i));
    const plan = ids(planDrainOrder([...yesterday, ...today]));

    // Take the throughput one bad hour actually delivered (110 photos) and ask what the crew would see.
    const firstHour = plan.slice(0, 110);
    const todaysInFirstHour = firstHour.filter((id) => id.startsWith("new")).length;
    expect(todaysInFirstHour).toBe(83); // 3 of every 4 slots
    // And the backlog is genuinely progressing rather than parked.
    expect(firstHour.filter((id) => id.startsWith("old")).length).toBe(27);
  });

  it("emits every item exactly once even when the backlog and the new work meet in the middle", () => {
    // Odd sizes around the share boundary are where a two-pointer walk would double-emit or drop.
    for (const size of [3, 4, 5, 6, 7, 8]) {
      const plan = planDrainOrder(ladder(size));
      expect(new Set(ids(plan)).size).toBe(size);
      expect(plan).toHaveLength(size);
    }
  });

  it("breaks enqueuedAt ties deterministically so a given queue always plans the same way", () => {
    const tied = [at("c", 500), at("a", 500), at("b", 500)];
    expect(ids(planDrainOrder(tied))).toEqual(ids(planDrainOrder([...tied].reverse())));
  });

  it("degenerates to strict oldest-first when the caller asks for a share below 2", () => {
    // share 1 would mean "every slot is backlog"; that is FIFO, and it should behave as FIFO rather than
    // as a modulo that reorders unpredictably.
    expect(ids(planDrainOrder(ladder(5), { backlogShare: 1 }))).toEqual(["p00", "p01", "p02", "p03", "p04"]);
  });

  it("handles the trivial sizes without reordering or throwing", () => {
    expect(planDrainOrder([])).toEqual([]);
    expect(ids(planDrainOrder([at("solo", 1)]))).toEqual(["solo"]);
  });

  it("does not mutate the caller's array", () => {
    const input = ladder(10);
    const before = ids(input);
    planDrainOrder(input);
    expect(ids(input)).toEqual(before);
  });
});
