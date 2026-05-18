import { describe, expect, it } from "vitest";

const { getEmails } = await import("../../../src/modules/email/service.js");

function flattenQueryChunks(input: unknown, seen = new WeakSet<object>()): unknown[] {
  if (!input || typeof input !== "object") return [input];
  if (seen.has(input as object)) return [];
  seen.add(input as object);

  const queryChunks = (input as { queryChunks?: unknown[] }).queryChunks;
  if (Array.isArray(queryChunks)) {
    return queryChunks.flatMap((chunk) => flattenQueryChunks(chunk, seen));
  }

  if ("value" in (input as Record<string, unknown>)) {
    return [(input as Record<string, unknown>).value];
  }

  return Object.values(input as Record<string, unknown>).flatMap((value) => flattenQueryChunks(value, seen));
}

function createCapturedEmailDb() {
  const capturedWhere: unknown[] = [];

  function createChain(rows: any[]) {
    const chain: Record<string, any> = {
      from: () => chain,
      where: (condition: unknown) => {
        capturedWhere.push(condition);
        return chain;
      },
      orderBy: () => chain,
      limit: () => chain,
      offset: () => chain,
      then: (onFulfilled: (value: any[]) => unknown, onRejected?: (reason: unknown) => unknown) =>
        Promise.resolve(rows).then(onFulfilled, onRejected),
    };
    return chain;
  }

  return {
    db: {
      select: (selection?: Record<string, unknown>) => {
        const rows = selection && "count" in selection ? [{ count: 0 }] : [];
        return createChain(rows);
      },
    },
    getCapturedWhere: () => capturedWhere,
  };
}

describe("deal email visibility", () => {
  it("keeps deal email history mailbox-scoped for reps who can view the deal", async () => {
    const { db, getCapturedWhere } = createCapturedEmailDb();

    await getEmails(db as any, { dealId: "deal-1" }, "rep-1", "rep");

    const flattened = getCapturedWhere().flatMap((condition) => flattenQueryChunks(condition));
    expect(flattened).toContain("deal-1");
    expect(flattened).toContain("rep-1");
  });

  it("keeps the personal inbox path mailbox-scoped", async () => {
    const { db, getCapturedWhere } = createCapturedEmailDb();

    await getEmails(db as any, {}, "rep-1", "rep");

    const flattened = getCapturedWhere().flatMap((condition) => flattenQueryChunks(condition));
    expect(flattened).toContain("rep-1");
  });
});
