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
  officeCode?: string | null;
  [k: string]: unknown;
}

function makeTenantDb(initial: FakeDeal) {
  const state = {
    deal: { isChangeOrder: false, officeCode: null as string | null, isActive: true, ...initial } as FakeDeal,
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
});
