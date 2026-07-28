import { describe, expect, it, vi } from "vitest";
import { linkActivityToLead } from "../../../src/modules/activities/service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

/**
 * Linking a captured visit to the lead it became.
 *
 * The interesting behaviour is entirely in the conflict rules, so this exercises them against a stub
 * rather than a database: what happens on a retry, and what happens when an activity already belongs to
 * a different lead. Both are cases a field app WILL hit — a dropped response on a truck's connection is
 * the normal case, not the edge one.
 */
function stubDb(existing: Record<string, unknown> | undefined) {
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (existing ? [existing] : []) }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          where: () => ({
            returning: async () => [{ ...existing, ...patch }],
          }),
        };
      },
    }),
  } as unknown as Parameters<typeof linkActivityToLead>[0];
  return { db, updates };
}

describe("linkActivityToLead", () => {
  it("writes the lead id onto an unlinked activity", async () => {
    const { db, updates } = stubDb({ id: "a1", leadId: null });
    const result = await linkActivityToLead(db, { activityId: "a1", leadId: "l1" });
    expect(updates).toEqual([{ leadId: "l1" }]);
    expect(result).toMatchObject({ id: "a1", leadId: "l1" });
  });

  it("is idempotent for the SAME lead — a retry is a success, not an error", async () => {
    // The client makes two calls (create the lead, then link it) and the second can be retried after a
    // dropped response. Treating that as a failure would show a rep an error for work that succeeded.
    const { db, updates } = stubDb({ id: "a1", leadId: "l1" });
    const result = await linkActivityToLead(db, { activityId: "a1", leadId: "l1" });
    expect(updates).toEqual([]);
    expect(result).toMatchObject({ leadId: "l1" });
  });

  it("refuses to repoint an activity at a DIFFERENT lead", async () => {
    // Silently repointing would move a visit's history off the lead it created and onto another one —
    // invisible, and it rewrites the origin of both.
    const { db } = stubDb({ id: "a1", leadId: "l1" });
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l2" })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACTIVITY_LEAD_CONFLICT",
    });
  });

  it("404s for an activity that does not exist", async () => {
    const { db } = stubDb(undefined);
    await expect(linkActivityToLead(db, { activityId: "nope", leadId: "l1" })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it.each([
    ["a missing activity id", { activityId: "", leadId: "l1" }],
    ["a missing lead id", { activityId: "a1", leadId: "" }],
  ])("rejects %s before touching the database", async (_label, input) => {
    const select = vi.fn();
    const db = { select } as unknown as Parameters<typeof linkActivityToLead>[0];
    await expect(linkActivityToLead(db, input)).rejects.toBeInstanceOf(AppError);
    expect(select).not.toHaveBeenCalled();
  });
});
