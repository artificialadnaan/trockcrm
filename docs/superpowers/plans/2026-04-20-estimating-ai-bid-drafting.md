# Estimating AI Bid Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-estimating workflow that ingests uploaded plans, syncs the Procore cost catalog into local tables, generates OCR-backed scope rows, matches them to catalog and historical estimate data, recommends prices, and promotes approved rows into the existing estimate model for estimator review.

**Architecture:** Extend the existing Procore and estimating modules rather than creating a parallel system. The backend adds catalog-sync, document-ingestion, extraction, matching, pricing, and draft-generation services with worker jobs for asynchronous processing. The frontend adds new estimating workflow views inside the existing estimating tab and reuses the current estimate sections and line items as the canonical final estimate.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, worker jobs, Vitest

---

## File Structure

- Create: `migrations/0020_cost_catalog_and_estimate_generation.sql`
  Responsibility: add local Procore-backed catalog tables and project-specific estimate generation tables.
- Create: `shared/src/schema/public/cost-catalog-sources.ts`
  Responsibility: schema for catalog source metadata and sync runs.
- Create: `shared/src/schema/public/cost-catalog-items.ts`
  Responsibility: schema for catalog items, codes, item-code mappings, and prices.
- Create: `shared/src/schema/tenant/estimate-source-documents.ts`
  Responsibility: schema for uploaded estimating documents and document pages.
- Create: `shared/src/schema/tenant/estimate-extractions.ts`
  Responsibility: schema for structured extraction rows, matches, pricing recommendations, generation runs, and review events.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new public and tenant estimating schemas.
- Modify: `server/src/modules/procore/sync-service.ts`
  Responsibility: add catalog-sync orchestration using existing Procore integration patterns.
- Create: `server/src/modules/procore/catalog-sync-service.ts`
  Responsibility: normalize Procore catalog payloads into local catalog tables.
- Modify: `worker/src/jobs/procore-sync.ts`
  Responsibility: invoke the catalog sync path during Procore sync runs.
- Create: `server/src/modules/estimating/document-service.ts`
  Responsibility: create uploaded estimating documents and queue OCR/indexing.
- Create: `server/src/modules/estimating/extraction-service.ts`
  Responsibility: normalize OCR output into extraction records.
- Create: `server/src/modules/estimating/matching-service.ts`
  Responsibility: rank catalog and historical estimate matches for extraction rows.
- Create: `server/src/modules/estimating/pricing-service.ts`
  Responsibility: generate pricing recommendations from catalog, history, and market adjustments.
- Create: `server/src/modules/estimating/draft-estimate-service.ts`
  Responsibility: promote approved pricing recommendations into estimate sections and estimate line items.
- Modify: `server/src/modules/deals/estimate-service.ts`
  Responsibility: support generation-aware estimate imports without breaking existing manual editing.
- Create: `server/src/modules/estimating/routes.ts`
  Responsibility: API routes for document upload, extraction review, matching review, pricing review, and draft promotion.
- Modify: `server/src/app.ts` or the module registration entrypoint currently used by the API
  Responsibility: mount the new estimating routes.
- Create: `worker/src/jobs/estimate-document-ocr.ts`
  Responsibility: OCR and page extraction job for estimating documents.
- Create: `worker/src/jobs/estimate-generation.ts`
  Responsibility: extraction, matching, and pricing orchestration job.
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
  Responsibility: host the new estimating workflow inside the existing estimate tab.
- Create: `client/src/components/estimating/estimating-workflow-shell.tsx`
  Responsibility: orchestrate workflow sections and status.
- Create: `client/src/components/estimating/estimate-documents-panel.tsx`
  Responsibility: upload and list source documents.
- Create: `client/src/components/estimating/estimate-extraction-review-table.tsx`
  Responsibility: review/edit extraction rows and match status.
- Create: `client/src/components/estimating/estimate-pricing-review-table.tsx`
  Responsibility: review/edit pricing recommendations before promotion.
- Create: `client/src/components/estimating/estimate-copilot-panel.tsx`
  Responsibility: estimator advisory prompts and answers.
- Create: `server/tests/modules/procore/catalog-sync-service.test.ts`
  Responsibility: validate Procore payload normalization and upserts.
