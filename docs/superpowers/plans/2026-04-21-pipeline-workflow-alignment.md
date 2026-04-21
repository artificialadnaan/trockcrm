# Pipeline Workflow Alignment Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the approved T Rock workflow alignment so leads move through a gated qualification kanban, every qualified lead converts into a deal at `Opportunity`, routing between `Deals` and `Service` pipelines is threshold-driven and reversible, and departmental handoffs are visible and enforceable.

**Architecture:** Extend the existing `pipeline_stage_config` + tenant `leads` / `deals` model instead of introducing a parallel workflow engine. Lead qualification data and deal-side routing history become first-class persisted records, the server owns all gate enforcement, and the client renders the same canonical checklist data returned by the APIs. The implementation keeps current downstream pipeline families intact while standardizing the lead pipeline, the `Opportunity` stage, and the dynamic `$50k` routing logic.

**Tech Stack:** TypeScript, React, Express, Drizzle ORM, PostgreSQL SQL migrations, Vitest, Playwright

---

## File Structure

### Shared schema and types

- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/public/pipeline-stage-config.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Create: `shared/src/schema/tenant/lead-qualification.ts`
- Create: `shared/src/schema/tenant/deal-routing-history.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0028_pipeline_workflow_alignment.sql`

### Server pipeline, leads, and deals

- Modify: `server/src/modules/pipeline/service.ts`
- Modify: `server/src/modules/pipeline/routes.ts`
- Modify: `server/src/modules/admin/pipeline-service.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Modify: `server/src/modules/leads/conversion-service.ts`
- Create: `server/src/modules/leads/stage-gate.ts`
- Create: `server/src/modules/leads/qualification-service.ts`
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/stage-gate.ts`
- Modify: `server/src/modules/deals/stage-change.ts`
- Modify: `server/src/modules/deals/scoping-rules.ts`
- Create: `server/src/modules/deals/routing-service.ts`

### Client lead, opportunity, and admin UI

- Modify: `client/src/App.tsx`
- Modify: `client/src/hooks/use-pipeline-config.ts`
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/hooks/use-deals.ts`
- Modify: `client/src/pages/leads/lead-list-page.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/pages/leads/lead-new-page.tsx`
- Modify: `client/src/components/leads/lead-form.tsx`
- Modify: `client/src/components/leads/lead-stage-badge.tsx`
- Create: `client/src/components/leads/lead-kanban-board.tsx`
- Create: `client/src/components/leads/lead-stage-change-dialog.tsx`
- Create: `client/src/components/leads/lead-qualification-panel.tsx`
- Create: `client/src/components/leads/lead-convert-dialog.tsx`
- Modify: `client/src/components/deals/stage-gate-checklist.tsx`
- Modify: `client/src/components/deals/deal-scoping-workspace.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `client/src/pages/admin/pipeline-config-page.tsx`
- Modify: `client/src/hooks/use-admin-pipeline.ts`
- Create: `client/src/lib/lead-stage-options.ts`

### Tests

- Modify: `server/tests/modules/leads/conversion-service.test.ts`
- Create: `server/tests/modules/leads/stage-gate.test.ts`
- Modify: `server/tests/modules/deals/stage-gate.test.ts`
- Create: `server/tests/modules/deals/routing-service.test.ts`
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`
- Create: `client/src/pages/leads/lead-list-page.test.tsx`
- Create: `client/src/components/leads/lead-stage-change-dialog.test.tsx`
- Create: `client/src/components/leads/lead-convert-dialog.test.tsx`
- Create: `client/e2e/pipeline-workflow-alignment.spec.ts`

---

### Task 1: Extend the data model for lead gates, Opportunity routing, and ownership metadata

**Files:**
- Create: `migrations/0028_pipeline_workflow_alignment.sql`
- Modify: `shared/src/types/enums.ts`
- Modify: `shared/src/schema/public/pipeline-stage-config.ts`
- Modify: `shared/src/schema/tenant/leads.ts`
- Modify: `shared/src/schema/tenant/deals.ts`
- Create: `shared/src/schema/tenant/lead-qualification.ts`
- Create: `shared/src/schema/tenant/deal-routing-history.ts`
- Modify: `shared/src/schema/index.ts`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/deals/routing-service.test.ts`

- [ ] **Step 1: Write the failing schema/type tests**

Add assertions to the existing schema-oriented tests and create a new routing-history test file that proves the new tables, enums, and seed stages exist.

```ts
it("adds ordered lead qualification stages and opportunity stage seeds", () => {
  expect(migrationSql).toMatch(/'New',\s*'lead_new',\s*1,\s*'lead'/);
  expect(migrationSql).toMatch(/'Lead Go\/No-Go',\s*'lead_go_no_go'/);
  expect(migrationSql).toMatch(/'Qualified for Opportunity',\s*'qualified_for_opportunity'/);
  expect(migrationSql).toMatch(/'Opportunity',\s*'opportunity'/);
});

it("creates deal routing history table", () => {
  expect(migrationSql).toContain("CREATE TABLE IF NOT EXISTS %I.deal_routing_history");
  expect(migrationSql).toContain("value_source");
  expect(migrationSql).toContain("from_workflow_route");
  expect(migrationSql).toContain("to_workflow_route");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts`

