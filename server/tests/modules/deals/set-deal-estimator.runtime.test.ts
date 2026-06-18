import { beforeEach, describe, expect, it, vi } from "vitest";

// Runtime coverage (executes under `vitest run runtime.test`, i.e. check:premerge) for the two Codex
// findings on the REAL setDealEstimator:
//   FINDING 1 — office validation runs against the ACTIVE TENANT office (x-office-id, threaded as
//     officeId), NOT the deal's cosmetic project-number PREFIX, so a deal whose officeCode prefix
//     differs from its tenant still accepts a valid same-tenant estimator.
//   FINDING 2 — a soft-deleted (is_active=false) deal id supplied directly to the route returns null
//     (route 404s) before any estimator change or commission mutation.
// The commission re-attribution helpers are mocked so we can assert NO dsc mutation happens on the
// reject path; their money correctness is proven against the real schema in
// commissions/estimator-earned-commission.runtime.test.ts.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  mintEstimatorCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeEstimatorCommissionForDeal: vi.fn().mockResolvedValue(1),
  // Imported elsewhere in deals/service.ts — must exist on the mock so the module loads.
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(0),
}));

const commissions = await import("../../../src/modules/commissions/service.js");
import { getTableName } from "drizzle-orm";
import { setDealEstimator } from "../../../src/modules/deals/service.js";

// Walk a drizzle SQL/condition object to a flat string so we can assert the deal-load WHERE actually
// filters on is_active (the PRODUCTION query, not just the fake db simulating the row drop).
function extractSqlText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object") return "";
  if (Array.isArray((value as { queryChunks?: unknown[] }).queryChunks)) {
    return (value as { queryChunks: unknown[] }).queryChunks.map(extractSqlText).join("");
  }
  if ("value" in (value as Record<string, unknown>)) {
    const chunkValue = (value as { value: unknown }).value;
    if (Array.isArray(chunkValue)) return chunkValue.map(extractSqlText).join("");
    if (typeof chunkValue === "string") return chunkValue;
  }
  if ("name" in (value as Record<string, unknown>) && typeof (value as { name?: unknown }).name === "string") {
    return (value as { name: string }).name;
  }
  return "";
}

interface FakeDeal {
  id: string;
  estimatorUserId: string | null;
  assignedRepId: string | null;
  isActive?: boolean;
  isChangeOrder?: boolean;
  isBidBoardOwned?: boolean;
  officeCode?: string | null;
  [k: string]: unknown;
}

