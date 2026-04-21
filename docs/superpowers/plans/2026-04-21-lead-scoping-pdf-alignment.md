# Lead Scoping PDF Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a dedicated lead-side scoping intake that maps the full `Project Scoping Checklist COMPLETED.pdf`, requires full completion before `Lead Go/No-Go`, and attaches a read-only PDF artifact to the successor deal at conversion time.

**Architecture:** Keep lead scoping and deal scoping as separate workflows. Introduce a new `lead_scoping_intake` table plus shared lead-scoping types, move lead gate evaluation from `scopingSubsetData` to a dedicated readiness service, add a native lead-scoping workspace to the lead detail page, and generate a server-side PDF artifact that gets stored as a deal file during conversion.

**Tech Stack:** PostgreSQL, Drizzle ORM, Express, React, TypeScript, Vitest, Playwright, Cloudflare R2, `pdf-lib`

---

## File Map

### Database / Shared Contract

- Create: `migrations/0044_lead_scoping_pdf_alignment.sql`
- Create: `shared/src/schema/tenant/lead-scoping-intake.ts`
- Create: `shared/src/types/lead-scoping.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/files.ts`
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/types/index.ts`
- Modify: `shared/src/types/workflow-gates.ts`

### Server Lead Scoping

- Create: `server/src/modules/leads/scoping-rules.ts`
- Create: `server/src/modules/leads/scoping-service.ts`
- Create: `server/src/modules/leads/scoping-artifact.ts`
- Modify: `server/src/modules/leads/qualification-service.ts`
- Modify: `server/src/modules/leads/stage-gate.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/leads/conversion-service.ts`
- Modify: `server/src/modules/deals/scoping-service.ts`
- Modify: `server/src/modules/files/service.ts`
- Modify: `server/src/modules/files/routes.ts`
- Modify: `server/package.json`
- Modify: `package-lock.json`
- Test: `server/tests/modules/leads/scoping-service.test.ts`
- Test: `server/tests/modules/leads/stage-gate.test.ts`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/files/service.test.ts`

### Client Lead Workspace

- Create: `client/src/components/leads/lead-scoping-workspace.tsx`
- Modify: `client/src/components/files/file-upload-zone.tsx`
- Modify: `client/src/components/leads/lead-qualification-panel.tsx`
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/hooks/use-files.ts`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Test: `client/src/hooks/use-leads.test.ts`
- Test: `client/src/pages/leads/lead-detail-page.test.tsx`

### End-To-End Verification

- Modify: `client/e2e/pipeline-workflow-alignment.spec.ts`

### Docs

- Modify: `docs/superpowers/specs/2026-04-21-lead-scoping-pdf-alignment-design.md` only if implementation review proves the reviewed spec is internally inconsistent

---

### Task 1: Add The Lead-Scoping Schema And Shared Type Contract

**Files:**
- Create: `migrations/0044_lead_scoping_pdf_alignment.sql`
- Create: `shared/src/schema/tenant/lead-scoping-intake.ts`
- Create: `shared/src/types/lead-scoping.ts`
- Modify: `shared/src/schema/index.ts`
- Modify: `shared/src/schema/tenant/files.ts`
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/types/index.ts`
- Modify: `shared/src/types/workflow-gates.ts`
- Test: `server/tests/modules/leads/scoping-service.test.ts`

- [ ] **Step 1: Write the failing shared-contract test**

Create `server/tests/modules/leads/scoping-service.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import {
  LEAD_SCOPING_INTAKE_STATUSES,
  LEAD_SCOPING_SECTION_KEYS,
} from "@trock-crm/shared/types";
import { leadScopingIntake } from "@trock-crm/shared/schema";

describe("lead scoping shared contract", () => {
  it("exposes the intake table and section registry", () => {
    expect(LEAD_SCOPING_INTAKE_STATUSES).toEqual(["draft", "ready", "completed"]);
    expect(LEAD_SCOPING_SECTION_KEYS).toContain("projectOverview");
    expect(leadScopingIntake.leadId.name).toBe("lead_id");
    expect(leadScopingIntake.sectionData.name).toBe("section_data");
    expect(leadScopingIntake.completionState.name).toBe("completion_state");
  });
});
```

- [ ] **Step 2: Run the test to verify the contract does not exist yet**

Run:

```bash
npx vitest run server/tests/modules/leads/scoping-service.test.ts
```

Expected: FAIL because `shared/src/types/lead-scoping.ts` and `shared/src/schema/tenant/lead-scoping-intake.ts` do not exist yet.

- [ ] **Step 3: Add the SQL migration**

Create `migrations/0044_lead_scoping_pdf_alignment.sql`:

```sql
DO $$ BEGIN
  CREATE TYPE lead_scoping_intake_status AS ENUM ('draft', 'ready', 'completed');
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE TABLE IF NOT EXISTS lead_scoping_intake (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  lead_id UUID NOT NULL REFERENCES leads(id) ON DELETE CASCADE UNIQUE,
  office_id UUID NOT NULL REFERENCES public.offices(id),
  status lead_scoping_intake_status NOT NULL DEFAULT 'draft',
  section_data JSONB NOT NULL DEFAULT '{}'::jsonb,
  completion_state JSONB NOT NULL DEFAULT '{}'::jsonb,
  readiness_errors JSONB NOT NULL DEFAULT '{}'::jsonb,
  first_ready_at TIMESTAMPTZ,
  completed_at TIMESTAMPTZ,
  last_autosaved_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  created_by UUID NOT NULL REFERENCES public.users(id),
  last_edited_by UUID NOT NULL REFERENCES public.users(id),
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS lead_scoping_intake_office_id_idx
  ON lead_scoping_intake(office_id, updated_at DESC);

ALTER TABLE files
  ADD COLUMN IF NOT EXISTS lead_id UUID REFERENCES leads(id);

CREATE INDEX IF NOT EXISTS files_lead_idx
  ON files(lead_id, category, created_at);

INSERT INTO lead_scoping_intake (
  id,
  lead_id,
  office_id,
  status,
  section_data,
  completion_state,
  readiness_errors,
  created_by,
  last_edited_by,
  created_at,
  updated_at,
  last_autosaved_at
)
SELECT
  gen_random_uuid(),
  lq.lead_id,
  COALESCE(owner_user.office_id, editor_user.office_id),
  'draft'::lead_scoping_intake_status,
  jsonb_strip_nulls(
    jsonb_build_object(
      'projectOverview',
      jsonb_build_object(
        'propertyName', lq.qualification_data->>'propertyName',
        'propertyAddress', lq.qualification_data->>'propertyAddress'
      ),
      'propertyDetails',
      jsonb_build_object(
        'cityState', concat_ws(', ', lq.qualification_data->>'propertyCity', lq.qualification_data->>'propertyState')
      ),
      'projectScopeSummary',
      jsonb_build_object(
        'highLevelScopeSummaryNarrative', lq.qualification_data->>'scopeSummary'
      )
    )
  ),
  '{}'::jsonb,
  '{"sections":{},"attachments":{}}'::jsonb,
  COALESCE(editor_user.id, owner_user.id),
  COALESCE(editor_user.id, owner_user.id),
  NOW(),
  NOW(),
  NOW()
FROM lead_qualification lq
JOIN leads ld ON ld.id = lq.lead_id
LEFT JOIN public.users owner_user ON owner_user.id = ld.assigned_rep_id
LEFT JOIN public.users editor_user ON editor_user.id = ld.forecast_updated_by
WHERE NOT EXISTS (
  SELECT 1
  FROM lead_scoping_intake existing
  WHERE existing.lead_id = lq.lead_id
);
```

