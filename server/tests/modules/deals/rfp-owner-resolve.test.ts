import { describe, expect, it } from "vitest";
import { resolveDealOwner } from "../../../src/modules/deals/rfp-enqueue.js";

/**
 * Minimal drizzle-shaped fake: each `.select(...).from(...).where(...).limit(n)` chain
 * resolves to the next queued result, in the order resolveDealOwner issues lookups.
 */
function fakeTenantDb(resultsInCallOrder: Array<any[]>) {
  let call = 0;
  const calls: number[] = [];
  const chain: any = {
    select: () => chain,
    from: () => chain,
    where: () => chain,
    limit: () => {
      calls.push(call);
      return Promise.resolve(resultsInCallOrder[call++] ?? []);
    },
  };
  return { db: chain, lookupCount: () => call };
}

const deal = (over: Record<string, any> = {}) =>
  ({ assignedRepId: null, hubspotOwnerEmail: null, createdByUserId: null, ...over }) as any;

describe("resolveDealOwner — Requested-by priority", () => {
  it("prefers the assigned rep (name from displayName + email)", async () => {
    const { db, lookupCount } = fakeTenantDb([
      [{ email: "rep@trockgc.com", displayName: "Rep One", firstName: "Rep", lastName: "One" }],
    ]);
    const owner = await resolveDealOwner(db, deal({ assignedRepId: "rep-1", hubspotOwnerEmail: "hs@x.com" }));
    expect(owner).toEqual({ ownerName: "Rep One", ownerEmail: "rep@trockgc.com" });
    expect(lookupCount()).toBe(1); // short-circuits; no creator lookup
  });

  it("builds the rep name from first+last when displayName is blank", async () => {
    const { db } = fakeTenantDb([
      [{ email: "rep@trockgc.com", displayName: "  ", firstName: "Casey", lastName: "Rep" }],
    ]);
    const owner = await resolveDealOwner(db, deal({ assignedRepId: "rep-2" }));
    expect(owner).toEqual({ ownerName: "Casey Rep", ownerEmail: "rep@trockgc.com" });
  });

  it("falls back to hubspot_owner_email when there is no assigned rep", async () => {
    const { db, lookupCount } = fakeTenantDb([]); // no rep lookup (assignedRepId null)
    const owner = await resolveDealOwner(db, deal({ hubspotOwnerEmail: "owner@hubspot.com" }));
    expect(owner).toEqual({ ownerName: null, ownerEmail: "owner@hubspot.com" });
    expect(lookupCount()).toBe(0);
  });

  it("falls back to the deal creator when rep and hubspot owner are both absent", async () => {
    const { db } = fakeTenantDb([
      [{ email: "creator@trockgc.com", displayName: "Dana Creator", firstName: null, lastName: null }],
    ]);
    const owner = await resolveDealOwner(db, deal({ createdByUserId: "creator-1" }));
    expect(owner).toEqual({ ownerName: "Dana Creator", ownerEmail: "creator@trockgc.com" });
  });

  it("returns null fields when nothing resolves (SyncHub renders —)", async () => {
    const { db } = fakeTenantDb([]);
    const owner = await resolveDealOwner(db, deal());
    expect(owner).toEqual({ ownerName: null, ownerEmail: null });
  });

  it("skips an assigned rep that no longer exists and falls through", async () => {
    const { db } = fakeTenantDb([[]]); // rep lookup returns no row
    const owner = await resolveDealOwner(db, deal({ assignedRepId: "ghost", hubspotOwnerEmail: "h@x.com" }));
    expect(owner).toEqual({ ownerName: null, ownerEmail: "h@x.com" });
  });
});
