import { getTableColumns } from "drizzle-orm";
import { describe, expect, it } from "vitest";
import {
  LEAD_SCOPING_INTAKE_STATUSES,
  LEAD_SCOPING_SECTION_KEYS,
} from "@trock-crm/shared/types";
import { files, leadScopingIntake } from "@trock-crm/shared/schema";

async function loadScopingRulesModule() {
  try {
    return await import("../../../src/modules/leads/scoping-rules.js");
  } catch {
    return null;
  }
}

async function loadScopingServiceModule() {
  try {
    return await import("../../../src/modules/leads/scoping-service.js");
  } catch {
    return null;
  }
}

interface FakeLeadScopingIntakeRow {
  id: string;
  leadId: string;
  officeId: string;
  status: "draft" | "ready" | "completed";
  sectionData: Record<string, unknown>;
  completionState: Record<string, unknown>;
  readinessErrors: Record<string, unknown>;
  firstReadyAt: Date | null;
  completedAt: Date | null;
  lastAutosavedAt: Date;
  createdBy: string;
  lastEditedBy: string;
  createdAt: Date;
  updatedAt: Date;
}

interface FakeFileRow {
  id: string;
  leadId: string | null;
  dealId: string | null;
  intakeRequirementKey: string | null;
  intakeSource: string | null;
  isActive: boolean;
}

function createFakeTenantDb(initial?: {
  leadScopingIntake?: FakeLeadScopingIntakeRow[];
  files?: FakeFileRow[];
}) {
  const state = {
    leadScopingIntake: initial?.leadScopingIntake ?? [],
    files: initial?.files ?? [],
  };

  function getRows(table: unknown) {
    if (table === leadScopingIntake) return state.leadScopingIntake;
    if (table === files) return state.files;
    throw new Error("Unexpected table in fake tenant db");
  }

  return {
    state,
    select() {
      return {
        from(table: unknown) {
          const rows = getRows(table);
          return {
            where() {
              return {
                limit(limit: number) {
                  return Promise.resolve(rows.slice(0, limit));
                },
                then(onfulfilled: (value: unknown[]) => unknown) {
                  return Promise.resolve(rows).then(onfulfilled);
                },
              };
            },
            limit(limit: number) {
              return Promise.resolve(rows.slice(0, limit));
            },
            then(onfulfilled: (value: unknown[]) => unknown) {
              return Promise.resolve(rows).then(onfulfilled);
            },
          };
        },
      };
    },
    insert(table: unknown) {
      return {
        values(value: Record<string, unknown>) {
          const rows = getRows(table) as Array<Record<string, unknown>>;
          const inserted = {
            id: value.id ?? `row-${rows.length + 1}`,
            ...value,
          };
          rows.push(inserted);
          return {
            returning() {
              return Promise.resolve([inserted]);
            },
          };
        },
      };
    },
    update(table: unknown) {
      return {
        set(values: Record<string, unknown>) {
          return {
            where() {
              const rows = getRows(table) as Array<Record<string, unknown>>;
              rows.forEach((row) => Object.assign(row, values));
              return {
                returning() {
                  return Promise.resolve(rows);
                },
              };
            },
          };
        },
      };
    },
  };
}