Expected: FAIL with missing migration/table/seed assertions.

- [ ] **Step 3: Add new enums and schema fields**

Update `shared/src/types/enums.ts` with the lead-stage slugs, routing source enum values, and expanded team roles.

```ts
export const LEAD_STAGE_SLUGS = [
  "lead_new",
  "company_pre_qualified",
  "scoping_in_progress",
  "pre_qual_value_assigned",
  "lead_go_no_go",
  "qualified_for_opportunity",
  "lead_disqualified",
] as const;

export const DEAL_ROUTE_VALUE_SOURCES = [
  "sales_estimated_opportunity_value",
  "procore_bidboard_estimate",
  "manual_override",
] as const;

export const DEAL_TEAM_ROLES = [
  "superintendent",
  "estimator",
  "project_manager",
  "client_services",
  "operations",
  "foreman",
  "other",
] as const;
```

Create focused schema tables for lead qualification payloads and routing history rather than overloading `description`.

```ts
export const leadQualification = pgTable("lead_qualification", {
  id: uuid("id").primaryKey().defaultRandom(),
  leadId: uuid("lead_id").notNull().unique(),
  estimatedOpportunityValue: numeric("estimated_opportunity_value", { precision: 14, scale: 2 }),
  goDecision: varchar("go_decision", { length: 20 }),
  goDecisionNotes: text("go_decision_notes"),
  qualificationData: jsonb("qualification_data").default({}).notNull(),
  scopingSubsetData: jsonb("scoping_subset_data").default({}).notNull(),
  disqualificationReason: varchar("disqualification_reason", { length: 100 }),
  disqualificationNotes: text("disqualification_notes"),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
});
```

```ts
export const dealRoutingHistory = pgTable("deal_routing_history", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  fromWorkflowRoute: workflowRouteEnum("from_workflow_route").notNull(),
  toWorkflowRoute: workflowRouteEnum("to_workflow_route").notNull(),
  valueSource: varchar("value_source", { length: 80 }).notNull(),
  triggeringValue: numeric("triggering_value", { precision: 14, scale: 2 }).notNull(),
  reason: text("reason"),
  changedBy: uuid("changed_by").notNull(),
  createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
});
```

- [ ] **Step 4: Write the migration**

Create `migrations/0028_pipeline_workflow_alignment.sql` to:

- seed the ordered lead stages
- seed `Opportunity` into both standard and service deal families
- add any new lead/deal columns
- create the new tenant tables
- backfill current `dd` records into `opportunity` only where appropriate

Use concrete SQL like:

```sql
INSERT INTO public.pipeline_stage_config
  (name, slug, display_order, workflow_family, is_active_pipeline, is_terminal, color)
VALUES
  ('New', 'lead_new', 1, 'lead', true, false, '#2563EB'),
  ('Company Pre-Qualified', 'company_pre_qualified', 2, 'lead', true, false, '#0EA5E9'),
  ('Scoping In Progress', 'scoping_in_progress', 3, 'lead', true, false, '#8B5CF6'),
  ('Pre-Qual Value Assigned', 'pre_qual_value_assigned', 4, 'lead', true, false, '#14B8A6'),
  ('Lead Go/No-Go', 'lead_go_no_go', 5, 'lead', true, false, '#F59E0B'),
  ('Qualified for Opportunity', 'qualified_for_opportunity', 6, 'lead', true, false, '#22C55E'),
  ('Disqualified', 'lead_disqualified', 99, 'lead', false, true, '#EF4444')
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name, display_order = EXCLUDED.display_order;
```

```sql
INSERT INTO public.pipeline_stage_config
  (name, slug, display_order, workflow_family, is_active_pipeline, is_terminal, color)
VALUES
  ('Opportunity', 'opportunity', 1, 'standard_deal', true, false, '#6366F1'),
  ('Opportunity', 'service_opportunity', 1, 'service_deal', true, false, '#6366F1')
ON CONFLICT (slug) DO UPDATE
SET name = EXCLUDED.name, display_order = EXCLUDED.display_order;
```

- [ ] **Step 5: Run tests to verify they pass**

Run: `npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts`

Expected: PASS with the new migration and schema assertions satisfied.

- [ ] **Step 6: Commit**

```bash
git add shared/src/types/enums.ts shared/src/schema/public/pipeline-stage-config.ts shared/src/schema/tenant/leads.ts shared/src/schema/tenant/deals.ts shared/src/schema/tenant/lead-qualification.ts shared/src/schema/tenant/deal-routing-history.ts shared/src/schema/index.ts migrations/0028_pipeline_workflow_alignment.sql server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts
git commit -m "feat: add workflow alignment schema"
```