- [ ] **Step 4: Add the Drizzle schema and shared types**

Create `shared/src/schema/tenant/lead-scoping-intake.ts`:

```ts
import { jsonb, pgEnum, pgTable, timestamp, uuid } from "drizzle-orm/pg-core";
import { LEAD_SCOPING_INTAKE_STATUSES } from "../../types/enums.js";
import { offices } from "../public/offices.js";
import { users } from "../public/users.js";
import { leads } from "./leads.js";

export const leadScopingIntakeStatusEnum = pgEnum(
  "lead_scoping_intake_status",
  LEAD_SCOPING_INTAKE_STATUSES
);

export const leadScopingIntake = pgTable("lead_scoping_intake", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").references(() => leads.id).unique().notNull(),
  officeId: uuid("office_id").references(() => offices.id).notNull(),
  status: leadScopingIntakeStatusEnum("status").default("draft").notNull(),
  sectionData: jsonb("section_data").default({}).notNull(),
  completionState: jsonb("completion_state").default({}).notNull(),
  readinessErrors: jsonb("readiness_errors").default({}).notNull(),
  firstReadyAt: timestamp("first_ready_at", { withTimezone: true }),
  completedAt: timestamp("completed_at", { withTimezone: true }),
  lastAutosavedAt: timestamp("last_autosaved_at", { withTimezone: true }).defaultNow().notNull(),
  createdBy: uuid("created_by").references(() => users.id).notNull(),
  lastEditedBy: uuid("last_edited_by").references(() => users.id).notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

Create `shared/src/types/lead-scoping.ts`:

```ts
export const LEAD_SCOPING_SECTION_KEYS = [
  "projectOverview",
  "budgetAndBidInfo",
  "propertyDetails",
  "projectScopeSummary",
  "interiorUnitRenovationScope",
  "exteriorScope",
  "amenitiesSiteImprovements",
  "quantities",
  "siteLogistics",
  "siteConditionsObserved",
  "materialsSpecifications",
  "attachmentsProvided",
] as const;

export type LeadScopingSectionKey = (typeof LEAD_SCOPING_SECTION_KEYS)[number];

export type ApplicabilityValue = "provided" | "na";
export type TriStateValue = "yes" | "no" | "na";
export type AttachmentAnswerValue = "provided" | "not_provided" | "na";
export type LeadScopingIntakeStatus = "draft" | "ready" | "completed";

export interface ProjectOverviewSection {
  propertyName: string | null;
  propertyAddress: string | null;
  cityState: string | null;
  client: string | null;
  accountRep: string | null;
  dateOfWalk: string | null;
  bidDueDate: string | null;
  projectType:
    | "interior_unit_renovation"
    | "exterior_renovation"
    | "amenity_clubhouse_renovation"
    | "dd"
    | "other"
    | "na"
    | null;
  projectTypeOtherText: string | null;
}

export interface BudgetAndBidInfoSection {
  ownerBudgetRange: string | null;
  numberOfBidders: string | null;
  decisionMaker: string | null;
  decisionTimeline: string | null;
  clientBidPortalRequired: TriStateValue | null;
  clientBidPortalLoginFormatNotes: string | null;
  importantContextExpectationsUpsellAllowancesWalkthroughConcernsNotes: string | null;
  pricingMode: "budget_pricing" | "detailed_bid" | "alternate_pricing" | "na" | null;
}

export interface LeadScopingSectionData {
  projectOverview?: ProjectOverviewSection;
  budgetAndBidInfo?: BudgetAndBidInfoSection;
  propertyDetails?: Record<string, unknown>;
  projectScopeSummary?: Record<string, unknown>;
  interiorUnitRenovationScope?: Record<string, unknown>;
  exteriorScope?: Record<string, unknown>;
  amenitiesSiteImprovements?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  siteLogistics?: Record<string, unknown>;
  siteConditionsObserved?: Record<string, unknown>;
  materialsSpecifications?: Record<string, unknown>;
  attachmentsProvided?: Record<string, AttachmentAnswerValue | string | null>;
}

export interface LeadScopingCompletionStateEntry {
  isComplete: boolean;
  missingFields: string[];
  missingAttachments: string[];
}

