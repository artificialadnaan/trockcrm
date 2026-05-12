import { describe, expect, it } from "vitest";
import {
  buildTenantActivePlan,
  deriveIsActiveFromSnapshot,
  parseActiveBackfillArgs,
  type CandidateRow,
} from "../../../scripts/backfill-projects-active-flag.js";
import { deriveIsActive } from "../../src/modules/projects/service.js";

describe("deriveIsActiveFromSnapshot", () => {
  it("returns null when snapshot is missing", () => {
    expect(deriveIsActiveFromSnapshot(null)).toBeNull();
    expect(deriveIsActiveFromSnapshot(undefined)).toBeNull();
  });

  it("returns null when snapshot has neither active nor status_name", () => {
    expect(deriveIsActiveFromSnapshot({ name: "X" })).toBeNull();
  });

  it("prefers snapshot.active boolean", () => {
    expect(deriveIsActiveFromSnapshot({ active: true, status_name: "Inactive" })).toEqual({
      isActive: true,
      reason: "snapshot.active=true",
    });
    expect(deriveIsActiveFromSnapshot({ active: false })).toEqual({
      isActive: false,
      reason: "snapshot.active=false",
    });
  });

  it("falls back to status_name when active is not a boolean", () => {
    expect(deriveIsActiveFromSnapshot({ status_name: "Active" })).toEqual({
      isActive: true,
      reason: 'status_name="Active"',
    });
    expect(deriveIsActiveFromSnapshot({ status_name: "Inactive" })).toEqual({
      isActive: false,
      reason: 'status_name="Inactive"',
    });
  });
});

describe("parseActiveBackfillArgs", () => {
  it("requires --tenant", () => {
    expect(() => parseActiveBackfillArgs([])).toThrow(/--tenant=/);
  });

  it("rejects unknown tenant", () => {
    expect(() => parseActiveBackfillArgs(["--tenant=office_houston"])).toThrow(/--tenant must be one of/);
  });

  it("defaults to dry-run when neither flag is passed", () => {
    const args = parseActiveBackfillArgs(["--tenant=office_dallas"]);
    expect(args).toEqual({ tenants: ["office_dallas"], dryRun: true, execute: false });
  });

  it("respects --execute", () => {
    const args = parseActiveBackfillArgs(["--tenant=office_dallas", "--execute"]);
    expect(args).toEqual({ tenants: ["office_dallas"], dryRun: false, execute: true });
  });

  it("rejects both --dry-run and --execute together", () => {
    expect(() =>
      parseActiveBackfillArgs(["--tenant=office_dallas", "--dry-run", "--execute"])
    ).toThrow(/Choose either/);
  });

  it("expands --tenant=all", () => {
    const args = parseActiveBackfillArgs(["--tenant=all"]);
    expect(args.tenants).toEqual(["office_dallas", "office_atlanta"]);
  });
});

describe("buildTenantActivePlan", () => {
  const row = (overrides: Partial<CandidateRow>): CandidateRow => ({
    id: "00000000-0000-0000-0000-000000000001",
    procoreProjectId: "111",
    procoreProjectNumber: "DFW-001",
    name: "Sample",
    currentIsActive: true,
    rawSnapshot: { active: true },
    ...overrides,
  });

  it("counts rows that are already correct", () => {
    const plan = buildTenantActivePlan({
      tenant: "office_dallas",
      rows: [row({ currentIsActive: true, rawSnapshot: { active: true } })],
    });
    expect(plan.alreadyCorrect).toBe(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("plans to flip active=true → false when snapshot says inactive", () => {
    const plan = buildTenantActivePlan({
      tenant: "office_dallas",
      rows: [row({ currentIsActive: true, rawSnapshot: { active: false } })],
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].oldIsActive).toBe(true);
    expect(plan.updates[0].newIsActive).toBe(false);
  });

  it("plans to flip active=false → true when snapshot says active", () => {
    const plan = buildTenantActivePlan({
      tenant: "office_dallas",
      rows: [row({ currentIsActive: false, rawSnapshot: { active: true } })],
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].newIsActive).toBe(true);
  });

  it("skips rows whose snapshot has no usable active flag", () => {
    const plan = buildTenantActivePlan({
      tenant: "office_dallas",
      rows: [row({ rawSnapshot: { name: "X" } })],
    });
    expect(plan.skippedNoSnapshot).toBe(1);
    expect(plan.updates).toHaveLength(0);
  });

  it("honors status_name fallback when active is missing", () => {
    const plan = buildTenantActivePlan({
      tenant: "office_dallas",
      rows: [
        row({ id: "00000000-0000-0000-0000-000000000002", currentIsActive: true, rawSnapshot: { status_name: "Inactive" } }),
      ],
    });
    expect(plan.updates).toHaveLength(1);
    expect(plan.updates[0].newIsActive).toBe(false);
    expect(plan.updates[0].reason).toContain("Inactive");
  });
});

describe("parity between script's deriveIsActiveFromSnapshot and the live mirror's deriveIsActive", () => {
  // Both helpers must agree on every snapshot shape we encounter so the
  // backfill's plan and the next webhook/backfill sync produce the same
  // is_active result for the same row. The script's export is now a
  // direct re-export of the live mirror's helper — these fixtures pin
  // that contract so a future hand-rolled re-implementation would fail
  // CI rather than silently re-introduce drift.
  const fixtures: Array<{ name: string; snapshot: Record<string, unknown> | null | undefined }> = [
    { name: "null snapshot", snapshot: null },
    { name: "undefined snapshot", snapshot: undefined },
    { name: "empty object", snapshot: {} },
    { name: "active=true", snapshot: { active: true } },
    { name: "active=false", snapshot: { active: false } },
    { name: "active=non-boolean string", snapshot: { active: "yes" } },
    { name: "active=numeric truthy", snapshot: { active: 1 } },
    { name: "active=null", snapshot: { active: null } },
    { name: "status_name Active", snapshot: { status_name: "Active" } },
    { name: "status_name Inactive", snapshot: { status_name: "Inactive" } },
    { name: "status_name numeric (malformed)", snapshot: { status_name: 42 } },
    { name: "status_name null", snapshot: { status_name: null } },
    { name: "active=true overrides Inactive status", snapshot: { active: true, status_name: "Inactive" } },
    { name: "active=false overrides Active status", snapshot: { active: false, status_name: "Active" } },
    { name: "neither field present, name only", snapshot: { name: "X" } },
    { name: "malformed both fields, falls through to null", snapshot: { active: "yes", status_name: 7 } },
  ];

  for (const fixture of fixtures) {
    it(`agrees on: ${fixture.name}`, () => {
      const scriptResult = deriveIsActiveFromSnapshot(fixture.snapshot ?? null);
      const liveResult = deriveIsActive(fixture.snapshot);
      // Both either return null or the same isActive boolean. Reason
      // strings are allowed to drift, since they are debug-only.
      expect(scriptResult === null).toBe(liveResult === null);
      if (scriptResult && liveResult) {
        expect(scriptResult.isActive).toBe(liveResult.isActive);
      }
    });
  }

  it("script export is literally the same function reference as the live mirror", () => {
    // Belt-and-suspenders: even if someone replaces the re-export with a
    // hand-rolled copy that happens to pass the fixtures above, this
    // identity check fails — forcing a re-route through deriveIsActive.
    expect(deriveIsActiveFromSnapshot).toBe(deriveIsActive);
  });
});