---

### Task 2: Add a lead-stage gate engine and qualification persistence

**Files:**
- Create: `server/src/modules/leads/stage-gate.ts`
- Create: `server/src/modules/leads/qualification-service.ts`
- Modify: `server/src/modules/leads/service.ts`
- Modify: `server/src/modules/leads/routes.ts`
- Create: `server/tests/modules/leads/stage-gate.test.ts`
- Modify: `server/tests/modules/leads/conversion-service.test.ts`

- [ ] **Step 1: Write the failing lead gate tests**

Create `server/tests/modules/leads/stage-gate.test.ts` to prove that a lead cannot advance without the agreed field groups.

```ts
it("blocks advancement into lead_go_no_go when pre-qual value is missing", async () => {
  const result = await validateLeadStageGate(tenantDb as never, "lead-1", "stage-lead-go-no-go", "rep", "rep-1");
  expect(result.allowed).toBe(false);
  expect(result.missingRequirements.fields).toContain("estimatedOpportunityValue");
});

it("blocks conversion readiness when partial scoping subset is incomplete", async () => {
  const result = await validateLeadStageGate(tenantDb as never, "lead-1", "stage-qualified-opportunity", "rep", "rep-1");
  expect(result.allowed).toBe(false);
  expect(result.missingRequirements.fields).toContain("scopingSubset.projectOverview");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/modules/leads/stage-gate.test.ts`

Expected: FAIL because `validateLeadStageGate` does not exist yet.

- [ ] **Step 3: Implement lead qualification read/write service**

Create a focused qualification service that loads or upserts the structured lead qualification record.

```ts
export async function upsertLeadQualification(
  tenantDb: TenantDb,
  leadId: string,
  patch: {
    estimatedOpportunityValue?: string | null;
    goDecision?: "go" | "no_go" | null;
    goDecisionNotes?: string | null;
    qualificationData?: Record<string, unknown>;
    scopingSubsetData?: Record<string, unknown>;
    disqualificationReason?: string | null;
    disqualificationNotes?: string | null;
  }
) {
  const [existing] = await tenantDb
    .select()
    .from(leadQualification)
    .where(eq(leadQualification.leadId, leadId))
    .limit(1);

  const now = new Date();
  const nextQualificationData = {
    ...(existing?.qualificationData ?? {}),
    ...(patch.qualificationData ?? {}),
  };
  const nextScopingSubsetData = {
    ...(existing?.scopingSubsetData ?? {}),
    ...(patch.scopingSubsetData ?? {}),
  };

  if (existing) {
    const [updated] = await tenantDb
      .update(leadQualification)
      .set({
        estimatedOpportunityValue: patch.estimatedOpportunityValue ?? existing.estimatedOpportunityValue,
        goDecision: patch.goDecision ?? existing.goDecision,
        goDecisionNotes: patch.goDecisionNotes ?? existing.goDecisionNotes,
        qualificationData: nextQualificationData,
        scopingSubsetData: nextScopingSubsetData,
        disqualificationReason: patch.disqualificationReason ?? existing.disqualificationReason,
        disqualificationNotes: patch.disqualificationNotes ?? existing.disqualificationNotes,
        updatedAt: now,
      })
      .where(eq(leadQualification.id, existing.id))
      .returning();
    return updated;
  }

  const [created] = await tenantDb
    .insert(leadQualification)
    .values({
      leadId,
      estimatedOpportunityValue: patch.estimatedOpportunityValue ?? null,
      goDecision: patch.goDecision ?? null,
      goDecisionNotes: patch.goDecisionNotes ?? null,
      qualificationData: nextQualificationData,
      scopingSubsetData: nextScopingSubsetData,
      disqualificationReason: patch.disqualificationReason ?? null,
      disqualificationNotes: patch.disqualificationNotes ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .returning();
  return created;
}
```

- [ ] **Step 4: Implement the lead-stage gate engine**

Create `server/src/modules/leads/stage-gate.ts` mirroring the deal-stage preflight style already in the repo.

```ts
const LEAD_STAGE_REQUIREMENTS: Record<string, string[]> = {
  company_pre_qualified: ["companyId", "propertyId", "source", "stakeholderName"],
  scoping_in_progress: ["existingCustomerDecision"],
  pre_qual_value_assigned: ["projectLocation", "unitCount", "budgetStatus", "projectType", "scopeSummary"],
  lead_go_no_go: ["estimatedOpportunityValue"],
  qualified_for_opportunity: [
    "goDecision",
    "goDecisionNotes",
    "scopingSubset.projectOverview",
    "scopingSubset.propertyDetails",
    "scopingSubset.scopeSummary",
  ],
};
```

Return the same kind of checklist payload the client can render directly:

```ts
return {
  allowed,
  targetStage,
  currentStage,
  missingRequirements: {
    fields: missingFields,
    effectiveChecklist: {
      fields: requiredFields.map((field) => ({
        key: field,
        label: formatLeadGateLabel(field),
        satisfied: !missingFields.includes(field),
        source: "stage" as const,
      })),
    },
  },
};
```

- [ ] **Step 5: Wire lead PATCH requests through preflight enforcement**

In `server/src/modules/leads/service.ts` and `routes.ts`, add support for:

- qualification payload patching
- stage preflight endpoint
- enforced stage movement through the new gate engine

```ts
router.post("/:id/stage/preflight", async (req, res, next) => {
  const result = await preflightLeadStageCheck(req.tenantDb!, req.params.id, req.body.targetStageId, req.user!.role, req.user!.id);
  await req.commitTransaction!();
  res.json(result);
});
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/conversion-service.test.ts`

Expected: PASS with lead-stage enforcement and qualification persistence wired in.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/leads/stage-gate.ts server/src/modules/leads/qualification-service.ts server/src/modules/leads/service.ts server/src/modules/leads/routes.ts server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/conversion-service.test.ts
git commit -m "feat: enforce lead stage gates"
```

---

### Task 3: Make conversion always create a deal in Opportunity and add dynamic route switching

**Files:**
- Modify: `server/src/modules/leads/conversion-service.ts`
- Create: `server/src/modules/deals/routing-service.ts`
- Modify: `server/src/modules/deals/service.ts`
- Modify: `server/src/modules/deals/stage-gate.ts`
- Modify: `server/src/modules/deals/stage-change.ts`
- Modify: `server/src/modules/deals/scoping-rules.ts`
- Test: `server/tests/modules/leads/conversion-service.test.ts`
- Test: `server/tests/modules/deals/routing-service.test.ts`
- Test: `server/tests/modules/deals/stage-gate.test.ts`

- [ ] **Step 1: Write the failing routing tests**

Add tests proving:

- converted leads always land in `Opportunity`
- early routing uses the sales estimated opportunity value
- post-bid routing uses the bid estimate
- threshold crossing writes routing history and flips workflow route

```ts
it("converts every qualified lead into opportunity", async () => {
  const result = await convertLead(tenantDb as never, { leadId: "lead-1", userId: "rep-1", userRole: "rep" });
  expect(result.deal.stageId).toBe("stage-opportunity-standard");
});