export interface LeadScopingReadiness {
  status: LeadScopingIntakeStatus;
  isReadyForGoNoGo: boolean;
  completionState: Record<string, LeadScopingCompletionStateEntry>;
  errors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
}
```

Modify `shared/src/types/enums.ts`:

```ts
export const LEAD_SCOPING_INTAKE_STATUSES = ["draft", "ready", "completed"] as const;
export type LeadScopingIntakeStatus = (typeof LEAD_SCOPING_INTAKE_STATUSES)[number];
```

Modify `shared/src/types/index.ts`:

```ts
export * from "./lead-scoping.js";
```

Modify `shared/src/schema/index.ts`:

```ts
export { leadScopingIntake, leadScopingIntakeStatusEnum } from "./tenant/lead-scoping-intake.js";
```

Modify `shared/src/schema/tenant/files.ts`:

```ts
leadId: uuid("lead_id"),
```

Modify `shared/src/types/workflow-gates.ts`:

```ts
export const LEAD_GO_NO_GO_GATE_FIELD_KEYS = ["leadScoping.completedChecklist"] as const;
```

Inside the existing `WORKFLOW_GATE_FIELD_LABELS` object, add:

```ts
"leadScoping.completedChecklist": "Lead Scoping Checklist Completed",
```

When filling out `shared/src/types/lead-scoping.ts`, define the remaining section interfaces with the exact field list from the reviewed spec rather than a loose catch-all object. Nested repeating structures such as unit-mix rows can stay as typed arrays of row objects.

- [ ] **Step 5: Re-run the shared-contract test**

Run:

```bash
npx vitest run server/tests/modules/leads/scoping-service.test.ts
```

Expected: PASS for the shared contract test, with later service-specific tests still missing.

- [ ] **Step 6: Commit**

```bash
git add migrations/0044_lead_scoping_pdf_alignment.sql shared/src/schema/tenant/lead-scoping-intake.ts shared/src/schema/tenant/files.ts shared/src/schema/index.ts shared/src/types/enums.ts shared/src/types/index.ts shared/src/types/lead-scoping.ts shared/src/types/workflow-gates.ts server/tests/modules/leads/scoping-service.test.ts
git commit -m "feat: add lead scoping shared contract"
```

---

### Task 2: Build The Lead-Scoping Readiness Service And API

**Files:**
- Create: `server/src/modules/leads/scoping-rules.ts`
- Create: `server/src/modules/leads/scoping-service.ts`
- Modify: `server/src/modules/files/service.ts`
- Modify: `server/src/modules/files/routes.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Test: `server/tests/modules/leads/scoping-service.test.ts`
- Test: `server/tests/modules/files/service.test.ts`

- [ ] **Step 1: Expand the failing service tests**

Add these cases to `server/tests/modules/leads/scoping-service.test.ts`:

```ts
it("marks every PDF section incomplete until each field has a value or explicit na", async () => {});
it("treats tri-state checklist fields with na as complete", async () => {});
it("requires a linked upload when an attachment answer is provided", async () => {});
it("returns ready once all sections and attachment answers are complete", async () => {});
it("autosaves and preserves prior section keys when patching a single section", async () => {});
```

- [ ] **Step 2: Run the service test to verify it fails**

Run:

```bash
npx vitest run server/tests/modules/leads/scoping-service.test.ts
```

Expected: FAIL because `evaluateLeadScopingReadiness`, `getOrCreateLeadScopingIntake`, and `upsertLeadScopingIntake` do not exist.

- [ ] **Step 3: Add readiness rules for the full PDF contract**

Create `server/src/modules/leads/scoping-rules.ts`:

```ts
import type {
  LeadScopingCompletionStateEntry,
  LeadScopingReadiness,
  LeadScopingSectionData,
  LeadScopingSectionKey,
} from "@trock-crm/shared/types";

const REQUIRED_SECTION_FIELDS: Record<LeadScopingSectionKey, string[]> = {
  projectOverview: [
    "propertyName",
    "propertyAddress",
    "cityState",
    "client",
    "accountRep",
    "dateOfWalk",
    "bidDueDate",
    "projectType",
  ],
  budgetAndBidInfo: [
    "ownerBudgetRange",
    "numberOfBidders",
    "decisionMaker",
    "decisionTimeline",
    "clientBidPortalRequired",
    "pricingMode",
  ],
  propertyDetails: [
    "yearBuilt",
    "totalUnits",
    "totalBuildings",
    "floorsPerBuilding",
    "averageUnitSize",
  ],
  projectScopeSummary: ["highLevelScopeSummaryNarrative"],
  interiorUnitRenovationScope: ["unitsRenovatedMonthly", "renovationType", "paintDrywallFinish"],
  exteriorScope: ["exteriorPaint", "sidingRepairReplacement", "accessibilityMethod"],
  amenitiesSiteImprovements: ["clubhouseRenovation", "leasingOfficeUpgrades", "siteLighting"],
  quantities: ["unitsRenovated", "buildingsImpacted", "doors"],
  siteLogistics: ["stagingDumpsterAccessibility", "elevatorAccess"],
  siteConditionsObserved: ["asbestos", "waterDamage", "codeConcerns"],
  materialsSpecifications: ["specPackageProvided", "finishLevel", "ownerSuppliedMaterials"],
  attachmentsProvided: [
    "companyCamPhotos",
    "typicalUnitPhotos",
    "exteriorBuildingPhotos",
    "amenityPhotos",
    "plansDrawings",
    "finishSchedules",
    "scopeDocuments",
    "fileLocationNote",
  ],
};

export function evaluateLeadScopingReadiness(input: {
  sectionData: LeadScopingSectionData;
  linkedAttachmentKeys: string[];
}): LeadScopingReadiness {
  const completionState: Record<string, LeadScopingCompletionStateEntry> = {};
  const sectionErrors: Record<string, string[]> = {};
  const attachmentErrors: Record<string, string[]> = {};

  for (const [sectionKey, requiredFields] of Object.entries(REQUIRED_SECTION_FIELDS)) {
    const section = (input.sectionData[sectionKey as LeadScopingSectionKey] ?? {}) as Record<string, unknown>;
    const missingFields = requiredFields.filter((field) => {
      const value = section[field];
      if (typeof value === "string") return value.trim().length === 0;
      if (value === null || value === undefined) return true;
      return false;
    });

    const missingAttachments =
      sectionKey === "attachmentsProvided"
        ? requiredFields.filter((field) => section[field] === "provided" && !input.linkedAttachmentKeys.includes(field))
        : [];

    completionState[sectionKey] = {
      isComplete: missingFields.length === 0 && missingAttachments.length === 0,
      missingFields,
      missingAttachments,
    };
    sectionErrors[sectionKey] = missingFields;
    if (missingAttachments.length > 0) {
      attachmentErrors[sectionKey] = missingAttachments;
    }
  }

  const isReadyForGoNoGo = Object.values(completionState).every((entry) => entry.isComplete);

  return {
    status: isReadyForGoNoGo ? "ready" : "draft",
    isReadyForGoNoGo,
    completionState,
    errors: {
      sections: sectionErrors,
      attachments: attachmentErrors,
    },
  };
}
```

- [ ] **Step 4: Add the lead-scoping persistence service**

Create `server/src/modules/leads/scoping-service.ts`:

