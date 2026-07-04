import { describe, expect, it, vi } from "vitest";

// Runtime coverage for the sales-source role gate: the source may be ANY internal CRM user (rep,
// director like Chase Kelly, admin, construction) — only external field_contractors are rejected.
// assertSalesSourceIsCrmUser is called inside setDealSalesSource right after validateAssignee, so a
// field_contractor that passes the office-access check is still rejected with 422.
//
// Hand-built fake tenantDb mirrors the shape of the real schema DDL, including:
//   deals: sales_source_user_id uuid, assigned_rep_id uuid, is_change_order boolean,
//          estimator_user_id uuid, is_active boolean, workflow_route text
//   users: id uuid, is_active boolean, office_id uuid, role user_role (pr1_rate, pr2_rate etc.
//          are commission columns on deal_signed_commissions, not queried by these guards)
//
// Commission helpers are mocked so assertions focus purely on the role gate.
vi.mock("../../../src/modules/commissions/service.js", () => ({
  mintEstimatorCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  mintSalesSourceCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeEstimatorCommissionForDeal: vi.fn().mockResolvedValue(1),
  removeSalesSourceCommissionForDeal: vi.fn().mockResolvedValue(1),
  calculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  recalculateCommissionForDeal: vi.fn().mockResolvedValue({ status: "created" }),
  removeCommissionForDeal: vi.fn().mockResolvedValue(0),
}));

import { setDealSalesSource } from "../../../src/modules/deals/service.js";

type UserRole = "admin" | "director" | "rep" | "construction" | "field_contractor";

interface FakeDeal {
  id: string;
  salesSourceUserId: string | null;
  assignedRepId: string | null;
  estimatorUserId?: string | null;
  isActive?: boolean;
  isChangeOrder?: boolean;
  workflowRoute?: string;
  officeCode?: string | null;
  [k: string]: unknown;
}

/**
 * Builds a minimal fake tenantDb where all users queries return a single canned user
 * with the supplied role. This lets us isolate the assertSalesSourceIsCrmUser gate without
 * a real database.
 */
function makeTenantDb(deal: FakeDeal, userRole: UserRole) {
  const state = {
    deal: {
      isChangeOrder: false,
      isBidBoardOwned: false,
      officeCode: null as string | null,
      isActive: true,
      estimatorUserId: null,
      ...deal,
    } as FakeDeal,
    updateCalls: [] as Array<Record<string, unknown>>,
    auditInserts: [] as Array<Record<string, unknown>>,
  };

  // Canned user: active, same office as the deal context ("o1"), with the supplied role.
  const cannedUser = [{ id: "u", isActive: true, officeId: "o1", displayName: "U", role: userRole }];

  const tenantDb: any = {
    _state: state,
    select() {
      return {
        from(table: any) {
          const tableName: string =
            (table as any)[Symbol.for("drizzle:Name")] ?? table?._.name ?? "";
          const rows = () =>
            tableName === "users"
              ? cannedUser
              : tableName === "offices"
                ? [{ id: "o1", slug: "dfw", name: "Dallas" }]
                : // No pre-existing commission row for the new source (the Finding-D guard queries this):
                  // these tests exercise the rep/non-rep gate, not the existing-row conflict.
                  tableName === "deal_signed_commissions"
                  ? []
                  : state.deal.isActive === false
                    ? []
                    : [{ ...state.deal }];
          return {
            where(_condition: unknown) {
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
          state.updateCalls.push({ ...values });
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

const OWNER = "owner-rep";
const SOURCE = "source-user";

describe("setDealSalesSource — assertSalesSourceIsCrmUser gate (runtime)", () => {
  // A field_contractor is the ONLY role rejected — they have no CRM standing / commission settings.
  it("throws 422 SALES_SOURCE_NOT_CRM_USER when the sales source user is a field contractor", async () => {
    const db = makeTenantDb(
      { id: "d", salesSourceUserId: null, assignedRepId: OWNER, workflowRoute: "service" },
      "field_contractor"
    );
    await expect(setDealSalesSource(db, "d", SOURCE, OWNER, "o1")).rejects.toMatchObject({
      statusCode: 422,
      code: "SALES_SOURCE_NOT_CRM_USER",
    });
    // No deal mutation should have occurred
    expect(db._state.updateCalls).toHaveLength(0);
  });

  // Every internal CRM role is now an allowed source — reps AND leadership (a director like Chase Kelly
  // who sources service deals), admins, and construction users.
  it.each(["rep", "director", "admin", "construction"] as const)(
    "allows a %s user to be set as the sales source",
    async (role) => {
      const db = makeTenantDb(
        { id: "d", salesSourceUserId: null, assignedRepId: OWNER, workflowRoute: "service" },
        role
      );
      const result = await setDealSalesSource(db, "d", SOURCE, OWNER, "o1");
      expect(result).toBeTruthy();
      expect(db._state.updateCalls.length).toBeGreaterThan(0);
      expect(db._state.updateCalls[0]?.salesSourceUserId).toBe(SOURCE);
    }
  );
});