function createCompleteSectionData(
  overrides?: Record<string, Record<string, unknown>>
) {
  const base = {
    projectOverview: {
      propertyName: "Palm Villas",
      propertyAddress: "123 Palm Way",
      cityState: "Dallas, TX",
      client: "Palm Ownership",
      accountRep: "Rep 1",
      dateOfWalk: "2026-04-21",
      bidDueDate: "2026-04-30",
      projectType: "na",
      projectTypeOtherText: "na",
    },
    budgetAndBidInfo: {
      ownerBudgetRange: "na",
      numberOfBidders: "na",
      decisionMaker: "na",
      decisionTimeline: "na",
      clientBidPortalRequired: "na",
      clientBidPortalLoginFormatNotes: "na",
      importantContextNotes: "na",
      pricingMode: "na",
    },
    propertyDetails: {
      yearBuilt: "na",
      totalUnits: "na",
      totalBuildings: "na",
      floorsPerBuilding: "na",
      unitMixSummary: "na",
      averageUnitSize: "na",
    },
    projectScopeSummary: {
      highLevelScopeSummaryNarrative: "na",
    },
    interiorUnitRenovationScope: {
      unitsRenovatedMonthly: "na",
      renovationType: "na",
      livingRoomLighting: "na",
      livingRoomElectricalDevices: "na",
      livingRoomWindowTreatment: "na",
      livingRoomDoorHardware: "na",
      livingRoomDrywallRepairs: "na",
      kitchenBarCutDown: "na",
      kitchenCabinetReplacement: "na",
      kitchenCabinetRefinish: "na",
      kitchenNewCountertops: "na",
      kitchenBacksplash: "na",
      kitchenSinkFaucet: "na",
      kitchenAppliancePackage: "na",
      kitchenCabinetHardware: "na",
      kitchenDoorHardware: "na",
      kitchenDrywallRepairs: "na",
      kitchenNotes: "na",
      bedroomsLighting: "na",
      bedroomsElectricalDevices: "na",
      bedroomsWindowTreatment: "na",
      bedroomsDoorHardware: "na",
      bedroomsDrywallRepairs: "na",
      bedroomsNotes: "na",
      bathroomsTubShowerReplacement: "na",
      bathroomsTileSurroundReplacement: "na",
      bathroomsTubShowerResurface: "na",
      bathroomsVanityReplacement: "na",
      bathroomsPlumbingFixtures: "na",
      bathroomsLighting: "na",
      bathroomsBathAccessoriesMirrors: "na",
      bathroomsDrywallRepairs: "na",
      bathroomsNotes: "na",
      flooringExistingFlooring: "na",
      flooringNewFlooring: "na",
      flooringApproxSquareFootagePerUnit: "na",
      paintFullUnitPaint: "na",
      paintWallsOnly: "na",
      paintTrimAndDoors: "na",
      paintColorSelectionsKnown: "na",
      paintDrywallFinish: "na",
    },
    exteriorScope: {
      exteriorPaint: "na",
      sidingRepairReplacement: "na",
      stuccoRepair: "na",
      balconyRepairs: "na",
      railingReplacement: "na",
      windowReplacement: "na",
      breezewayImprovements: "na",
      stairRepairs: "na",
      roofRepairs: "na",
      accessibilityMethod: "na",
      notes: "na",
    },
    amenitiesSiteImprovements: {
      clubhouseRenovation: "na",
      leasingOfficeUpgrades: "na",
      poolAreaImprovements: "na",
      fitnessCenter: "na",
      dogPark: "na",
      outdoorKitchens: "na",
      landscaping: "na",
      parkingLotRepairs: "na",
      siteLighting: "na",
      notes: "na",
    },
    quantities: {
      unitsRenovated: "na",
      buildingsImpacted: "na",
      balconies: "na",
      staircases: "na",
      windowsIfReplacing: "na",
      doors: "na",
      exteriorPaintableAreaEstimate: "na",
    },
    siteLogistics: {
      stagingDumpsterAccessibility: "na",
      elevatorAccess: "na",
    },
    siteConditionsObserved: {
      asbestos: "na",
      waterDamage: "na",
      woodRot: "na",
      structuralConcerns: "na",
      moldMildew: "na",
      electricalIssues: "na",
      plumbingIssues: "na",
      codeConcerns: "na",
      notes: "na",
    },
    materialsSpecifications: {
      specPackageProvided: "na",
      finishLevel: "na",
      ownerSuppliedMaterials: "na",
      preferredBrands: "na",
    },
    attachmentsProvided: {
      companyCamPhotos: "na",
      typicalUnitPhotos: "na",
      exteriorBuildingPhotos: "na",
      amenityPhotos: "na",
      plansDrawings: "na",
      finishSchedules: "na",
      scopeDocuments: "na",
      fileLocationNote: "na",
    },
  } satisfies Record<string, Record<string, unknown>>;

  if (!overrides) {
    return base;
  }

  return Object.fromEntries(
    Object.entries(base).map(([sectionKey, sectionValue]) => [
      sectionKey,
      {
        ...sectionValue,
        ...(overrides[sectionKey] ?? {}),
      },
    ])
  );
}