```ts
import { and, eq, isNull } from "drizzle-orm";
import { leadScopingIntake, files } from "@trock-crm/shared/schema";
import type * as schema from "@trock-crm/shared/schema";
import type { NodePgDatabase } from "drizzle-orm/node-postgres";
import type { LeadScopingReadiness, LeadScopingSectionData } from "@trock-crm/shared/types";
import { AppError } from "../../middleware/error-handler.js";
import { evaluateLeadScopingReadiness } from "./scoping-rules.js";

type TenantDb = NodePgDatabase<typeof schema>;

export async function getLeadScopingIntake(tenantDb: TenantDb, leadId: string) {
  const [row] = await tenantDb
    .select()
    .from(leadScopingIntake)
    .where(eq(leadScopingIntake.leadId, leadId))
    .limit(1);

  return row ?? null;
}

export async function getOrCreateLeadScopingIntake(
  tenantDb: TenantDb,
  input: { leadId: string; officeId: string; userId: string }
) {
  const existing = await getLeadScopingIntake(tenantDb, input.leadId);
  if (existing) {
    return existing;
  }

  const [created] = await tenantDb
    .insert(leadScopingIntake)
    .values({
      leadId: input.leadId,
      officeId: input.officeId,
      createdBy: input.userId,
      lastEditedBy: input.userId,
    })
    .returning();

  if (!created) {
    throw new AppError(500, "Failed to create lead scoping intake");
  }

  return created;
}

export async function upsertLeadScopingIntake(
  tenantDb: TenantDb,
  input: {
    leadId: string;
    officeId: string;
    userId: string;
    sectionData: LeadScopingSectionData;
  }
) {
  const current = await getOrCreateLeadScopingIntake(tenantDb, input);
  const mergedSectionData = {
    ...(current.sectionData as Record<string, unknown>),
    ...(input.sectionData as Record<string, unknown>),
  };
  const linkedFiles = await tenantDb
    .select({ intakeRequirementKey: files.intakeRequirementKey })
    .from(files)
    .where(
      and(
        eq(files.leadId, input.leadId),
        eq(files.intakeSource, "lead_scoping_intake"),
        isNull(files.dealId)
      )
    );

  const readiness = evaluateLeadScopingReadiness({
    sectionData: mergedSectionData,
    linkedAttachmentKeys: linkedFiles
      .map((file) => file.intakeRequirementKey)
      .filter((value): value is string => typeof value === "string"),
  });

  const [updated] = await tenantDb
    .update(leadScopingIntake)
    .set({
      sectionData: mergedSectionData,
      completionState: readiness.completionState,
      readinessErrors: readiness.errors,
      status: readiness.isReadyForGoNoGo ? "ready" : "draft",
      firstReadyAt: readiness.isReadyForGoNoGo ? current.firstReadyAt ?? new Date() : current.firstReadyAt,
      completedAt: current.completedAt,
      lastAutosavedAt: new Date(),
      lastEditedBy: input.userId,
      updatedAt: new Date(),
    })
    .where(eq(leadScopingIntake.id, current.id))
    .returning();

  return {
    intake: updated ?? current,
    readiness,
  };
}

export async function getLeadScopingReadiness(
  tenantDb: TenantDb,
  leadId: string
): Promise<LeadScopingReadiness> {
  const intake = await getLeadScopingIntake(tenantDb, leadId);
  return evaluateLeadScopingReadiness({
    sectionData: (intake?.sectionData as LeadScopingSectionData | undefined) ?? {},
    linkedAttachmentKeys: [],
  });
}
```

- [ ] **Step 5: Allow lead-associated uploads for attachment-backed checklist items**

Modify `server/src/modules/files/service.ts`:

```ts
export interface RequestUploadInput {
  originalFilename: string;
  mimeType: string;
  fileSizeBytes: number;
  category: FileCategory;
  subcategory?: string;
  dealId?: string;
  leadId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
  description?: string;
  tags?: string[];
  intakeSection?: string;
  intakeRequirementKey?: string;
  intakeSource?: string;
}

function validateAssociations(input: {
  dealId?: string;
  leadId?: string;
  contactId?: string;
  procoreProjectId?: number;
  changeOrderId?: string;
}): void {
  if (!input.dealId && !input.leadId && !input.contactId && !input.procoreProjectId && !input.changeOrderId) {
    throw new AppError(400, "File must be associated with at least one entity (deal, lead, contact, Procore project, or change order).");
  }
}

// Persist the new lead linkage and intake metadata through the pending-upload
// object and the final `insert(files).values(...)` call:
leadId: input.leadId,
intakeSection: input.intakeSection,
intakeRequirementKey: input.intakeRequirementKey,
intakeSource: input.intakeSource,
```

Modify `server/src/modules/files/routes.ts` to accept and validate `leadId` on both `/upload-url` and `/upload-direct`:

```ts
const leadId = req.headers["x-lead-id"] as string | undefined;
const intakeSection = req.headers["x-intake-section"] as string | undefined;
const intakeRequirementKey = req.headers["x-intake-requirement-key"] as string | undefined;
const intakeSource = req.headers["x-intake-source"] as string | undefined;

if (leadId) {
  const lead = await getLeadById(req.tenantDb!, leadId, req.user!.role, req.user!.id);
  if (!lead) throw new AppError(404, "Lead not found or access denied.");
}

const result = await requestUploadUrl(req.tenantDb!, req.officeSlug!, req.user!.id, {
  originalFilename,
  mimeType,
  fileSizeBytes: body.length,
  category: category as FileCategory,
  leadId,
  intakeSection,
  intakeRequirementKey,
  intakeSource,
});
```

Also write a targeted `server/tests/modules/files/service.test.ts` case that proves a file row can be created with `leadId`, `intakeSource: "lead_scoping_intake"`, and an attachment requirement key.

- [ ] **Step 6: Expose lead-scoping API routes**

Modify `server/src/modules/leads/routes.ts`:

```ts
import {
  getLeadScopingIntake,
  getLeadScopingReadiness,
  getOrCreateLeadScopingIntake,
  upsertLeadScopingIntake,
} from "./scoping-service.js";

router.get("/:id/scoping", async (req, res, next) => {
  try {
    await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    const intake = await getOrCreateLeadScopingIntake(req.tenantDb!, {
      leadId: req.params.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
    });
    const readiness = await getLeadScopingReadiness(req.tenantDb!, req.params.id);
    await req.commitTransaction!();
    res.json({ intake, readiness });
  } catch (err) {
    next(err);
  }
});

router.patch("/:id/scoping", async (req, res, next) => {
  try {
    await getLeadById(req.tenantDb!, req.params.id, req.user!.role, req.user!.id);
    const result = await upsertLeadScopingIntake(req.tenantDb!, {
      leadId: req.params.id,
      officeId: req.user!.activeOfficeId ?? req.user!.officeId,
      userId: req.user!.id,
      sectionData: req.body.sectionData ?? {},
    });
    await req.commitTransaction!();
    res.json(result);
  } catch (err) {
    next(err);
  }
});
```

