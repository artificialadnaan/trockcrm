import { describe, expect, it, vi } from "vitest";
import { linkActivityToLead } from "../../../src/modules/activities/service.js";
import { AppError } from "../../../src/middleware/error-handler.js";

/** The rep who logged the visit — the only person allowed to link it, plus admins/directors. */
const OWNER = { id: "u1", role: "rep" };

/**
 * Linking a captured visit to the lead it became.
 *
 * The interesting behaviour is entirely in the conflict rules, so this exercises them against a stub
 * rather than a database: what happens on a retry, and what happens when an activity already belongs to
 * a different lead. Both are cases a field app WILL hit — a dropped response on a truck's connection is
 * the normal case, not the edge one.
 */
/**
 * `rows` is consumed in order, so a test can describe a SEQUENCE of reads — which is what the
 * lost-race path needs: the first read sees an unlinked activity, the conditional update returns
 * nothing, and the re-read shows who won.
 */
function stubDb(
  existing: Record<string, unknown> | undefined,
  options: { lead?: Record<string, unknown> | null; updateReturns?: unknown[]; afterRace?: Record<string, unknown> } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  const reads: unknown[][] = [
    existing ? [existing] : [],
    ...(options.lead !== undefined ? [options.lead ? [options.lead] : []] : []),
    ...(options.afterRace ? [[options.afterRace]] : []),
  ];
  let readIndex = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => reads[readIndex++] ?? [] }),
      }),
    }),
    update: () => ({
      set: (patch: Record<string, unknown>) => {
        updates.push(patch);
        return {
          where: () => ({
            returning: async () =>
              options.updateReturns ?? [{ ...existing, ...patch }],
          }),
        };
      },
    }),
  } as unknown as Parameters<typeof linkActivityToLead>[0];
  return { db, updates };
}

describe("linkActivityToLead", () => {
  it("writes the lead id onto an unlinked activity", async () => {
    const { db, updates } = stubDb({ id: "a1", leadId: null, responsibleUserId: "u1" });
    const result = await linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER });
    expect(updates).toEqual([{ leadId: "l1" }]);
    expect(result).toMatchObject({ id: "a1", leadId: "l1", responsibleUserId: "u1" });
  });

  it("is idempotent for the SAME lead — a retry is a success, not an error", async () => {
    // The client makes two calls (create the lead, then link it) and the second can be retried after a
    // dropped response. Treating that as a failure would show a rep an error for work that succeeded.
    const { db, updates } = stubDb({ id: "a1", leadId: "l1", responsibleUserId: "u1" });
    const result = await linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER });
    expect(updates).toEqual([]);
    expect(result).toMatchObject({ leadId: "l1" });
  });

  it("refuses to repoint an activity at a DIFFERENT lead", async () => {
    // Silently repointing would move a visit's history off the lead it created and onto another one —
    // invisible, and it rewrites the origin of both.
    const { db } = stubDb({ id: "a1", leadId: "l1", responsibleUserId: "u1" });
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l2", viewer: OWNER })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACTIVITY_LEAD_CONFLICT",
    });
  });

  it("404s for an activity that does not exist", async () => {
    const { db } = stubDb(undefined);
    await expect(linkActivityToLead(db, { activityId: "nope", leadId: "l1", viewer: OWNER })).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it.each([
    ["a missing activity id", { activityId: "", leadId: "l1" }],
    ["a missing lead id", { activityId: "a1", leadId: "" }],
  ])("rejects %s before touching the database", async (_label, input) => {
    const select = vi.fn();
    const db = { select } as unknown as Parameters<typeof linkActivityToLead>[0];
    await expect(linkActivityToLead(db, { ...input, viewer: OWNER })).rejects.toBeInstanceOf(AppError);
    expect(select).not.toHaveBeenCalled();
  });
});

