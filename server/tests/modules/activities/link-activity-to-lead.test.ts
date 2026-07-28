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
  options: {
    lead?: Record<string, unknown> | null;
    /** The deal or contact the activity is anchored to — read only when the activity carries one. */
    anchor?: Record<string, unknown> | null;
    updateReturns?: unknown[];
    afterRace?: Record<string, unknown>;
  } = {},
) {
  const updates: Array<Record<string, unknown>> = [];
  /**
   * The lead is now read on EVERY call, because its liveness is checked before anything else — so the
   * default here is a live one rather than "no read at all". Passing `lead: null` still means the row
   * is gone, which is what the 404 case needs.
   */
  const lead =
    options.lead === undefined
      ? { propertyId: null, companyId: null, isActive: true, status: "open" }
      : options.lead;
  const reads: unknown[][] = [
    existing ? [existing] : [],
    lead ? [lead] : [],
    ...(options.anchor !== undefined ? [options.anchor ? [options.anchor] : []] : []),
    ...(options.afterRace ? [[options.afterRace]] : []),
  ];
  let readIndex = 0;
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({
          /**
           * Awaitable AND `.for("update")`-able, consuming the sequence exactly once either way.
           *
           * The lead read takes a row lock; the activity read does not. Returning a promise with a
           * `for` method attached models both without a second stub — and resolving `for` from the
           * already-taken rows is what stops it consuming a second entry and shifting every later read.
           */
          limit: () => {
            const rows = reads[readIndex++] ?? [];
            return Object.assign(Promise.resolve(rows), {
              for: () => Promise.resolve(rows),
            });
          },
        }),
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
    // TWO writes now: the link itself, then the lead's denormalised last-touch. Asserting the whole
    // array made the timestamp refresh read as a regression rather than the feature it is.
    expect(updates[0]).toEqual({ leadId: "l1" });
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
    expect(updates[0]).toEqual({ leadId: "l1" });
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

describe("linkActivityToLead — deal-anchored consistency", () => {
  /**
   * An activity created with ONLY a dealId carries none of the other anchors, so it skips the property
   * and company checks entirely. Without this branch it could be linked to any lead in the office —
   * the widest of the three cross-record attribution holes, and the one with no test.
   */
  it("refuses a lead whose company differs from the deal's", async () => {
    const { db, updates } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: null, dealId: "d1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cB" }, anchor: { companyId: "cA" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVITY_LEAD_COMPANY_MISMATCH" });
    expect(updates).toEqual([]);
  });

  it("allows a lead whose company matches the deal's", async () => {
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: null, dealId: "d1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cA" }, anchor: { companyId: "cA" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });

  it("allows the link when the deal has no company to contradict", async () => {
    // "Cannot disprove" semantics: a null company is not evidence of a mismatch, and refusing here
    // would block a legitimate promotion on missing data rather than on a conflict.
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: null, dealId: "d1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cB" }, anchor: { companyId: null } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });
});