- [ ] **Step 7: Re-run the lead-scoping service and files tests**

Run:

```bash
npx vitest run server/tests/modules/leads/scoping-service.test.ts server/tests/modules/files/service.test.ts
```

Expected: PASS for readiness, autosave, lead-linked uploads, and attachment-completion scenarios.

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/leads/scoping-rules.ts server/src/modules/leads/scoping-service.ts server/src/modules/leads/routes.ts server/src/modules/files/service.ts server/src/modules/files/routes.ts server/tests/modules/leads/scoping-service.test.ts server/tests/modules/files/service.test.ts
git commit -m "feat: add lead scoping readiness service"
```

---

### Task 3: Enforce `Lead Go/No-Go` From Lead-Scoping Readiness

**Files:**
- Modify: `server/src/modules/leads/qualification-service.ts`
- Modify: `server/src/modules/leads/stage-gate.ts`
- Modify: `shared/src/types/workflow-gates.ts`
- Test: `server/tests/modules/leads/stage-gate.test.ts`

- [ ] **Step 1: Expand the failing stage-gate tests**

Add these cases to `server/tests/modules/leads/stage-gate.test.ts`:

```ts
it("blocks Pre-Qual Value Assigned -> Lead Go/No-Go when the lead scoping checklist is incomplete", async () => {});
it("allows Lead Go/No-Go once the lead scoping readiness service returns ready", async () => {});
it("does not use scopingSubsetData as a passing gate anymore", async () => {});
```

- [ ] **Step 2: Run the stage-gate suite**

Run:

```bash
npx vitest run server/tests/modules/leads/stage-gate.test.ts
```

Expected: FAIL because `lead_go_no_go` still only checks `estimatedOpportunityValue` and `qualified_for_opportunity` still checks `scopingSubsetData`.

- [ ] **Step 3: Remove lead-scoping subset reliance from the qualification patch contract**

Modify `server/src/modules/leads/qualification-service.ts`:

```ts
export interface LeadQualificationPatch {
  estimatedOpportunityValue?: string | null;
  goDecision?: "go" | "no_go" | null;
  goDecisionNotes?: string | null;
  qualificationData?: Record<string, unknown>;
  disqualificationReason?: string | null;
  disqualificationNotes?: string | null;
}

const nextQualificationData = {
  ...(existing?.qualificationData ?? {}),
  ...(patch.qualificationData ?? {}),
};
```

Leave the `scopingSubsetData` column in place for historical records, but stop writing new gate state through it.

- [ ] **Step 4: Update stage-gate evaluation to use lead-scoping readiness**

Modify `server/src/modules/leads/stage-gate.ts`:

```ts
import { getLeadScopingReadiness } from "./scoping-service.js";

const LEAD_STAGE_REQUIREMENTS: Record<string, string[]> = {
  company_pre_qualified: ["companyId", "propertyId", "source", ...LEAD_COMPANY_PREQUAL_FIELD_KEYS],
  scoping_in_progress: [...LEAD_COMPANY_PREQUAL_FIELD_KEYS],
  pre_qual_value_assigned: [...LEAD_COMPANY_PREQUAL_FIELD_KEYS, ...LEAD_VALUE_ASSIGNMENT_FIELD_KEYS],
  lead_go_no_go: ["estimatedOpportunityValue", "leadScoping.completedChecklist"],
  qualified_for_opportunity: ["goDecision", "goDecisionNotes"],
};

async function getSyntheticRequirementValue(
  tenantDb: TenantDb,
  leadId: string,
  field: string
) {
  if (field !== "leadScoping.completedChecklist") {
    return undefined;
  }

  const readiness = await getLeadScopingReadiness(tenantDb, leadId);
  return readiness.isReadyForGoNoGo;
}
```

Then, inside `validateLeadStageGate`, resolve the synthetic lead-scoping requirement before building `missingFields`.

- [ ] **Step 5: Re-run the stage-gate suite**

Run:

```bash
npx vitest run server/tests/modules/leads/stage-gate.test.ts
```

Expected: PASS, with `Lead Go/No-Go` blocked until the new intake is complete and `scopingSubsetData` no longer sufficient.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/leads/qualification-service.ts server/src/modules/leads/stage-gate.ts shared/src/types/workflow-gates.ts server/tests/modules/leads/stage-gate.test.ts
git commit -m "feat: gate lead go-no-go on lead scoping readiness"
```

---

### Task 4: Add The Native Lead-Scoping Workspace To The Lead UI

**Files:**
- Create: `client/src/components/leads/lead-scoping-workspace.tsx`
- Modify: `client/src/components/files/file-upload-zone.tsx`
- Modify: `client/src/components/leads/lead-qualification-panel.tsx`
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/hooks/use-files.ts`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Test: `client/src/hooks/use-leads.test.ts`
- Test: `client/src/pages/leads/lead-detail-page.test.tsx`

- [ ] **Step 1: Expand the failing client tests**

Add these cases:

In `client/src/hooks/use-leads.test.ts`:

```ts
it("loads the lead scoping intake and readiness payload", async () => {});
it("patches sectionData through the lead scoping endpoint", async () => {});
```

In `client/src/pages/leads/lead-detail-page.test.tsx`:

```ts
it("renders the lead scoping workspace and section progress", () => {});
it("shows the go-no-go blocker text when lead scoping is incomplete", () => {});
it("renders a lead attachment upload zone when an attachment answer is marked provided", () => {});
```

- [ ] **Step 2: Run the client tests to verify they fail**

Run:

```bash
npx vitest run client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-detail-page.test.tsx
```

Expected: FAIL because `useLeadScoping`, `updateLeadScoping`, and the new workspace component do not exist.

- [ ] **Step 3: Add lead-scoping hooks**

Modify `client/src/hooks/use-leads.ts`:

```ts
export interface LeadScopingReadiness {
  status: "draft" | "ready" | "completed";
  isReadyForGoNoGo: boolean;
  completionState: Record<string, { isComplete: boolean; missingFields: string[]; missingAttachments: string[] }>;
  errors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
}