describe("linkActivityToLead — concurrency and consistency", () => {
  it("loses a race safely: a concurrent link to the SAME lead is still a success", async () => {
    // Two promotions both read leadId as null; the conditional UPDATE matches zero rows for the loser.
    // Re-reading is what lets it answer with the same rules rather than reporting a false conflict.
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, responsibleUserId: "u1" },
      { updateReturns: [], afterRace: { id: "a1", leadId: "l1", responsibleUserId: "u1" } },
    );
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER })).resolves.toMatchObject({
      leadId: "l1",
    });
  });

  it("loses a race to a DIFFERENT lead and reports the conflict", async () => {
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, responsibleUserId: "u1" },
      { updateReturns: [], afterRace: { id: "a1", leadId: "l2" } },
    );
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACTIVITY_LEAD_CONFLICT",
    });
  });

  it("refuses a lead for a different property than the visit", async () => {
    // Nothing else checked it: a caller with access to any lead could attach a visit at one building
    // to a lead at another, and the visit would then read as that lead's origin.
    const { db } = stubDb({ id: "a1", leadId: null, propertyId: "p1", responsibleUserId: "u1" }, { lead: { propertyId: "p2" } });
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER })).rejects.toMatchObject({
      statusCode: 409,
      code: "ACTIVITY_LEAD_PROPERTY_MISMATCH",
    });
  });

  it("allows a lead for the SAME property", async () => {
    const { db, updates } = stubDb({ id: "a1", leadId: null, propertyId: "p1", responsibleUserId: "u1" }, { lead: { propertyId: "p1" } });
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER })).resolves.toMatchObject({
      leadId: "l1",
    });
    expect(updates).toEqual([{ leadId: "l1" }]);
  });

  it("skips the property check for a company-anchored capture", async () => {
    // A visit logged against a company legitimately has no property; requiring one would block exactly
    // the fallback path added for buildings the CRM has never seen.
    const { db } = stubDb({ id: "a1", leadId: null, propertyId: null, responsibleUserId: "u1" });
    await expect(linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER })).resolves.toMatchObject({
      leadId: "l1",
    });
  });
});

describe("linkActivityToLead — authorisation", () => {
  /**
   * The route checks access to the target LEAD. That is not access to the ACTIVITY.
   *
   * Without this, a caller could pass any activity id — including another rep's — and receive the row.
   * getActivities deliberately hides email activities from everyone but their responsible user,
   * because those rows carry the subject and up to 1000 characters of body, so routing around that
   * filter turned a linking endpoint into a mailbox read.
   */
  it("refuses another rep's activity, and does not confirm it exists", async () => {
    const { db, updates } = stubDb({ id: "a1", leadId: null, responsibleUserId: "someone-else" });
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: { id: "u1", role: "rep" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(updates).toEqual([]);
  });

  it("allows the rep who performed it, not only the responsible user", async () => {
    const { db } = stubDb({ id: "a1", leadId: null, responsibleUserId: "other", performedByUserId: "u1" });
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: { id: "u1", role: "rep" } }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });

  it("lets an admin link someone else's non-email activity", async () => {
    const { db } = stubDb({ id: "a1", leadId: null, responsibleUserId: "other", type: "site_visit" });
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: { id: "u1", role: "admin" } }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });

  it("does NOT let an admin reach someone else's EMAIL activity", async () => {
    // The mailbox filter is owner-only for a reason — privilege elsewhere is not a mailbox grant.
    const { db } = stubDb({ id: "a1", leadId: null, responsibleUserId: "other", type: "email" });
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: { id: "u1", role: "admin" } }),
    ).rejects.toMatchObject({ statusCode: 404 });
  });
});

describe("linkActivityToLead — company-anchored consistency", () => {
  it("refuses a lead for a different company", async () => {
    // The fallback path has no property, and skipping validation there let an activity for Company A
    // become the origin of Company B's lead — the same cross-record attribution the property check
    // exists to stop, on the path that is used more often.
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: "cA", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cB" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVITY_LEAD_COMPANY_MISMATCH" });
  });

  it("allows a lead for the same company", async () => {
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: "cA", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cA" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });
});