it("routes below-threshold opportunity into service", async () => {
  const result = await applyOpportunityRoutingReview(tenantDb as never, {
    dealId: "deal-1",
    valueSource: "sales_estimated_opportunity_value",
    amount: "42000.00",
    userId: "rep-1",
  });
  expect(result.deal.workflowRoute).toBe("service");
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts server/tests/modules/deals/stage-gate.test.ts`

Expected: FAIL because the new routing rules are not implemented.

- [ ] **Step 3: Change conversion to resolve Opportunity stage automatically**

Update `convertLead` so callers no longer pass an arbitrary deal stage. Resolve the stage from the correct deals family and always create the successor deal in `Opportunity`.

```ts
const initialRoute = input.workflowRoute ?? "estimating";
const opportunityStage = await deps.getStageBySlug(
  initialRoute === "service" ? "service_opportunity" : "opportunity",
  initialRoute === "service" ? "service_deal" : "standard_deal"
);

const deal = await deps.createDeal(tenantDb, {
  name: input.name ?? lead.name,
  stageId: opportunityStage!.id,
  workflowRoute: initialRoute,
  sourceLeadId: lead.id,
  companyId: lead.companyId,
  propertyId: lead.propertyId,
  primaryContactId: input.primaryContactId ?? lead.primaryContactId ?? undefined,
  source: input.source ?? lead.source ?? undefined,
  description: input.description ?? lead.description ?? undefined,
});
```

- [ ] **Step 4: Implement the routing service**

Create `server/src/modules/deals/routing-service.ts` with one canonical threshold function.

```ts
export function routeForAmount(amount: string) {
  return Number(amount) < 50000 ? "service" : "estimating";
}

export async function applyOpportunityRoutingReview(
  tenantDb: TenantDb,
  input: {
    dealId: string;
    valueSource: "sales_estimated_opportunity_value" | "procore_bidboard_estimate";
    amount: string;
    userId: string;
    reason?: string;
  }
) {
  const [deal] = await tenantDb
    .select()
    .from(deals)
    .where(eq(deals.id, input.dealId))
    .limit(1)
    .for("update");

  const nextRoute = routeForAmount(input.amount);
  if (!deal || deal.workflowRoute === nextRoute) {
    return { deal, changed: false };
  }

  const nextStage = await resolveParallelStageForRoute(tenantDb, deal.stageId, nextRoute);
  const [updatedDeal] = await tenantDb
    .update(deals)
    .set({
      workflowRoute: nextRoute,
      stageId: nextStage.id,
      updatedAt: new Date(),
    })
    .where(eq(deals.id, deal.id))
    .returning();

  await tenantDb.insert(dealRoutingHistory).values({
    dealId: deal.id,
    fromWorkflowRoute: deal.workflowRoute,
    toWorkflowRoute: nextRoute,
    valueSource: input.valueSource,
    triggeringValue: input.amount,
    reason: input.reason ?? null,
    changedBy: input.userId,
  });

  return { deal: updatedDeal, changed: true };
}
```

Use family-aware stage resolution so an `Opportunity` deal stays in the equivalent stage order when switching families.

- [ ] **Step 5: Tighten deal-side Opportunity and scoping gates**

Update `server/src/modules/deals/stage-gate.ts` and `scoping-rules.ts` so:

- `Opportunity -> downstream execution` requires full scoping readiness
- `Pre-Bid Meeting` and `Site Visit Required` data are part of the opportunity readiness checklist
- route changes are driven by authoritative values, not by ad hoc manual stage edits

```ts
if (currentStage.slug === "opportunity" && ["estimating", "service_opportunity"].includes(targetStage.slug)) {
  const opportunityFields = [
    "opportunity.preBidMeetingCompleted",
    "opportunity.siteVisitDecision",
  ];

  for (const field of opportunityFields) {
    pushChecklistItem(effectiveChecklist.fields, {
      key: field,
      label: formatFieldLabel(field),
      satisfied: !missingFields.includes(field),
      source: "stage",
    });
  }
}
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts server/tests/modules/deals/stage-gate.test.ts`

Expected: PASS with conversion fixed, routing history recorded, and opportunity gates enforced.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/leads/conversion-service.ts server/src/modules/deals/routing-service.ts server/src/modules/deals/service.ts server/src/modules/deals/stage-gate.ts server/src/modules/deals/stage-change.ts server/src/modules/deals/scoping-rules.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts server/tests/modules/deals/stage-gate.test.ts
git commit -m "feat: align opportunity conversion and routing"
```

---

### Task 4: Expand admin pipeline configuration to manage workflow families and richer gate options

**Files:**
- Modify: `server/src/modules/admin/pipeline-service.ts`
- Modify: `server/src/modules/pipeline/service.ts`
- Modify: `server/src/modules/pipeline/routes.ts`
- Modify: `client/src/hooks/use-pipeline-config.ts`
- Modify: `client/src/hooks/use-admin-pipeline.ts`
- Modify: `client/src/pages/admin/pipeline-config-page.tsx`
- Create: `client/src/lib/lead-stage-options.ts`
- Test: `client/src/components/leads/lead-stage-change-dialog.test.tsx`

- [ ] **Step 1: Write the failing admin/UI tests**

Add a test proving admin pipeline data exposes workflow families and that lead gate fields are not filtered out as unknown legacy values.

```ts
it("shows workflow family badges and lead gate options", async () => {
  expect(screen.getByText("Lead")).toBeInTheDocument();
  expect(screen.getByText("Estimated Opportunity Value")).toBeInTheDocument();
  expect(screen.getByText("Stakeholder Role")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/components/leads/lead-stage-change-dialog.test.tsx`

Expected: FAIL because the new gate options and workflow family UI do not exist yet.

- [ ] **Step 3: Add family-aware pipeline APIs**

Update pipeline services and hooks so the client can ask for:

- all stages
- lead-only stages
- standard-deal stages
- service-deal stages

```ts
router.get("/stages", async (req, res, next) => {
  const workflowFamily = req.query.workflowFamily as WorkflowFamily | undefined;
  const stages = await getAllStages(workflowFamily);
  await req.commitTransaction!();
  res.json({ stages });
});
```

- [ ] **Step 4: Expand allowed gate values**

In `server/src/modules/admin/pipeline-service.ts`, expand the server-side allowlists to include the new lead qualification and opportunity fields.

```ts
export const STAGE_GATE_ALLOWED_FIELDS = [
  "primaryContactId",
  "projectTypeId",
  "description",
  "estimatedOpportunityValue",
  "stakeholderRole",
  "budgetStatus",
  "budgetQuarter",
  "qualification.projectLocation",
  "qualification.unitCount",
  "scopingSubset.projectOverview",
  "opportunity.preBidMeetingCompleted",
  "opportunity.siteVisitDecision",
] as const;
```

- [ ] **Step 5: Update admin UI to present family-aware sections**

Make `PipelineConfigPage` render separate sections or filters for `Lead`, `Deals`, and `Service`, and include the new lead gate option labels in `client/src/lib/lead-stage-options.ts`.

```ts
export const LEAD_STAGE_GATE_FIELD_OPTIONS: StageGateOption[] = [
  { value: "estimatedOpportunityValue", label: "Estimated Opportunity Value" },
  { value: "stakeholderRole", label: "Stakeholder Role" },
  { value: "budgetStatus", label: "Budget Status" },
  { value: "scopingSubset.projectOverview", label: "Scoping Subset: Project Overview" },
];
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run client/src/components/leads/lead-stage-change-dialog.test.tsx`

Expected: PASS with family-aware gate options visible.

- [ ] **Step 7: Commit**

```bash
git add server/src/modules/admin/pipeline-service.ts server/src/modules/pipeline/service.ts server/src/modules/pipeline/routes.ts client/src/hooks/use-pipeline-config.ts client/src/hooks/use-admin-pipeline.ts client/src/pages/admin/pipeline-config-page.tsx client/src/lib/lead-stage-options.ts client/src/components/leads/lead-stage-change-dialog.test.tsx
git commit -m "feat: expand pipeline admin configuration"
```

---

### Task 5: Replace the lead list with a gated kanban workflow and conversion dialog

**Files:**
- Modify: `client/src/App.tsx`
- Modify: `client/src/hooks/use-leads.ts`
- Modify: `client/src/pages/leads/lead-list-page.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.tsx`
- Modify: `client/src/pages/leads/lead-new-page.tsx`
- Modify: `client/src/components/leads/lead-form.tsx`
- Modify: `client/src/components/leads/lead-stage-badge.tsx`
- Create: `client/src/components/leads/lead-kanban-board.tsx`
- Create: `client/src/components/leads/lead-stage-change-dialog.tsx`
- Create: `client/src/components/leads/lead-qualification-panel.tsx`
- Create: `client/src/components/leads/lead-convert-dialog.tsx`
- Create: `client/src/pages/leads/lead-list-page.test.tsx`
- Modify: `client/src/pages/leads/lead-detail-page.test.tsx`
- Create: `client/src/components/leads/lead-convert-dialog.test.tsx`

- [ ] **Step 1: Write the failing lead UI tests**

Cover:

- kanban columns render in approved order
- stage advance is blocked with missing checklist items
- convert dialog only appears from `Qualified for Opportunity`

```tsx
it("renders ordered lead kanban columns", async () => {
  expect(screen.getByText("New")).toBeInTheDocument();
  expect(screen.getByText("Lead Go/No-Go")).toBeInTheDocument();
  expect(screen.getByText("Qualified for Opportunity")).toBeInTheDocument();
});

it("blocks conversion before qualified stage", async () => {
  render(<LeadConvertDialog lead={leadInScoping} open />);
  expect(screen.getByText(/must reach Qualified for Opportunity/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run client/src/pages/leads/lead-list-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/components/leads/lead-convert-dialog.test.tsx`

Expected: FAIL because the kanban and conversion flow do not exist yet.

- [ ] **Step 3: Extend the lead hooks**

Update `useLeads` to load:

- qualification payload
- stage family metadata
- preflight advance result
- conversion endpoint response without caller-supplied arbitrary `dealStageId`

```ts
export async function preflightLeadStageCheck(leadId: string, targetStageId: string) {
  return api<LeadStageGateResult>(`/leads/${leadId}/stage/preflight`, {
    method: "POST",
    json: { targetStageId },
  });
}

export async function convertLeadToOpportunity(leadId: string, input?: { workflowRoute?: WorkflowRoute }) {
  return api<{ lead: LeadRecord; deal: Deal }>(`/leads/${leadId}/convert`, {
    method: "POST",
    json: input ?? {},
  });
}
```

- [ ] **Step 4: Build the kanban board and stage-change dialog**

Create a lead kanban that groups cards by lead stage and uses the server checklist payload before every move.

```tsx
<LeadKanbanBoard
  leads={leads}
  stages={leadStages}
  onAdvance={(lead, targetStageId) => {
    setSelectedLead(lead);
    setTargetStageId(targetStageId);
    setStageDialogOpen(true);
  }}
/>
```

In the dialog, render the same checklist model used for deal-stage changes:

```tsx
<StageGateChecklist missingRequirements={preflight.missingRequirements} />
```

- [ ] **Step 5: Update lead detail and conversion UI**

Use the new qualified stage and conversion endpoint.

```tsx
<Button
  disabled={lead.currentStageSlug !== "qualified_for_opportunity"}
  onClick={() => setConvertDialogOpen(true)}
>
  Convert to Opportunity
</Button>
```

The convert dialog should explain that the successor record always starts in `Opportunity`, not an arbitrary downstream deal stage.

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run client/src/pages/leads/lead-list-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/components/leads/lead-convert-dialog.test.tsx`

Expected: PASS with the new lead kanban and conversion workflow.

- [ ] **Step 7: Commit**

```bash
git add client/src/App.tsx client/src/hooks/use-leads.ts client/src/pages/leads/lead-list-page.tsx client/src/pages/leads/lead-detail-page.tsx client/src/pages/leads/lead-new-page.tsx client/src/components/leads/lead-form.tsx client/src/components/leads/lead-stage-badge.tsx client/src/components/leads/lead-kanban-board.tsx client/src/components/leads/lead-stage-change-dialog.tsx client/src/components/leads/lead-qualification-panel.tsx client/src/components/leads/lead-convert-dialog.tsx client/src/pages/leads/lead-list-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/components/leads/lead-convert-dialog.test.tsx
git commit -m "feat: add gated lead kanban workflow"
```

---

### Task 6: Add Opportunity routing controls, department visibility, and family-aware deal UX

**Files:**
- Modify: `client/src/hooks/use-deals.ts`
- Modify: `client/src/components/deals/stage-gate-checklist.tsx`
- Modify: `client/src/components/deals/deal-scoping-workspace.tsx`
- Modify: `client/src/pages/deals/deal-detail-page.tsx`
- Modify: `client/src/pages/deals/deal-team-tab.tsx`
- Test: `server/tests/modules/deals/stage-gate.test.ts`
- Test: `client/src/components/leads/lead-stage-change-dialog.test.tsx`

- [ ] **Step 1: Write the failing Opportunity UX tests**

Cover:

- Opportunity shows early routing review state
- scoping panel exposes pre-bid meeting and site visit fields
- Sales can still see routing and ownership after handoff

```ts
it("shows opportunity routing review controls before downstream progression", async () => {
  expect(screen.getByText(/Early Routing Review/i)).toBeInTheDocument();
  expect(screen.getByText(/Post-Bid Routing Review/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npx vitest run server/tests/modules/deals/stage-gate.test.ts client/src/components/leads/lead-stage-change-dialog.test.tsx`

Expected: FAIL because opportunity routing controls are not rendered or enforced.

- [ ] **Step 3: Extend deal hooks and detail payload**

Add routing history, route review endpoints, and ownership metadata to the deal hook types.

```ts
export interface DealRoutingHistoryEntry {
  id: string;
  fromWorkflowRoute: WorkflowRoute;
  toWorkflowRoute: WorkflowRoute;
  valueSource: string;
  triggeringValue: string;
  reason: string | null;
  createdAt: string;
}
```

```ts
export async function applyOpportunityRoutingReview(
  dealId: string,
  input: { valueSource: string; amount: string; reason?: string }
) {
  return api<{ deal: DealDetail }>(`/deals/${dealId}/routing-review`, {
    method: "POST",
    json: input,
  });
}
```

- [ ] **Step 4: Upgrade the scoping workspace for Opportunity**

In `client/src/components/deals/deal-scoping-workspace.tsx`, add:

- pre-bid meeting completed
- estimator consultation notes
- site visit required decision
- site visit completed state
- current threshold review summary

```tsx
<Select value={siteVisitDecision} onValueChange={setSiteVisitDecision}>
  <SelectItem value="required">Site Visit Required</SelectItem>
  <SelectItem value="not_required">No Site Visit Required</SelectItem>
</Select>
```

- [ ] **Step 5: Keep Sales visibility through downstream ownership**

Update `deal-detail-page.tsx` and `deal-team-tab.tsx` so:

- current accountable department is always visible
- Sales can see the full stage history and route changes
- new team roles `client_services` and `operations` render cleanly

```tsx
<Badge variant="outline">
  Accountable Department: {deal.currentDepartmentOwner ?? "Sales"}
</Badge>
```

- [ ] **Step 6: Run tests to verify they pass**

Run: `npx vitest run server/tests/modules/deals/stage-gate.test.ts client/src/components/leads/lead-stage-change-dialog.test.tsx`

Expected: PASS with Opportunity routing controls and department visibility rendered.

- [ ] **Step 7: Commit**

```bash
git add client/src/hooks/use-deals.ts client/src/components/deals/stage-gate-checklist.tsx client/src/components/deals/deal-scoping-workspace.tsx client/src/pages/deals/deal-detail-page.tsx client/src/pages/deals/deal-team-tab.tsx server/tests/modules/deals/stage-gate.test.ts client/src/components/leads/lead-stage-change-dialog.test.tsx
git commit -m "feat: expose opportunity routing and handoff visibility"
```

---

### Task 7: Verify the full workflow with automated tests and Playwright coverage

**Files:**
- Create: `client/e2e/pipeline-workflow-alignment.spec.ts`
- Modify: `package.json`
- Test: `client/e2e/pipeline-workflow-alignment.spec.ts`

- [ ] **Step 1: Write the failing Playwright scenario**

Create a full-path regression that:

- creates a lead
- advances through every lead stage with gates
- converts into `Opportunity`
- tests an early under-`$50k` route into Service
- updates the authoritative value above `50k`
- verifies reroute into Deals
- advances through deal stages with checklist enforcement

```ts
test("lead and deal workflow alignment end-to-end", async ({ page }) => {
  await page.goto("/leads");
  await page.getByRole("button", { name: "New Lead" }).click();
  await page.getByLabel("Lead Name").fill("Workflow E2E Lead");
  await page.getByLabel("Project Location").fill("Dallas, TX");
  await page.getByLabel("Units").fill("120");
  await page.getByRole("button", { name: "Advance to Company Pre-Qualified" }).click();
  await page.getByRole("button", { name: "Advance to Lead Go/No-Go" }).click();
  await page.getByRole("button", { name: "Convert to Opportunity" }).click();
  await expect(page.getByText("Opportunity")).toBeVisible();
  await expect(page.getByText("Service")).toBeVisible();
});
```

- [ ] **Step 2: Run Playwright to verify it fails**

Run: `npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts`

Expected: FAIL because the aligned UI and gating behavior are not implemented yet.

- [ ] **Step 3: Wire any missing test helpers or scripts**

If the repo needs a dedicated script entry, add it in `package.json`.

```json
{
  "scripts": {
    "test:e2e:pipeline": "playwright test client/e2e/pipeline-workflow-alignment.spec.ts"
  }
}
```

- [ ] **Step 4: Run the full verification matrix**

Run:

```bash
npm run typecheck
npx vitest run server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts server/tests/modules/deals/stage-gate.test.ts client/src/pages/leads/lead-list-page.test.tsx client/src/pages/leads/lead-detail-page.test.tsx client/src/components/leads/lead-convert-dialog.test.tsx
npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts
```

Expected:

- typecheck exits `0`
- targeted Vitest suites pass
- Playwright scenario passes

- [ ] **Step 5: Commit**

```bash
git add client/e2e/pipeline-workflow-alignment.spec.ts package.json
git commit -m "test: cover workflow alignment end to end"
```

---

### Task 8: Review, deploy, browser-validate, and merge

**Files:**
- Modify: only if issues are found during review or browser validation
- Test: deployment and Playwright/browser checks against the redeployed app

- [ ] **Step 1: Run the local review loop before deployment**

Run:

```bash
git diff --check
npm run typecheck
npx vitest run server/tests/modules/leads/stage-gate.test.ts server/tests/modules/leads/conversion-service.test.ts server/tests/modules/deals/routing-service.test.ts server/tests/modules/deals/stage-gate.test.ts
npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts
```

Expected:

- `git diff --check` prints nothing
- typecheck exits `0`
- all targeted tests pass
- Playwright passes locally

- [ ] **Step 2: Deploy and verify the redeployed environment**

Run the project’s deployment command once implementation is merged into the release branch. Use the repo’s existing deployment path rather than inventing a new one.

Run:

```bash
railway up
```

Expected: successful deploy output with the new build active.

- [ ] **Step 3: Run post-deploy browser validation**

Open the deployed UI and validate with Playwright or the existing browser workflow:

- create a lead with test data
- try advancing without required answers and confirm gate blocks
- fill the lead qualification and partial scoping fields
- move the lead through every lead stage
- convert it to `Opportunity`
- route it under `$50k` into Service
- update the authoritative amount above `$50k`
- confirm reroute into Deals
- move through the deal stages and confirm scoping/deal gates
- confirm Sales visibility remains intact after handoffs

Run:

```bash
npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts --headed
```

Expected: PASS against the redeployed environment with the UI behaving correctly.

- [ ] **Step 4: Fix any review or browser issues before merge**

If any step above fails:

- write or update the failing test first
- reproduce locally
- implement the smallest fix
- rerun the exact failed command
- rerun the full verification matrix

Use the same red-green cycle for every post-review bug.

- [ ] **Step 5: Merge to main only after clean verification**

Run:

```bash
git checkout main
git merge --ff-only feat/pipeline-workflow-alignment
git push
```

Expected:

- fast-forward merge succeeds
- push succeeds

- [ ] **Step 6: Final post-merge verification**

Run:

```bash
npm run typecheck
npx playwright test client/e2e/pipeline-workflow-alignment.spec.ts
```

Expected: still green after merge and push.

---

## Spec Coverage Check

- Lead qualification stages: covered by Tasks 1, 2, and 5.
- Required qualification forms and partial scoping: covered by Tasks 2 and 5.
- Conversion to `Opportunity` only: covered by Task 3.
- Dynamic `$50k` routing with two review points: covered by Tasks 3 and 6.
- Separate `Deals` and `Service` pipelines: covered by Tasks 1, 3, and 4.
- Department ownership and Sales visibility: covered by Task 6.
- Opportunity full scoping gate: covered by Tasks 3 and 6.
- Admin stage-gate management: covered by Task 4.
- End-to-end browser validation and deployment: covered by Tasks 7 and 8.

## Placeholder Scan

- No `TODO`, `TBD`, or “implement later” placeholders remain.
- Each task includes concrete file paths, commands, and code snippets.
- Every verification claim maps to a runnable command.

## Type Consistency Check

- Lead qualification uses `estimatedOpportunityValue` on the lead side.
- Routing review uses `valueSource` values `sales_estimated_opportunity_value` and `procore_bidboard_estimate`.
- Deal-side initial stage resolution uses `opportunity` / `service_opportunity`.
- `client_services` and `operations` are the new downstream ownership/team role labels used consistently across schema and UI.