export interface LeadScopingIntake {
  id: string;
  leadId: string;
  officeId: string;
  status: "draft" | "ready" | "completed";
  sectionData: Record<string, unknown>;
  completionState: Record<string, { isComplete: boolean; missingFields: string[]; missingAttachments: string[] }>;
  readinessErrors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
  firstReadyAt: string | null;
  completedAt: string | null;
  lastAutosavedAt: string;
  createdAt: string;
  updatedAt: string;
}

export function useLeadScoping(leadId: string | undefined) {
  const [intake, setIntake] = useState<LeadScopingIntake | null>(null);
  const [readiness, setReadiness] = useState<LeadScopingReadiness | null>(null);
  const [loading, setLoading] = useState(true);

  const fetchScoping = useCallback(async () => {
    if (!leadId) return;
    const data = await api<{ intake: LeadScopingIntake; readiness: LeadScopingReadiness }>(`/leads/${leadId}/scoping`);
    setIntake(data.intake);
    setReadiness(data.readiness);
    setLoading(false);
  }, [leadId]);

  useEffect(() => {
    void fetchScoping();
  }, [fetchScoping]);

  return { intake, readiness, loading, refetch: fetchScoping };
}

export async function updateLeadScoping(
  leadId: string,
  sectionData: Record<string, unknown>
) {
  return api(`/leads/${leadId}/scoping`, {
    method: "PATCH",
    json: { sectionData },
  });
}
```

- [ ] **Step 4: Extend the shared file-upload client to support lead attachments**

Modify `client/src/hooks/use-files.ts`:

```ts
export interface FileRecord {
  id: string;
  dealId: string | null;
  leadId: string | null;
  contactId: string | null;
}

export interface FileFilters {
  dealId?: string;
  leadId?: string;
  contactId?: string;
}

export interface UploadFileInput {
  file: File;
  category: FileCategory;
  dealId?: string;
  leadId?: string;
  contactId?: string;
  intakeSection?: string;
  intakeRequirementKey?: string;
  intakeSource?: string;
}

if (leadId) xhr.setRequestHeader("X-Lead-Id", leadId);
if (input.intakeSection) xhr.setRequestHeader("X-Intake-Section", input.intakeSection);
if (input.intakeRequirementKey) xhr.setRequestHeader("X-Intake-Requirement-Key", input.intakeRequirementKey);
if (input.intakeSource) xhr.setRequestHeader("X-Intake-Source", input.intakeSource);
```

Modify `client/src/components/files/file-upload-zone.tsx`:

```tsx
interface FileUploadZoneProps {
  category: FileCategory;
  dealId?: string;
  leadId?: string;
  contactId?: string;
  intakeSection?: string;
  intakeRequirementKey?: string;
  intakeSource?: string;
}

await uploadFile({
  file,
  category,
  dealId,
  leadId,
  contactId,
  intakeSection,
  intakeRequirementKey,
  intakeSource,
  tags,
  onProgress,
});
```

- [ ] **Step 5: Build the lead-scoping workspace and wire it into lead detail**

Create `client/src/components/leads/lead-scoping-workspace.tsx`:

```tsx
import { Loader2, Save } from "lucide-react";
import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { updateLeadScoping, useLeadScoping } from "@/hooks/use-leads";

export function LeadScopingWorkspace({ leadId }: { leadId: string }) {
  const { intake, readiness, loading, refetch } = useLeadScoping(leadId);
  const [sectionData, setSectionData] = useState<Record<string, unknown>>({});
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    setSectionData(intake?.sectionData ?? {});
  }, [intake]);

  if (loading) {
    return (
      <Card>
        <CardContent className="flex items-center justify-center py-8">
          <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
        </CardContent>
      </Card>
    );
  }

  const blockers = Object.entries(readiness?.errors.sections ?? {}).filter(([, value]) => value.length > 0);

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Lead Scoping Checklist</CardTitle>
      </CardHeader>
      <CardContent className="space-y-6">
        <div className="rounded-lg border border-border bg-muted/30 p-3 text-sm text-muted-foreground">
          {readiness?.isReadyForGoNoGo
            ? "Ready for Lead Go/No-Go"
            : `Complete all sections before Lead Go/No-Go. Blocking sections: ${blockers.map(([key]) => key).join(", ")}`}
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-2">
            <Label>Property Name</Label>
            <Input
              value={String((sectionData.projectOverview as Record<string, unknown> | undefined)?.propertyName ?? "")}
              onChange={(event) =>
                setSectionData((current) => ({
                  ...current,
                  projectOverview: {
                    ...(current.projectOverview as Record<string, unknown> ?? {}),
                    propertyName: event.target.value,
                  },
                }))
              }
            />
          </div>
          <div className="space-y-2">
            <Label>Owner Budget Range</Label>
            <Input
              value={String((sectionData.budgetAndBidInfo as Record<string, unknown> | undefined)?.ownerBudgetRange ?? "")}
              onChange={(event) =>
                setSectionData((current) => ({
                  ...current,
                  budgetAndBidInfo: {
                    ...(current.budgetAndBidInfo as Record<string, unknown> ?? {}),
                    ownerBudgetRange: event.target.value,
                  },
                }))
              }
            />
          </div>
        </div>

        <div className="space-y-2">
          <Label>High-Level Scope Summary</Label>
          <Textarea
            value={String((sectionData.projectScopeSummary as Record<string, unknown> | undefined)?.highLevelScopeSummaryNarrative ?? "")}
            onChange={(event) =>
              setSectionData((current) => ({
                ...current,
                projectScopeSummary: {
                  ...(current.projectScopeSummary as Record<string, unknown> ?? {}),
                  highLevelScopeSummaryNarrative: event.target.value,
                },
              }))
            }
          />
        </div>

        {((sectionData.attachmentsProvided as Record<string, unknown> | undefined)?.scopeDocuments ?? null) === "provided" && (
          <div className="space-y-2">
            <Label>Scope Documents Upload</Label>
            <FileUploadZone
              category="other"
              leadId={leadId}
              intakeSection="attachmentsProvided"
              intakeRequirementKey="scopeDocuments"
              intakeSource="lead_scoping_intake"
              onUploadComplete={() => {
                void refetch();
              }}
            />
          </div>
        )}

        <Button
          disabled={saving}
          onClick={async () => {
            setSaving(true);
            await updateLeadScoping(leadId, sectionData);
            await refetch();
            setSaving(false);
          }}
        >
          {saving ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : <Save className="mr-2 h-4 w-4" />}
          Save Lead Scoping
        </Button>
      </CardContent>
    </Card>
  );
}
```

Modify `client/src/components/leads/lead-qualification-panel.tsx` to remove the `Partial Scoping` inputs and keep only:

```tsx
estimatedOpportunityValue
goDecision
goDecisionNotes
qualificationData
```

Modify `client/src/pages/leads/lead-detail-page.tsx`:

```tsx
import { LeadScopingWorkspace } from "@/components/leads/lead-scoping-workspace";