- Create: `server/tests/modules/estimating/document-service.test.ts`
  Responsibility: validate document creation and OCR job enqueue behavior.
- Create: `server/tests/modules/estimating/matching-service.test.ts`
  Responsibility: validate catalog and historical estimate ranking.
- Create: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: validate pricing recommendation calculations.
- Create: `server/tests/modules/estimating/draft-estimate-service.test.ts`
  Responsibility: validate promotion into estimate sections and line items.
- Create: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: validate major workflow states and actions.

## Task 1: Add Catalog and Estimate-Generation Storage

**Files:**
- Create: `migrations/0020_cost_catalog_and_estimate_generation.sql`
- Create: `shared/src/schema/public/cost-catalog-sources.ts`
- Create: `shared/src/schema/public/cost-catalog-items.ts`
- Create: `shared/src/schema/tenant/estimate-source-documents.ts`
- Create: `shared/src/schema/tenant/estimate-extractions.ts`
- Modify: `shared/src/schema/index.ts`
- Test: `server/tests/modules/estimating/pricing-service.test.ts`

- [ ] **Step 1: Write a failing schema-adjacent pricing test**

```ts
import { describe, expect, it } from "vitest";
import { buildPricingRecommendation } from "../../../src/modules/estimating/pricing-service.js";

describe("buildPricingRecommendation", () => {
  it("prefers historical pricing over catalog baseline when strong comps exist", () => {
    const result = buildPricingRecommendation({
      quantity: 10,
      catalogBaselinePrice: 100,
      historicalPrices: [112, 118, 120],
      marketAdjustmentPercent: 0,
    });

    expect(result.recommendedUnitPrice).toBe(118);
    expect(result.priceBasis).toBe("historical_median");
  });
});
```

- [ ] **Step 2: Run the focused test to verify the missing implementation fails**

Run: `npx vitest run server/tests/modules/estimating/pricing-service.test.ts`

Expected: FAIL because `pricing-service.ts` and the new schema exports do not exist yet.

- [ ] **Step 3: Add the migration for catalog and estimate-generation tables**

```sql
CREATE TABLE IF NOT EXISTS public.cost_catalog_sources (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  provider text NOT NULL,
  external_account_id text,
  name text NOT NULL,
  status text NOT NULL DEFAULT 'active',
  last_synced_at timestamptz,
  last_successful_sync_at timestamptz,
  default_currency text NOT NULL DEFAULT 'USD',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS tenant.estimate_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  status text NOT NULL DEFAULT 'pending',
  input_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz
);
```

- [ ] **Step 4: Add the Drizzle schema files and exports**

```ts
export const estimateGenerationRuns = tenantTable("estimate_generation_runs", {
  id: uuid("id").primaryKey().defaultRandom(),
  dealId: uuid("deal_id").notNull(),
  projectId: uuid("project_id"),
  status: text("status").notNull().default("pending"),
  inputSnapshotJson: jsonb("input_snapshot_json").notNull().default(sql`'{}'::jsonb`),
  outputSummaryJson: jsonb("output_summary_json").notNull().default(sql`'{}'::jsonb`),
  errorSummary: text("error_summary"),
  startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
  completedAt: timestamp("completed_at", { withTimezone: true }),
});
```

- [ ] **Step 5: Re-run the focused pricing test to confirm the module is now loadable**

Run: `npx vitest run server/tests/modules/estimating/pricing-service.test.ts`

Expected: FAIL on pricing logic assertions instead of import or schema-export errors.

- [ ] **Step 6: Commit the storage layer**

```bash
git add migrations/0020_cost_catalog_and_estimate_generation.sql shared/src/schema/public/cost-catalog-sources.ts shared/src/schema/public/cost-catalog-items.ts shared/src/schema/tenant/estimate-source-documents.ts shared/src/schema/tenant/estimate-extractions.ts shared/src/schema/index.ts server/tests/modules/estimating/pricing-service.test.ts
git commit -m "feat: add catalog and estimate generation storage"
```

## Task 2: Sync the Procore Catalog Into Local Tables

**Files:**
- Create: `server/src/modules/procore/catalog-sync-service.ts`
- Modify: `server/src/modules/procore/sync-service.ts`
- Modify: `worker/src/jobs/procore-sync.ts`
- Test: `server/tests/modules/procore/catalog-sync-service.test.ts`