describe("lead scoping shared contract", () => {
  it("exposes the intake table and section registry", () => {
    expect(LEAD_SCOPING_INTAKE_STATUSES).toEqual(["draft", "ready", "completed"]);
    expect(LEAD_SCOPING_SECTION_KEYS).toContain("projectOverview");
    expect(leadScopingIntake.leadId.name).toBe("lead_id");
    expect(leadScopingIntake.sectionData.name).toBe("section_data");
    expect(leadScopingIntake.completionState.name).toBe("completion_state");
  });

  it("adds lead linkage to the file schema for lead-side scoping uploads", () => {
    const columns = getTableColumns(files);
    expect(columns.leadId.name).toBe("lead_id");
  });
});

describe("lead scoping readiness", () => {
  it("marks every PDF section incomplete until each field has a value or explicit na", async () => {
    const mod = await loadScopingRulesModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadScopingReadiness({
      sectionData: {},
      linkedAttachmentKeys: [],
    });

    expect(result.isReadyForGoNoGo).toBe(false);
    expect(result.completionState.projectOverview.isComplete).toBe(false);
    expect(result.errors.sections.projectOverview).toContain("propertyName");
    expect(result.errors.sections.attachmentsProvided).toContain("scopeDocuments");
  });

  it("treats tri-state checklist fields with na as complete", async () => {
    const mod = await loadScopingRulesModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadScopingReadiness({
      sectionData: createCompleteSectionData(),
      linkedAttachmentKeys: [],
    });

    expect(result.isReadyForGoNoGo).toBe(true);
    expect(result.status).toBe("ready");
  });

  it("requires a linked upload when an attachment answer is provided", async () => {
    const mod = await loadScopingRulesModule();

    expect(mod).not.toBeNull();

    const result = mod!.evaluateLeadScopingReadiness({
      sectionData: createCompleteSectionData({
        attachmentsProvided: {
          scopeDocuments: "provided",
        },
      }),
      linkedAttachmentKeys: [],
    });

    expect(result.isReadyForGoNoGo).toBe(false);
    expect(result.completionState.attachmentsProvided.missingAttachments).toContain("scopeDocuments");
  });
});

describe("lead scoping persistence service", () => {
  it("returns ready once all sections and attachment answers are complete", async () => {
    const mod = await loadScopingServiceModule();

    expect(mod).not.toBeNull();

    const tenantDb = createFakeTenantDb({
      files: [
        {
          id: "file-1",
          leadId: "lead-1",
          dealId: null,
          intakeRequirementKey: "scopeDocuments",
          intakeSource: "lead_scoping_intake",
          isActive: true,
        },
      ],
    });

    const result = await mod!.upsertLeadScopingIntake(tenantDb as never, {
      leadId: "lead-1",
      officeId: "office-1",
      userId: "user-1",
      sectionData: createCompleteSectionData({
        attachmentsProvided: {
          scopeDocuments: "provided",
        },
      }),
    });

    expect(result.readiness.isReadyForGoNoGo).toBe(true);
    expect(result.intake.status).toBe("ready");
  });

  it("autosaves and preserves prior section keys when patching a single section", async () => {
    const mod = await loadScopingServiceModule();

    expect(mod).not.toBeNull();

    const tenantDb = createFakeTenantDb({
      leadScopingIntake: [
        {
          id: "intake-1",
          leadId: "lead-1",
          officeId: "office-1",
          status: "draft",
          sectionData: {
            projectOverview: {
              propertyName: "Palm Villas",
            },
          },
          completionState: {},
          readinessErrors: {},
          firstReadyAt: null,
          completedAt: null,
          lastAutosavedAt: new Date("2026-04-21T10:00:00.000Z"),
          createdBy: "user-1",
          lastEditedBy: "user-1",
          createdAt: new Date("2026-04-21T10:00:00.000Z"),
          updatedAt: new Date("2026-04-21T10:00:00.000Z"),
        },
      ],
    });

    const result = await mod!.upsertLeadScopingIntake(tenantDb as never, {
      leadId: "lead-1",
      officeId: "office-1",
      userId: "user-2",
      sectionData: {
        budgetAndBidInfo: {
          ownerBudgetRange: "na",
        },
      },
    });

    expect(result.intake.sectionData).toMatchObject({
      projectOverview: {
        propertyName: "Palm Villas",
      },
      budgetAndBidInfo: {
        ownerBudgetRange: "na",
      },
    });
    expect(result.intake.lastEditedBy).toBe("user-2");
  });
});