{isLeadStage && (
  <>
    <LeadQualificationPanel
      leadId={lead.id}
      onSaved={() => {
        void refetch();
      }}
    />
    <LeadScopingWorkspace leadId={lead.id} />
  </>
)}
```

- [ ] **Step 6: Re-run the client tests**

Run:

```bash
npx vitest run client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-detail-page.test.tsx
```

Expected: PASS, showing the lead workspace and blocker copy on the lead detail surface.

- [ ] **Step 7: Commit**

```bash
git add client/src/components/leads/lead-scoping-workspace.tsx client/src/components/leads/lead-qualification-panel.tsx client/src/hooks/use-leads.ts client/src/pages/leads/lead-detail-page.tsx client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-detail-page.test.tsx
git commit -m "feat: add lead scoping workspace ui"
```

---

### Task 5: Generate The Read-Only PDF Artifact And Attach It To The Deal

**Files:**
- Create: `server/src/modules/leads/scoping-artifact.ts`
- Modify: `server/src/modules/leads/conversion-service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/deals/scoping-service.ts`
- Modify: `server/src/modules/files/service.ts`
- Modify: `server/package.json`
- Modify: `package-lock.json`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/files/service.test.ts`

- [ ] **Step 1: Expand the failing conversion and files tests**

Add these cases:

In `server/tests/modules/leads/conversion-service.test.ts`:

```ts
it("creates a lead scoping pdf artifact when the lead converts", async () => {});
it("stores the artifact on the successor deal as a read-only file", async () => {});
it("seeds selected lead scoping values into the downstream deal scoping workspace", async () => {});
```

In `server/tests/modules/files/service.test.ts`:

```ts
it("creates a server-generated pdf file row for a deal", async () => {});
it("marks the generated lead scoping artifact with immutable provenance metadata", async () => {});
```

- [ ] **Step 2: Run the targeted server tests**

Run:

```bash
npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/files/service.test.ts
```

Expected: FAIL because there is no artifact generator and no server-side file helper for generated PDFs.

- [ ] **Step 3: Add the PDF generator dependency and artifact builder**

Modify `server/package.json`:

```json
{
  "dependencies": {
    "pdf-lib": "^1.17.1"
  }
}
```

Create `server/src/modules/leads/scoping-artifact.ts`:

```ts
import { PDFDocument, StandardFonts } from "pdf-lib";
import type { LeadScopingSectionData } from "@trock-crm/shared/types";

export async function renderLeadScopingArtifactPdf(input: {
  leadName: string;
  companyName: string | null;
  sectionData: LeadScopingSectionData;
}) {
  const doc = await PDFDocument.create();
  const page = doc.addPage([612, 792]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  let y = 760;

  page.drawText(`Lead Scoping Checklist - ${input.leadName}`, { x: 40, y, size: 16, font });
  y -= 28;
  page.drawText(`Company: ${input.companyName ?? "Unknown"}`, { x: 40, y, size: 11, font });
  y -= 24;

  for (const [sectionKey, sectionValue] of Object.entries(input.sectionData)) {
    page.drawText(sectionKey, { x: 40, y, size: 12, font });
    y -= 18;
    for (const [fieldKey, value] of Object.entries((sectionValue ?? {}) as Record<string, unknown>)) {
      page.drawText(`${fieldKey}: ${String(value ?? "")}`, { x: 56, y, size: 10, font });
      y -= 14;
      if (y < 72) {
        y = 760;
        doc.addPage([612, 792]);
      }
    }
    y -= 10;
  }

  return Buffer.from(await doc.save());
}
```

- [ ] **Step 4: Add a server-generated deal-file helper and attach the artifact on conversion**

Modify `server/src/modules/files/service.ts`:

```ts
import { putObject } from "../../lib/r2-client.js";

export async function createServerGeneratedDealFile(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    officeSlug: string;
    uploadedBy: string;
    displayName: string;
    systemFilename: string;
    description: string;
    category: FileCategory;
    mimeType: string;
    body: Buffer;
    tags?: string[];
    intakeSource?: string;
  }
) {
  const r2Key = `${input.officeSlug}/deals/${input.dealId}/other/${input.systemFilename}`;
  await putObject(r2Key, input.body, input.mimeType);

  const [row] = await tenantDb
    .insert(files)
    .values({
      category: input.category,
      displayName: input.displayName,
      systemFilename: input.systemFilename,
      originalFilename: input.systemFilename,
      mimeType: input.mimeType,
      fileSizeBytes: input.body.byteLength,
      fileExtension: "pdf",
      r2Key,
      r2Bucket: process.env.R2_BUCKET_NAME || "trock-crm-files",
      dealId: input.dealId,
      description: input.description,
      tags: input.tags ?? ["lead-scoping-artifact", "read-only"],
      intakeSource: input.intakeSource ?? "lead_scoping_conversion",
      uploadedBy: input.uploadedBy,
    })
    .returning();

  return row ?? null;
}
```

Modify `server/src/modules/deals/scoping-service.ts` to add a small seed helper:

```ts
export function buildSeedSectionDataFromLeadScoping(sectionData: Record<string, unknown>) {
  return {
    projectOverview: sectionData.projectOverview ?? {},
    scopeSummary: sectionData.projectScopeSummary ?? {},
    quantities: sectionData.quantities ?? {},
  };
}
```

Modify `server/src/modules/leads/conversion-service.ts`:

```ts
import { getLeadScopingIntake, getLeadScopingReadiness } from "./scoping-service.js";
import { renderLeadScopingArtifactPdf } from "./scoping-artifact.js";
import { createServerGeneratedDealFile } from "../files/service.js";
import { upsertDealScopingIntake } from "../deals/scoping-service.js";

export interface ConvertLeadInput {
  leadId: string;
  userId: string;
  userRole: string;
  officeId?: string;
  officeSlug: string;
}

const leadScoping = await getLeadScopingIntake(tenantDb, input.leadId);
const readiness = await getLeadScopingReadiness(tenantDb, input.leadId);

if (!readiness.isReadyForGoNoGo) {
  throw new AppError(409, "Lead scoping checklist must be complete before conversion");
}

const artifact = await renderLeadScopingArtifactPdf({
  leadName: lead.name,
  companyName: null,
  sectionData: (leadScoping?.sectionData as Record<string, unknown>) ?? {},
});

await createServerGeneratedDealFile(tenantDb, {
  dealId: deal.id,
  officeSlug: input.officeSlug,
  uploadedBy: input.userId,
  displayName: `Lead Scoping Checklist - ${lead.name}.pdf`,
  systemFilename: `lead-scoping-checklist-${deal.dealNumber}.pdf`,
  description: "Read-only lead scoping artifact generated during lead conversion",
  category: "other",
  mimeType: "application/pdf",
  body: artifact,
});

await upsertDealScopingIntake(
  tenantDb,
  deal.id,
  {
    sectionData: buildSeedSectionDataFromLeadScoping(
      (leadScoping?.sectionData as Record<string, unknown>) ?? {}
    ),
  },
  input.userId
);

await tenantDb
  .update(leadScopingIntake)
  .set({
    status: "completed",
    completedAt: new Date(),
    updatedAt: new Date(),
    lastEditedBy: input.userId,
  })
  .where(eq(leadScopingIntake.leadId, input.leadId));
```

Modify `server/src/modules/leads/routes.ts` so the conversion request passes the runtime office slug:

```ts
const result = await convertLead(req.tenantDb!, {
  leadId: req.params.id,
  userId: req.user!.id,
  userRole: req.user!.role,
  officeId: req.user!.activeOfficeId,
  officeSlug: req.officeSlug!,
  ...body,
});
```

- [ ] **Step 5: Re-run the targeted server tests**

Run:

```bash
npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/files/service.test.ts
```

Expected: PASS, with conversion now creating the artifact file and seeding downstream deal-scoping defaults.

- [ ] **Step 6: Commit**

```bash
git add server/src/modules/leads/scoping-artifact.ts server/src/modules/leads/conversion-service.ts server/src/modules/leads/routes.ts server/src/modules/deals/scoping-service.ts server/src/modules/files/service.ts server/package.json package-lock.json server/tests/modules/leads/conversion-service.test.ts server/tests/modules/files/service.test.ts
git commit -m "feat: attach lead scoping artifact on conversion"
```

---

### Task 6: Run Regression Coverage And End-To-End Validation

**Files:**
- Modify: `client/e2e/pipeline-workflow-alignment.spec.ts`
- Test: `server/tests/modules/leads/scoping-service.test.ts`
- Test: `server/tests/modules/leads/stage-gate.test.ts`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/files/service.test.ts`
- Test: `client/src/hooks/use-leads.test.ts`
- Test: `client/src/pages/leads/lead-detail-page.test.tsx`

- [ ] **Step 1: Add the Playwright scenario**

Modify `client/e2e/pipeline-workflow-alignment.spec.ts` to cover the lead-scoping gate:

```ts
test("requires full lead scoping before lead go-no-go and attaches artifact on conversion", async ({ page }) => {
  await page.goto("/leads");
  await page.getByRole("link", { name: /alpha roofing/i }).click();
  await expect(page.getByText(/complete all sections before Lead Go\/No-Go/i)).toBeVisible();

  await page.getByLabel("Property Name").fill("The Oaks");
  await page.getByLabel("Owner Budget Range").fill("N/A");
  await page.getByLabel("High-Level Scope Summary").fill("Exterior refresh with amenity repairs");
  await page.getByRole("button", { name: /save lead scoping/i }).click();

  await page.getByRole("button", { name: /advance to Lead Go\/No-Go/i }).click();
  await expect(page.getByText(/Lead Scoping Checklist Completed/i)).toBeVisible();

  await page.getByRole("button", { name: /convert to opportunity/i }).click();
  await page.getByRole("button", { name: /open deal/i }).click();
  await expect(page.getByText(/Lead Scoping Checklist - /i)).toBeVisible();
});
```

- [ ] **Step 2: Run the full targeted verification suite**

Run:

```bash
npx vitest run server/tests/modules/leads/scoping-service.test.ts server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/files/service.test.ts client/src/hooks/use-leads.test.ts client/src/pages/leads/lead-detail-page.test.tsx
```

Expected: PASS.

- [ ] **Step 3: Run typecheck**

Run:

```bash
npm run typecheck
```

Expected: PASS.

- [ ] **Step 4: Run the focused Playwright flow**

Run:

```bash
npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts -g "requires full lead scoping before lead go-no-go and attaches artifact on conversion"
```

Expected: PASS, with the lead blocked before Go/No-Go, then able to convert, and the generated artifact visible on the deal.

- [ ] **Step 5: Commit**

```bash
git add client/e2e/pipeline-workflow-alignment.spec.ts
git commit -m "test: cover lead scoping workflow alignment"
```

---

## Rollout Notes

- Keep `lead_qualification.scoping_subset_data` in the schema for historical records in this phase, but stop reading it as an active gate source.
- Do not attempt a destructive backfill that overwrites prior lead or deal records; partial migration into `lead_scoping_intake` is enough to preserve history while forcing new completion for future gate progression.
- Store the generated artifact in the normal deal files list with provenance tags so Operations and Sales can always inspect the original intake.
- If implementation review shows the attachment-linking model needs a lead-level file association instead of deal-only reuse, adjust the spec first, then the plan.

## Verification Checklist

- Lead detail page shows separate `Qualification Intake` and `Lead Scoping Checklist` surfaces.
- `Lead Go/No-Go` is blocked until the full lead-scoping intake is complete.
- `N/A` satisfies the checklist everywhere it is allowed.
- Attachment answers marked `provided` require an uploaded file before readiness passes.
- `scopingSubsetData` no longer allows a lead to bypass the gate.
- Conversion refuses incomplete lead scoping.
- Successful conversion seeds the downstream deal-scoping defaults and attaches a read-only PDF artifact on the deal.
- The artifact appears in the deal `Files` tab and is tagged as generated from lead conversion.

## Review Notes

- The riskiest implementation area is the artifact attachment path because the existing files service is optimized for browser presigned uploads. Keep that helper narrow: one server-side path for generated PDFs only.
- The second riskiest area is section completeness for the full PDF. Keep the readiness contract centralized in `server/src/modules/leads/scoping-rules.ts` and drive both API responses and UI blocker text from that one source.