function makeTenantDb(initial: FakeDeal) {
  const state = {
    deal: {
      isChangeOrder: false,
      isBidBoardOwned: false,
      officeCode: null as string | null,
      isActive: true,
      ...initial,
    } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    auditInserts: [] as Array<Record<string, unknown>>,
    lockedSelects: 0,
    dealSelectWheres: [] as unknown[],
  };
  // validateDealReassignmentAssignee queries `users` (active target + current-owner office) and `offices`
  // — return a canned active user in a single shared office ("o1" -> DFW) so the same-office check passes.
  const cannedUser = [{ id: "u", isActive: true, officeId: "o1", displayName: "U" }];
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const name = getTableName(table);
          const isDeals = name === "deals";
          const rows = () =>
            name === "users"
              ? cannedUser
              : name === "offices"
                ? [{ id: "o1", slug: "dfw", name: "Dallas" }]
                : // A soft-deleted deal is excluded by the is_active=true filter the production query now
                  // applies — model that by returning no row.
                  state.deal.isActive === false
                  ? []
                  : [{ ...state.deal }];
          return {
            where(condition: unknown) {
              if (isDeals) state.dealSelectWheres.push(condition);
              return {
                limit() {
                  const p = Promise.resolve(rows());
                  return {
                    for() {
                      state.lockedSelects += 1;
                      return p;
                    },
                    then(onf: (v: unknown[]) => unknown) {
                      return p.then(onf);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updateCalls.push(values);
          return {
            where() {
              Object.assign(state.deal, values);
              return {
                returning() {
                  return Promise.resolve([{ ...state.deal }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values(value: Record<string, unknown>) {
          state.auditInserts.push(value);
          return Promise.resolve();
        },
      };
    },
    transaction(cb: (tx: unknown) => unknown) {
      return cb(tenantDb);
    },
  };
  return tenantDb;
}

// Office-AWARE fake: unlike makeTenantDb (which returns one canned user for every lookup), this resolves
// each `users`/`offices` row by the id embedded in the query's WHERE so the CURRENT OWNER can sit in a
// DIFFERENT office than the new estimator. It records which user ids the validation actually queried, which
// is the load-bearing proof for FINDING 1: the active-office path must NEVER consult the current owner.
function makeOfficeAwareTenantDb(opts: {
  deal: FakeDeal;
  usersById: Record<string, { id: string; isActive: boolean; officeId: string; displayName?: string }>;
  officesById: Record<string, { id: string; slug: string; name: string }>;
}) {
  const state = {
    deal: { isChangeOrder: false, officeCode: null as string | null, isActive: true, ...opts.deal } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    userIdsQueried: [] as string[],
  };
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const name = getTableName(table);
          return {
            where(condition: unknown) {
              const text = extractSqlText(condition);
              let rows: unknown[] = [];
              if (name === "deals") {
                rows = state.deal.isActive === false ? [] : [{ ...state.deal }];
              } else if (name === "users") {
                const match = Object.values(opts.usersById).find((u) => text.includes(u.id));
                if (match) state.userIdsQueried.push(match.id);
                rows = match ? [{ ...match }] : [];
              } else if (name === "offices") {
                const match = Object.values(opts.officesById).find((o) => text.includes(o.id));
                rows = match ? [{ ...match }] : [];
              }
              return {
                limit() {
                  const p = Promise.resolve(rows);
                  return {
                    for() {
                      return p;
                    },
                    then(onf: (v: unknown[]) => unknown) {
                      return p.then(onf);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updateCalls.push(values);
          return {
            where() {
              Object.assign(state.deal, values);
              return {
                returning() {
                  return Promise.resolve([{ ...state.deal }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values() {
          return Promise.resolve();
        },
      };
    },
    transaction(cb: (tx: unknown) => unknown) {
      return cb(tenantDb);
    },
  };
  return tenantDb;
}

// Grant-aware fake: the new estimator's PRIMARY users.officeId differs from the active office, but a
// user_office_access grant may bridge it. Proves validateAssignee honors held grants (the #748 multi-office
// bug class CodeRabbit flagged): a Dallas+Atlanta estimator is accepted on the active office's deal IFF a
// grant exists. The reassignment helper's primary-office-only fallback would have rejected the grant case.
function makeGrantTenantDb(opts: { estimatorOfficeId: string; grantRows: unknown[] }) {
  const state = {
    deal: {
      id: "d",
      estimatorUserId: null,
      assignedRepId: OWNER,
      isActive: true,
      isChangeOrder: false,
      isBidBoardOwned: false,
      officeCode: null as string | null,
    } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    accessQueried: false,
  };
  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const name = getTableName(table);
          const rows = () => {
            if (name === "users") {
              return [{ id: B, isActive: true, officeId: opts.estimatorOfficeId, displayName: "B" }];
            }
            if (name === "user_office_access") {
              state.accessQueried = true;
              return opts.grantRows;
            }
            if (name === "deals") {
              return state.deal.isActive === false ? [] : [{ ...state.deal }];
            }
            return [];
          };
          return {
            where() {
              return {
                limit() {
                  const p = Promise.resolve(rows());
                  return {
                    for() {
                      return p;
                    },
                    then(onf: (v: unknown[]) => unknown) {
                      return p.then(onf);
                    },
                  };
                },
              };
            },
          };
        },
      };
    },
    update() {
      return {
        set(values: Record<string, unknown>) {
          state.updateCalls.push(values);
          return {
            where() {
              Object.assign(state.deal, values);
              return {
                returning() {
                  return Promise.resolve([{ ...state.deal }]);
                },
              };
            },
          };
        },
      };
    },
    insert() {
      return {
        values() {
          return Promise.resolve();
        },
      };
    },
    transaction(cb: (tx: unknown) => unknown) {
      return cb(tenantDb);
    },
  };
  return tenantDb;
}

const OWNER = "owner-1";
const B = "est-b";

describe("setDealEstimator — Codex findings (runtime)", () => {
  beforeEach(() => {
    vi.mocked(commissions.mintEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeEstimatorCommissionForDeal).mockClear();
    vi.mocked(commissions.removeCommissionForDeal).mockClear();
  });

  // FINDING 1
  it("accepts a valid same-tenant estimator even when the deal's officeCode prefix differs from its tenant", async () => {
    // The deal's cosmetic project-number prefix is ATL, but its active tenant office (officeId 'o1' -> DFW),
    // its owner and the new estimator are all same-tenant. Pre-fix, setDealEstimator passed
    // existing.officeCode ('atl') as the dealOfficeCode, which TAKES PRECEDENCE inside
    // validateDealReassignmentAssignee and would reject with DEAL_REASSIGNMENT_OFFICE_MISMATCH. The
    // call-site fix passes null for the prefix + the active tenant officeId, so the estimator is accepted.
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: null,
      assignedRepId: OWNER,
      officeCode: "atl",
    });
    const result = await setDealEstimator(db, "d", B, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBe(B);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
  });

  // FINDING 1 (active office vs current owner's office)
  it("validates the estimator against the ACTIVE selected office, NOT the current owner's office", async () => {
    // The deal's CURRENT OWNER is in office o2 (ATL). The active selected office (x-office-id, threaded as
    // officeId) is o1 (DFW). The new estimator B is in o1. Passing NO current owner means
    // validateDealReassignmentAssignee validates B against the ACTIVE office (o1) and ACCEPTS it.
    //
    // This FAILS under the old `validateDealReassignmentAssignee(tx, newEstimator, null, owner, officeId)`
    // call: with the owner passed, the helper looks up the OWNER row, OVERRIDES dealOfficeId with the owner's
    // office (o2), and rejects B (in o1) with DEAL_REASSIGNMENT_OFFICE_MISMATCH — so both the acceptance
    // assertion and the "owner never queried" assertion below regress if the owner arg is reintroduced.
    const db = makeOfficeAwareTenantDb({
      deal: { id: "d", estimatorUserId: null, assignedRepId: OWNER, officeCode: null },
      usersById: {
        [OWNER]: { id: OWNER, isActive: true, officeId: "o2" }, // current owner — DIFFERENT office
        [B]: { id: B, isActive: true, officeId: "o1" }, // new estimator — in the ACTIVE office
      },
      officesById: {
        o1: { id: "o1", slug: "dfw", name: "Dallas" },
        o2: { id: "o2", slug: "atl", name: "Atlanta" },
      },
    });

    const result = await setDealEstimator(db, "d", B, OWNER, "o1");

    expect(result).toBeTruthy();
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBe(B);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
    // PROOF the ACTIVE office (not the owner's) drove validation: only the estimator row was looked up; the
    // current OWNER row was NEVER queried. The old (…, owner, …) call would have queried the owner for its
    // office, so this assertion is the regression guard for the call-site fix.
    expect(db._state.userIdsQueried).toContain(B);
    expect(db._state.userIdsQueried).not.toContain(OWNER);
  });

  // #748 bug class (CodeRabbit): the estimator office check must honor user_office_access grants. A
  // multi-office estimator whose PRIMARY office (o2/ATL) differs from the active office (o1/DFW) but who
  // HOLDS a grant to o1 is ACCEPTED — validateAssignee consults user_office_access, unlike the reassignment
  // helper's primary-officeId-only fallback that would have rejected the pick.
  it("accepts a multi-office estimator who reaches the active office via a user_office_access grant", async () => {
    const db = makeGrantTenantDb({
      estimatorOfficeId: "o2", // primary office differs from the active office o1
      grantRows: [{ id: "grant-1", userId: B, officeId: "o1" }], // but holds a grant to o1
    });
    const result = await setDealEstimator(db, "d", B, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBe(B);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    // The grant table was actually consulted (proves the primary-office mismatch fell through to the grant check).
    expect(db._state.accessQueried).toBe(true);
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
  });

  // Counter-direction: same primary-office mismatch but NO grant → rejected (400), no estimator change, no dsc.
  it("rejects an estimator whose primary office differs and who has no grant to the active office", async () => {
    const db = makeGrantTenantDb({ estimatorOfficeId: "o2", grantRows: [] });
    await expect(setDealEstimator(db, "d", B, OWNER, "o1")).rejects.toMatchObject({ statusCode: 400 });
    expect(db._state.accessQueried).toBe(true);
    expect(db._state.updateCalls).toHaveLength(0);
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });

  // FINDING 2
  it("returns null for a soft-deleted (is_active=false) deal — no estimator change, no commission mutation", async () => {
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: null,
      assignedRepId: OWNER,
      isActive: false,
    });
    const result = await setDealEstimator(db, "d", B, OWNER, "o1");
    // The deal load filters on is_active=true, so a soft-deleted deal returns null (the route 404s).
    expect(result).toBeNull();
    // The FOR UPDATE lock was still taken before deciding the deal is gone.
    expect(db._state.lockedSelects).toBe(1);
    // estimator_user_id is untouched and NO dsc mutation fired.
    expect(db._state.updateCalls).toHaveLength(0);
    expect(db._state.auditInserts).toHaveLength(0);
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
    // The production deal-load WHERE actually carries the is_active filter (not just the fake simulating it).
    const dealWhereSql = db._state.dealSelectWheres.map(extractSqlText).join("\n");
    expect(dealWhereSql).toContain("is_active");
  });

  // P1 — Bid-Board-owned estimator policy, NARROWED to FIRST-FILL only.
  // The Bid Board sync OWNS the initial estimator; #741 made that sync empties-only, so it can never
  // clobber a human-set non-null value. So the lock blocks ONLY the first fill (existing estimator null),
  // and humans may CORRECT or CLEAR an already-set estimator.

  // Block: a FIRST-FILL on a BB-owned deal (no existing estimator) is reserved for the sync.
  it("blocks the FIRST FILL on a Bid-Board-owned deal (null estimator) with 409 — no change, no dsc mutation", async () => {
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: null, // no estimator yet → the sync owns this initial fill
      assignedRepId: OWNER,
      isBidBoardOwned: true,
    });
    await expect(setDealEstimator(db, "d", B, OWNER, "o1")).rejects.toMatchObject({
      statusCode: 409,
      code: "BID_BOARD_OWNED_ESTIMATOR_LOCKED",
    });
    // The FOR UPDATE lock was taken before the guard fired.
    expect(db._state.lockedSelects).toBe(1);
    // estimator_user_id is untouched and NO dsc mutation fired.
    expect(db._state.updateCalls).toHaveLength(0);
    expect(db._state.deal.estimatorUserId).toBeNull();
    expect(db._state.auditInserts).toHaveLength(0);
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeEstimatorCommissionForDeal).not.toHaveBeenCalled();
    expect(commissions.removeCommissionForDeal).not.toHaveBeenCalled();
  });

  // Allow: a CORRECTION on a BB-owned deal (an estimator is already set) — the human-owned path. #741
  // guarantees the empties-only sync won't revert the corrected non-null value, so the dsc row stays
  // consistent. The dsc is re-attributed from the old estimator to the new one.
  it("ALLOWS a correction on a Bid-Board-owned deal (existing non-null estimator) and re-attributes the dsc", async () => {
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: "est-existing", // already set → human may correct it
      assignedRepId: OWNER,
      isBidBoardOwned: true,
    });
    const result = await setDealEstimator(db, "d", B, OWNER, "o1");
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBe(B);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    // Departing estimator's scoped row removed, new estimator minted.
    expect(commissions.removeEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: "est-existing" }),
    );
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
  });

  // Allow: CLEARING an already-set estimator on a BB-owned deal (non-null → null) — the existing value is
  // non-null, so it's not a first fill. The departing estimator's dsc row is removed; nothing is minted.
  it("ALLOWS clearing an existing estimator on a Bid-Board-owned deal (non-null → null)", async () => {
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: "est-existing",
      assignedRepId: OWNER,
      isBidBoardOwned: true,
    });
    const result = await setDealEstimator(db, "d", null, OWNER, "o1");
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBeNull();
    expect(db._state.updateCalls[0]?.estimatorUserId).toBeNull();
    expect(commissions.removeEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: "est-existing" }),
    );
    expect(commissions.mintEstimatorCommissionForDeal).not.toHaveBeenCalled();
  });

  // P1 — regression: a NON-Bid-Board deal still accepts the estimator edit (the guard is scoped).
  it("still accepts the estimator edit on a non-Bid-Board deal (regression)", async () => {
    const db = makeTenantDb({
      id: "d",
      estimatorUserId: null,
      assignedRepId: OWNER,
      isBidBoardOwned: false,
    });
    const result = await setDealEstimator(db, "d", B, OWNER, "o1");
    expect(result).toBeTruthy();
    expect((result as { estimatorUserId?: string | null }).estimatorUserId).toBe(B);
    expect(db._state.updateCalls[0]?.estimatorUserId).toBe(B);
    expect(commissions.mintEstimatorCommissionForDeal).toHaveBeenCalledWith(
      db,
      expect.objectContaining({ dealId: "d", estimatorUserId: B }),
    );
  });
});