describe("linkActivityToLead — contact-anchored consistency", () => {
  it("refuses a lead whose company differs from the contact's", async () => {
    const { db, updates } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: null, contactId: "ct1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cB" }, anchor: { companyId: "cA" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVITY_LEAD_COMPANY_MISMATCH" });
    expect(updates).toEqual([]);
  });

  it("allows a lead whose company matches the contact's", async () => {
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: null, contactId: "ct1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cA" }, anchor: { companyId: "cA" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });

  it("defers to the activity's OWN company rather than the contact's", async () => {
    // The contact check is guarded on `!existing.companyId`, so an activity that states its company
    // is judged on that. Dropping the guard would let a contact who has moved employers veto a link
    // the activity itself agrees with.
    // The anchor CONTRADICTS. With the guard in place the contact is never read and this link stands;
    // without it, this row is what would (wrongly) refuse — which is what makes this a real test
    // rather than one that passes because nothing was looked up.
    const { db } = stubDb(
      { id: "a1", leadId: null, propertyId: null, companyId: "cA", contactId: "ct1", responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: "cA" }, anchor: { companyId: "cZ" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });
});

describe("linkActivityToLead — an archived lead is not a target", () => {
  /**
   * Promotion is TWO calls, so this link can arrive late or be retried after its lead was archived.
   * The access check reads existence and office, not state, so the write used to land on the tombstone
   * — recording the association and refreshing last-touch on a row every active view hides.
   */
  it("refuses an archived open lead", async () => {
    const { db, updates } = stubDb(
      { id: "a1", leadId: null, responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: null, isActive: false, status: "open" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).rejects.toMatchObject({ statusCode: 409, code: "ACTIVITY_LEAD_ARCHIVED" });
    // Nothing written — not the link, and not the lead's last-touch.
    expect(updates).toEqual([]);
  });

  it("still allows a CONVERTED lead, which is inactive by design", async () => {
    // Converted and disqualified leads are also is_active = false. That is the normal end of a lead's
    // life, and its originating visit still belongs on it — refusing here would break the ordinary
    // case in the name of the exceptional one.
    const { db } = stubDb(
      { id: "a1", leadId: null, responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: null, isActive: false, status: "converted" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });

  it("still allows a DISQUALIFIED lead", async () => {
    const { db } = stubDb(
      { id: "a1", leadId: null, responsibleUserId: "u1" },
      { lead: { propertyId: null, companyId: null, isActive: false, status: "disqualified" } },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).resolves.toMatchObject({ leadId: "l1" });
  });
});

describe("linkActivityToLead — missing lead", () => {
  it("404s when the anchored lead row does not exist", async () => {
    const { db, updates } = stubDb(
      { id: "a1", leadId: null, propertyId: "p1", responsibleUserId: "u1" },
      { lead: null },
    );
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "gone", viewer: OWNER }),
    ).rejects.toMatchObject({ statusCode: 404 });
    expect(updates).toEqual([]);
  });
});

describe("linkActivityToLead — the lead's last touch", () => {
  it("refreshes the lead's lastActivityAt after linking", async () => {
    // Linking wrote only activities.lead_id, so a lead promoted FROM a site visit showed as untouched
    // on every surface that sorts or filters by last activity — the opposite of what happened.
    const occurred = new Date("2026-07-28T08:00:00Z");
    const { db, updates } = stubDb({ id: "a1", leadId: null, responsibleUserId: "u1", occurredAt: occurred });
    await linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER });
    // The VALUE is now a GREATEST(...) expression rather than a raw date, so the assertion is that the
    // column is written at all — the monotonicity itself is Postgres's job, not the stub's.
    expect(updates.some((u) => "lastActivityAt" in u)).toBe(true);
  });

  it("FAILS the link when the timestamp write fails — it cannot be best-effort", async () => {
    /**
     * The opposite of what this test asserted a commit ago, and the earlier version was wrong.
     *
     * Both writes run inside the request's transaction. A failed UPDATE aborts it at the Postgres
     * level, and catching the JavaScript error does not undo that — every later statement, including
     * the COMMIT, fails with "current transaction is aborted". Swallowing the error produced a link
     * that appeared to succeed and could never commit.
     */
    const existing = { id: "a1", leadId: null, responsibleUserId: "u1" };
    let call = 0;
    const db = {
      select: () => ({ from: () => ({ where: () => ({ limit: async () => [existing] }) }) }),
      update: () => ({
        set: (patch: Record<string, unknown>) => ({
          // The activity UPDATE ends in .returning(); the leads one is awaited straight off .where().
          // The stub has to satisfy BOTH, so where() is a thenable that also carries returning().
          where: () => {
            call += 1;
            const failing = call > 1;
            return {
              returning: async () => {
                if (failing) throw new Error("timestamp write failed");
                return [{ ...existing, ...patch }];
              },
              then: (resolve: (v: unknown) => unknown, reject: (e: unknown) => unknown) =>
                failing ? reject(new Error("timestamp write failed")) : resolve([{ ...existing, ...patch }]),
            };
          },
        }),
      }),
    } as unknown as Parameters<typeof linkActivityToLead>[0];
    await expect(
      linkActivityToLead(db, { activityId: "a1", leadId: "l1", viewer: OWNER }),
    ).rejects.toThrow();
  });
});
