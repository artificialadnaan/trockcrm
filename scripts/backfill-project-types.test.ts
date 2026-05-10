import { describe, expect, it } from "vitest";
import {
  buildTenantBackfillPlan,
  parseBackfillArgs,
  resolveProjectTypeDecision,
  type ProjectTypeConfigRow,
} from "./backfill-project-types.js";

const projectTypes: ProjectTypeConfigRow[] = [
  {
    id: "type-exterior",
    code: "1",
    name: "Exterior Renovation",
    slug: "exterior-renovation",
    isActive: true,
  },
  {
    id: "type-interior",
    code: "2",
    name: "Interior Renovation",
    slug: "interior-renovation",
    isActive: true,
  },
  {
    id: "type-service",
    code: "4",
    name: "Service",
    slug: "service",
    isActive: true,
  },
  {
    id: "type-new-construction",
    code: null,
    name: "New Construction",
    slug: "new_construction",
    isActive: false,
  },
  {
    id: "type-service-legacy",
    code: null,
    name: "Service",
    slug: "service-legacy",
    isActive: false,
  },
];

describe("project type backfill resolver", () => {
  it("prefers active numeric code over conflicting text label", () => {
    const decision = resolveProjectTypeDecision({
      projectTypes,
      includeLegacy: false,
      hubspotExtraProperties: {
        project_types: "4",
        project_type: "Exterior Renovation",
      },
    });

    expect(decision.action).toBe("UPDATE");
    expect(decision.sourceField).toBe("numeric");
    expect(decision.numericValue).toBe("4");
    expect(decision.textValue).toBe("Exterior Renovation");
    expect(decision.resolvedTypeId).toBe("type-service");
    expect(decision.conflict).toBe(true);
    expect(decision.reason).toBe("numeric active code match");
  });

  it("falls back to active text label when no numeric code resolves", () => {
    const decision = resolveProjectTypeDecision({
      projectTypes,
      includeLegacy: false,
      hubspotExtraProperties: {
        project_type: "interior renovation",
      },
    });

    expect(decision.action).toBe("UPDATE");
    expect(decision.sourceField).toBe("text");
    expect(decision.resolvedTypeId).toBe("type-interior");
    expect(decision.resolvedTypeLabel).toBe("Interior Renovation");
  });

  it("prefers active text labels over inactive duplicate labels", () => {
    const decision = resolveProjectTypeDecision({
      projectTypes: [
        {
          id: "inactive-service",
          code: null,
          name: "Service",
          slug: "service-retired",
          isActive: false,
        },
        ...projectTypes,
      ],
      includeLegacy: true,
      hubspotExtraProperties: {
        project_type: "Service",
      },
    });

    expect(decision.action).toBe("UPDATE");
    expect(decision.reason).toBe("text active label match");
    expect(decision.resolvedTypeId).toBe("type-service");
  });

  it("skips inactive text matches unless includeLegacy is true", () => {
    const skipped = resolveProjectTypeDecision({
      projectTypes,
      includeLegacy: false,
      hubspotExtraProperties: {
        project_type: "New Construction",
      },
    });

    expect(skipped.action).toBe("SKIP");
    expect(skipped.reason).toBe("text matches inactive project type");
    expect(skipped.resolvedTypeId).toBe(null);

    const included = resolveProjectTypeDecision({
      projectTypes,
      includeLegacy: true,
      hubspotExtraProperties: {
        project_type: "New Construction",
      },
    });

    expect(included.action).toBe("UPDATE");
    expect(included.sourceField).toBe("text");
    expect(included.resolvedTypeId).toBe("type-new-construction");
    expect(included.reason).toBe("text inactive match included");
  });

  it("skips rows with no preserved project type signal", () => {
    const decision = resolveProjectTypeDecision({
      projectTypes,
      includeLegacy: false,
      hubspotExtraProperties: {
        project_number: "2-CSP.1-101325",
        project_description__briefly_describe_the_project_: "Renovation notes",
      },
    });

    expect(decision.action).toBe("SKIP");
    expect(decision.sourceField).toBe("none");
    expect(decision.sourceValue).toBe(null);
    expect(decision.reason).toBe("no preserved project type data");
  });

  it("builds an integration plan for update, conflict, inactive skip, and no-signal cases", () => {
    const plan = buildTenantBackfillPlan({
      tenant: "office_dallas",
      projectTypes,
      includeLegacy: false,
      candidates: [
        {
          id: "deal-numeric",
          hubspotDealId: "100",
          hubspotExtraProperties: { project_types: "4", project_type: "Exterior Renovation" },
        },
        {
          id: "deal-text",
          hubspotDealId: "101",
          hubspotExtraProperties: { project_type: "Interior Renovation" },
        },
        {
          id: "deal-inactive",
          hubspotDealId: "102",
          hubspotExtraProperties: { project_type: "New Construction" },
        },
        {
          id: "deal-none",
          hubspotDealId: "103",
          hubspotExtraProperties: { project_number: "legacy" },
        },
      ],
    });

    expect(plan.examined).toBe(4);
    expect(plan.updates).toHaveLength(2);
    expect(plan.skips).toHaveLength(2);
    expect(plan.conflicts).toHaveLength(1);
    expect(plan.updateBreakdown).toEqual({ numeric: 1, text: 1 });
    expect(plan.skipBreakdown["text matches inactive project type"]).toBe(1);
    expect(plan.skipBreakdown["no preserved project type data"]).toBe(1);
    expect(plan.updates.every((row) => row.resolvedTypeId !== null)).toBe(true);
  });
});

describe("project type backfill CLI args", () => {
  it("requires an explicit tenant and defaults to dry-run", () => {
    expect(() => parseBackfillArgs([])).toThrow("--tenant=<office_dallas|office_atlanta|all> is required");

    expect(parseBackfillArgs(["backfill-project-types", "--tenant=office_dallas"])).toMatchObject({
      tenants: ["office_dallas"],
      dryRun: true,
      execute: false,
      includeLegacy: false,
      limit: null,
    });
  });

  it("requires execute to be explicit and rejects ambiguous dry-run/execute flags", () => {
    expect(
      parseBackfillArgs(["backfill-project-types", "--tenant=all", "--execute", "--limit=5"])
    ).toMatchObject({
      tenants: ["office_dallas", "office_atlanta"],
      dryRun: false,
      execute: true,
      limit: 5,
    });

    expect(() =>
      parseBackfillArgs(["backfill-project-types", "--tenant=office_dallas", "--dry-run", "--execute"])
    ).toThrow("Choose either --dry-run or --execute, not both");
  });
});