- [ ] **Step 1: Write failing normalization tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeCatalogItem } from "../../../src/modules/procore/catalog-sync-service.js";

describe("normalizeCatalogItem", () => {
  it("maps Procore item payload fields into the local catalog shape", () => {
    const result = normalizeCatalogItem({
      id: "item-1",
      name: "Parapet Wall Flashing",
      unit_of_measure: "ft",
      unit_cost: 45,
      item_type: "Labor",
      cost_code: { code: "07-100", name: "Damproofing and Waterproofing" },
    } as any);

    expect(result.item.externalId).toBe("item-1");
    expect(result.item.unit).toBe("ft");
    expect(result.price.laborUnitCost).toBe("45");
    expect(result.code.code).toBe("07-100");
  });
});
```

- [ ] **Step 2: Run the catalog test**

Run: `npx vitest run server/tests/modules/procore/catalog-sync-service.test.ts`

Expected: FAIL because the catalog sync service does not exist yet.

- [ ] **Step 3: Implement the Procore payload normalization helpers**

```ts
export function normalizeCatalogItem(payload: any) {
  return {
    item: {
      externalId: String(payload.id),
      itemType: payload.item_type ?? "unknown",
      name: payload.name?.trim() ?? "Unnamed item",
      description: payload.description ?? null,
      unit: payload.unit_of_measure ?? null,
      catalogName: payload.catalog_name ?? "Procore",
      manufacturer: payload.manufacturer ?? null,
      supplier: payload.supplier ?? null,
      taxable: payload.taxable === true,
    },
    code: payload.cost_code
      ? {
          externalId: String(payload.cost_code.id ?? payload.cost_code.code),
          code: payload.cost_code.code,
          name: payload.cost_code.name ?? payload.cost_code.code,
        }
      : null,
    price: {
      blendedUnitCost: payload.unit_cost != null ? String(payload.unit_cost) : null,
      laborUnitCost: payload.labor_unit_cost != null ? String(payload.labor_unit_cost) : null,
    },
  };
}
```

- [ ] **Step 4: Wire catalog sync into the existing Procore sync flow**

```ts
export async function runProcoreSync(deps: SyncDeps) {
  await syncCompanies(deps);
  await syncProjects(deps);
  await syncCostCatalog(deps);
}
```

- [ ] **Step 5: Re-run the catalog test and the broader Procore tests**

Run: `npx vitest run server/tests/modules/procore/catalog-sync-service.test.ts server/tests/modules/procore/*.test.ts`

Expected: PASS for the new catalog test, existing Procore tests remain green.

- [ ] **Step 6: Commit the catalog sync task**

```bash
git add server/src/modules/procore/catalog-sync-service.ts server/src/modules/procore/sync-service.ts worker/src/jobs/procore-sync.ts server/tests/modules/procore/catalog-sync-service.test.ts
git commit -m "feat: sync procore cost catalog into local tables"
```

## Task 3: Add Estimating Document Upload and OCR Queueing

**Files:**
- Create: `server/src/modules/estimating/document-service.ts`
- Create: `server/src/modules/estimating/routes.ts`
- Create: `worker/src/jobs/estimate-document-ocr.ts`
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
- Create: `client/src/components/estimating/estimate-documents-panel.tsx`
- Test: `server/tests/modules/estimating/document-service.test.ts`

- [ ] **Step 1: Write the failing document-service tests**

```ts
import { describe, expect, it, vi } from "vitest";
import { createEstimateSourceDocument } from "../../../src/modules/estimating/document-service.js";

describe("createEstimateSourceDocument", () => {
  it("creates an uploaded estimating document and queues OCR", async () => {
    const enqueue = vi.fn().mockResolvedValue(undefined);
    const result = await createEstimateSourceDocument({
      tenantDb: {} as any,
      enqueueEstimateDocumentOcr: enqueue,
      input: {
        dealId: "deal-1",
        filename: "plans.pdf",
        storageKey: "uploads/plans.pdf",
        mimeType: "application/pdf",
      },
    });

    expect(result.filename).toBe("plans.pdf");
    expect(enqueue).toHaveBeenCalledOnce();
  });
});
```

- [ ] **Step 2: Run the new tests**

Run: `npx vitest run server/tests/modules/estimating/document-service.test.ts`

Expected: FAIL because the estimating document service does not exist yet.

- [ ] **Step 3: Implement document creation and OCR queueing**

```ts
export async function createEstimateSourceDocument({
  tenantDb,
  enqueueEstimateDocumentOcr,
  input,
}: CreateEstimateSourceDocumentArgs) {
  const [document] = await tenantDb
    .insert(estimateSourceDocuments)
    .values({
      dealId: input.dealId,
      projectId: input.projectId ?? null,
      documentType: input.documentType ?? "plan",
      filename: input.filename,
      storageKey: input.storageKey,
      mimeType: input.mimeType,
      fileSize: input.fileSize ?? null,
      contentHash: input.contentHash ?? null,
      ocrStatus: "queued",
      uploadedByUserId: input.userId,
    })
    .returning();

  await enqueueEstimateDocumentOcr({ documentId: document.id, dealId: document.dealId });
  return document;
}
```

- [ ] **Step 4: Add routes and a document upload panel in the estimate tab**

```ts
router.post("/deals/:dealId/estimating/documents", async (req, res) => {
  const document = await createEstimateSourceDocument({
    tenantDb: req.tenantDb,
    enqueueEstimateDocumentOcr,
    input: {
      dealId: req.params.dealId,
      filename: req.body.filename,
      storageKey: req.body.storageKey,
      mimeType: req.body.mimeType,
      userId: req.user.id,
    },
  });

  res.status(201).json({ document });
});
```

- [ ] **Step 5: Re-run the focused service tests and a client typecheck**

Run: `npx vitest run server/tests/modules/estimating/document-service.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit the upload and OCR queueing task**

```bash
git add server/src/modules/estimating/document-service.ts server/src/modules/estimating/routes.ts worker/src/jobs/estimate-document-ocr.ts client/src/pages/deals/deal-estimates-tab.tsx client/src/components/estimating/estimate-documents-panel.tsx server/tests/modules/estimating/document-service.test.ts
git commit -m "feat: add estimating document upload and ocr queueing"
```

## Task 4: Build Extraction, Matching, and Pricing Services

**Files:**
- Create: `server/src/modules/estimating/extraction-service.ts`
- Create: `server/src/modules/estimating/matching-service.ts`
- Create: `server/src/modules/estimating/pricing-service.ts`
- Create: `worker/src/jobs/estimate-generation.ts`
- Test: `server/tests/modules/estimating/matching-service.test.ts`
- Test: `server/tests/modules/estimating/pricing-service.test.ts`

- [ ] **Step 1: Write failing matching and pricing tests**

```ts
describe("rankExtractionMatches", () => {
  it("ranks exact catalog-unit matches above fuzzy label-only matches", async () => {
    const results = await rankExtractionMatches({
      extraction: { normalizedLabel: "parapet wall flashing", unit: "ft" } as any,
      catalogItems: [
        { id: "a", name: "Parapet Wall Flashing", unit: "ft" },
        { id: "b", name: "Flashing", unit: "ea" },
      ] as any,
      historicalItems: [],
    });

    expect(results[0]?.catalogItemId).toBe("a");
  });
});
```

```ts
describe("buildPricingRecommendation", () => {
  it("applies market adjustments after selecting the base recommendation", () => {
    const result = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      marketAdjustmentPercent: 10,
    });

    expect(result.recommendedUnitPrice).toBe(127.6);
    expect(result.marketAdjustmentPercent).toBe(10);
  });
});
```

- [ ] **Step 2: Run the matching and pricing tests**

Run: `npx vitest run server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts`

Expected: FAIL because the matching and pricing services do not exist yet.

- [ ] **Step 3: Implement the extraction normalization and matching logic**

```ts
export async function rankExtractionMatches({
  extraction,
  catalogItems,
  historicalItems,
}: RankExtractionMatchesArgs) {
  const normalizedLabel = extraction.normalizedLabel.toLowerCase();

  return [...catalogItems]
    .map((item) => ({
      catalogItemId: item.id,
      matchScore:
        (item.name.toLowerCase() === normalizedLabel ? 70 : 0) +
        (item.unit && extraction.unit && item.unit === extraction.unit ? 20 : 0) +
        (item.name.toLowerCase().includes(normalizedLabel) ? 10 : 0),
    }))
    .sort((a, b) => b.matchScore - a.matchScore);
}
```

- [ ] **Step 4: Implement pricing recommendations and orchestrate them in the generation job**

```ts
export function buildPricingRecommendation(input: BuildPricingRecommendationInput) {
  const historicalMedian = input.historicalPrices.length
    ? [...input.historicalPrices].sort((a, b) => a - b)[Math.floor(input.historicalPrices.length / 2)]
    : null;

  const base = historicalMedian ?? input.catalogBaselinePrice ?? 0;
  const adjusted = Number((base * (1 + input.marketAdjustmentPercent / 100)).toFixed(2));

  return {
    priceBasis: historicalMedian != null ? "historical_median" : "catalog_baseline",
    recommendedUnitPrice: adjusted,
    recommendedTotalPrice: Number((adjusted * input.quantity).toFixed(2)),
    historicalMedianPrice: historicalMedian,
    marketAdjustmentPercent: input.marketAdjustmentPercent,
  };
}
```

- [ ] **Step 5: Re-run the matching and pricing tests**

Run: `npx vitest run server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the extraction, matching, and pricing task**

```bash
git add server/src/modules/estimating/extraction-service.ts server/src/modules/estimating/matching-service.ts server/src/modules/estimating/pricing-service.ts worker/src/jobs/estimate-generation.ts server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts
git commit -m "feat: add estimate extraction matching and pricing services"
```

## Task 5: Promote Approved Draft Rows Into the Existing Estimate Model

**Files:**
- Create: `server/src/modules/estimating/draft-estimate-service.ts`
- Modify: `server/src/modules/deals/estimate-service.ts`
- Modify: `server/src/modules/estimating/routes.ts`
- Test: `server/tests/modules/estimating/draft-estimate-service.test.ts`

- [ ] **Step 1: Write a failing promotion test**

```ts
import { describe, expect, it, vi } from "vitest";
import { promoteApprovedRecommendationsToEstimate } from "../../../src/modules/estimating/draft-estimate-service.js";

describe("promoteApprovedRecommendationsToEstimate", () => {
  it("creates estimate sections and line items from approved recommendations", async () => {
    const tenantDb = {
      insert: vi.fn().mockReturnValue({
        values: vi.fn().mockReturnValue({
          returning: vi.fn().mockResolvedValue([{ id: "section-1" }]),
        }),
      }),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      recommendations: [
        { sectionName: "Roofing", description: "Parapet Wall Flashing", quantity: "10", unit: "ft", unitPrice: "118" },
      ] as any,
    });

    expect(tenantDb.insert).toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run the promotion test**

Run: `npx vitest run server/tests/modules/estimating/draft-estimate-service.test.ts`

Expected: FAIL because the draft estimate service does not exist yet.

- [ ] **Step 3: Implement promotion into estimate sections and line items**

```ts
export async function promoteApprovedRecommendationsToEstimate({
  tenantDb,
  dealId,
  recommendations,
}: PromoteApprovedRecommendationsArgs) {
  const sectionIds = new Map<string, string>();

  for (const recommendation of recommendations) {
    let sectionId = sectionIds.get(recommendation.sectionName);
    if (!sectionId) {
      const [section] = await tenantDb
        .insert(estimateSections)
        .values({ dealId, name: recommendation.sectionName })
        .returning();
      sectionId = section.id;
      sectionIds.set(recommendation.sectionName, sectionId);
    }

    await tenantDb.insert(estimateLineItems).values({
      sectionId,
      description: recommendation.description,
      quantity: recommendation.quantity,
      unit: recommendation.unit,
      unitPrice: recommendation.unitPrice,
      totalPrice: String(Number(recommendation.quantity) * Number(recommendation.unitPrice)),
      notes: recommendation.notes ?? null,
    });
  }
}
```

- [ ] **Step 4: Add the promotion route**

```ts
router.post("/deals/:dealId/estimating/promote", async (req, res) => {
  await promoteApprovedRecommendationsToEstimate({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    recommendations: req.body.recommendations,
  });

  res.status(200).json({ ok: true });
});
```

- [ ] **Step 5: Re-run the promotion test and current estimate-service tests**

Run: `npx vitest run server/tests/modules/estimating/draft-estimate-service.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit the draft estimate promotion task**

```bash
git add server/src/modules/estimating/draft-estimate-service.ts server/src/modules/deals/estimate-service.ts server/src/modules/estimating/routes.ts server/tests/modules/estimating/draft-estimate-service.test.ts
git commit -m "feat: promote approved estimate recommendations into estimates"
```

## Task 6: Add the Estimating Workflow UI and Advisory Copilot

**Files:**
- Create: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Create: `client/src/components/estimating/estimate-extraction-review-table.tsx`
- Create: `client/src/components/estimating/estimate-pricing-review-table.tsx`
- Create: `client/src/components/estimating/estimate-copilot-panel.tsx`
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
- Test: `client/src/components/estimating/estimating-workflow-shell.test.tsx`

- [ ] **Step 1: Write a failing UI workflow test**

```tsx
import { render, screen } from "@testing-library/react";
import { EstimatingWorkflowShell } from "./estimating-workflow-shell";

it("shows the document upload and pricing review states", () => {
  render(
    <EstimatingWorkflowShell
      dealId="deal-1"
      documents={[]}
      extractionRows={[]}
      pricingRows={[]}
      copilotEnabled
    />
  );

  expect(screen.getByText("Documents")).toBeInTheDocument();
  expect(screen.getByText("Draft Pricing")).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the UI test**

Run: `npx vitest run client/src/components/estimating/estimating-workflow-shell.test.tsx`

Expected: FAIL because the workflow shell does not exist yet.

- [ ] **Step 3: Implement the workflow shell and review tables**

```tsx
export function EstimatingWorkflowShell(props: EstimatingWorkflowShellProps) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 text-sm">
        {["Documents", "Extraction", "Catalog Match", "Draft Pricing", "Estimate", "Copilot"].map(
          (step) => (
            <div key={step} className="rounded-full border px-3 py-1">
              {step}
            </div>
          )
        )}
      </nav>

      <EstimateDocumentsPanel dealId={props.dealId} documents={props.documents} />
      <EstimateExtractionReviewTable rows={props.extractionRows} />
      <EstimatePricingReviewTable rows={props.pricingRows} />
      {props.copilotEnabled ? <EstimateCopilotPanel dealId={props.dealId} /> : null}
    </div>
  );
}
```

- [ ] **Step 4: Integrate the workflow shell into the existing estimate tab**

```tsx
return (
  <div className="space-y-6">
    <EstimatingWorkflowShell
      dealId={dealId}
      documents={documents}
      extractionRows={extractionRows}
      pricingRows={pricingRows}
      copilotEnabled
    />
    <ExistingEstimateEditor sections={sections} onRefresh={fetchEstimates} />
  </div>
);
```

- [ ] **Step 5: Re-run the UI test and the workspace typecheck**

Run: `npx vitest run client/src/components/estimating/estimating-workflow-shell.test.tsx`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 6: Commit the workflow UI task**

```bash
git add client/src/components/estimating/estimating-workflow-shell.tsx client/src/components/estimating/estimate-extraction-review-table.tsx client/src/components/estimating/estimate-pricing-review-table.tsx client/src/components/estimating/estimate-copilot-panel.tsx client/src/pages/deals/deal-estimates-tab.tsx client/src/components/estimating/estimating-workflow-shell.test.tsx
git commit -m "feat: add estimating workflow review ui and copilot"
```

## Self-Review

- [ ] Confirm the plan covers all approved spec sections:
  catalog sync, document upload, OCR extraction, catalog matching, pricing recommendations, estimate promotion, review log, and copilot advisory scope.
- [ ] Confirm every task points to exact files and includes runnable test commands before and after implementation.
- [ ] Confirm the plan reuses the existing estimate model instead of inventing a parallel final-estimate schema.
- [ ] Confirm the plan keeps Procore sync one-way and does not promise push-back in Phase 1.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-20-estimating-ai-bid-drafting.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
