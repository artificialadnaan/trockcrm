# Estimating AI Bid Drafting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a project-estimating workflow that ingests uploaded plans, syncs the Procore cost catalog into local tables, generates OCR-backed scope rows, matches them to catalog and historical estimate data, recommends prices, and promotes approved rows into the existing estimate model for estimator review.

**Architecture:** Extend the existing Procore and estimating modules rather than creating a parallel system. The backend adds catalog-sync, document-ingestion, extraction, matching, pricing, and draft-generation services with worker jobs for asynchronous processing. The frontend adds new estimating workflow views inside the existing estimating tab and reuses the current estimate sections and line items as the canonical final estimate.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, worker jobs, Vitest

---

## File Structure

- Create: `migrations/0028_cost_catalog_and_estimate_generation.sql`
  Responsibility: add local Procore-backed catalog tables in `public` and tenant-scoped estimate generation tables using the repo's `office_%` reconciliation migration pattern with a new, non-colliding migration number after the existing `0027` files.
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
- Modify: `worker/src/index.ts`
  Responsibility: add a dedicated cron entry for public catalog refresh instead of coupling it to every office-scoped Procore poll.
- Create: `server/src/modules/estimating/document-service.ts`
  Responsibility: create uploaded estimating documents and queue OCR/indexing.
- Create: `server/src/modules/estimating/extraction-service.ts`
  Responsibility: normalize OCR output into extraction records.
- Create: `server/src/modules/estimating/historical-pricing-service.ts`
  Responsibility: derive historical estimate comps, awarded-job adjustments, vendor quote inputs, and win/loss patterns from existing deal and estimate data.
- Create: `server/src/modules/estimating/matching-service.ts`
  Responsibility: rank catalog and historical estimate matches for extraction rows.
- Create: `server/src/modules/estimating/pricing-service.ts`
  Responsibility: generate pricing recommendations from catalog, history, and market adjustments.
- Create: `server/src/modules/estimating/catalog-read-model-service.ts`
  Responsibility: build a joined catalog view that exposes primary code and baseline price from normalized item/code/price tables.
- Create: `server/src/modules/estimating/draft-estimate-service.ts`
  Responsibility: promote approved pricing recommendations into estimate sections and estimate line items.
- Create: `server/src/modules/estimating/copilot-service.ts`
  Responsibility: answer estimator advisory questions from extraction, catalog, history, and pricing evidence.
- Modify: `server/src/modules/deals/estimate-service.ts`
  Responsibility: support generation-aware estimate imports without breaking existing manual editing.
- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: API routes for document upload, extraction review, matching review, pricing review, review logging, copilot answers, overview status, and draft promotion.
- Modify: `server/src/app.ts` or the module registration entrypoint currently used by the API
  Responsibility: confirm the existing admin router mount is already active and only touch `server/src/app.ts` if the admin route is not already registered there.
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
- Create: `client/src/components/estimating/estimate-catalog-match-table.tsx`
  Responsibility: review and remap catalog item matches before pricing.
- Create: `client/src/components/estimating/estimate-pricing-review-table.tsx`
  Responsibility: review/edit pricing recommendations before promotion.
- Create: `client/src/components/estimating/estimate-copilot-panel.tsx`
  Responsibility: estimator advisory prompts and answers.
- Create: `client/src/components/estimating/estimate-overview-panel.tsx`
  Responsibility: summarize pipeline status, catalog snapshot, and reviewer attention areas.
- Create: `client/src/components/estimating/estimate-review-log-panel.tsx`
  Responsibility: show accepted, edited, rejected, and overridden system recommendations.
- Create: `server/tests/modules/procore/catalog-sync-service.test.ts`
  Responsibility: validate Procore payload normalization and upserts.
- Create: `server/tests/modules/estimating/document-service.test.ts`
  Responsibility: validate document creation and OCR job enqueue behavior.
- Create: `server/tests/modules/estimating/estimating-security.test.ts`
  Responsibility: validate deal access checks, tenant isolation, failed OCR status handling, and catalog-sync failure recovery behavior.
- Create: `server/tests/modules/estimating/matching-service.test.ts`
  Responsibility: validate catalog and historical estimate ranking.
- Create: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: validate pricing recommendation calculations.
- Create: `server/tests/modules/estimating/draft-estimate-service.test.ts`
  Responsibility: validate promotion into estimate sections and line items.
- Create: `server/tests/modules/estimating/copilot-service.test.ts`
  Responsibility: validate estimator copilot answer shaping from historical and pricing evidence.
- Create: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: validate major workflow states and actions.

## Task 1: Add Catalog and Estimate-Generation Storage

**Files:**
- Create: `migrations/0028_cost_catalog_and_estimate_generation.sql`
- Create: `shared/src/schema/public/cost-catalog-sources.ts`
- Create: `shared/src/schema/public/cost-catalog-items.ts`
- Create: `shared/src/schema/tenant/estimate-source-documents.ts`
- Create: `shared/src/schema/tenant/estimate-extractions.ts`
- Modify: `shared/src/schema/index.ts`
- Test: `shared/src/schema/index.ts` export load via `server/tests/modules/estimating/schema-exports.test.ts`

- [ ] **Step 1: Write a failing schema export test**

```ts
import { describe, expect, it } from "vitest";
import {
  costCatalogSources,
  costCatalogSyncRuns,
  costCatalogCodes,
  costCatalogItems,
  costCatalogItemCodes,
  costCatalogPrices,
  estimateSourceDocuments,
  estimateDocumentPages,
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateGenerationRuns,
  estimateReviewEvents,
} from "@trock-crm/shared/schema";

describe("estimating schema exports", () => {
  it("exports the full catalog and generation schema set", () => {
    expect(costCatalogSources).toBeDefined();
    expect(costCatalogSyncRuns).toBeDefined();
    expect(costCatalogCodes).toBeDefined();
    expect(costCatalogItems).toBeDefined();
    expect(costCatalogItemCodes).toBeDefined();
    expect(costCatalogPrices).toBeDefined();
    expect(estimateSourceDocuments).toBeDefined();
    expect(estimateDocumentPages).toBeDefined();
    expect(estimateExtractions).toBeDefined();
    expect(estimateExtractionMatches).toBeDefined();
    expect(estimatePricingRecommendations).toBeDefined();
    expect(estimateGenerationRuns).toBeDefined();
    expect(estimateReviewEvents).toBeDefined();
  });
});
```

- [ ] **Step 2: Run the focused schema-export test to verify the missing tables fail**

Run: `npx vitest run server/tests/modules/estimating/schema-exports.test.ts`

Expected: FAIL because the new schema files and exports do not exist yet.

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

CREATE TABLE IF NOT EXISTS public.cost_catalog_sync_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  status text NOT NULL DEFAULT 'pending',
  items_seen integer NOT NULL DEFAULT 0,
  items_upserted integer NOT NULL DEFAULT 0,
  items_deactivated integer NOT NULL DEFAULT 0,
  error_summary text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS public.cost_catalog_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  code text NOT NULL,
  name text NOT NULL,
  parent_code_id uuid REFERENCES public.cost_catalog_codes(id) ON DELETE SET NULL,
  division text,
  phase_name text,
  phase_code text,
  is_active boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS public.cost_catalog_items (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source_id uuid NOT NULL REFERENCES public.cost_catalog_sources(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  item_type text NOT NULL,
  name text NOT NULL,
  description text,
  unit text,
  catalog_name text,
  catalog_number text,
  manufacturer text,
  supplier text,
  taxable boolean NOT NULL DEFAULT false,
  is_active boolean NOT NULL DEFAULT true,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  UNIQUE (source_id, external_id)
);

CREATE TABLE IF NOT EXISTS public.cost_catalog_item_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id uuid NOT NULL REFERENCES public.cost_catalog_items(id) ON DELETE CASCADE,
  catalog_code_id uuid NOT NULL REFERENCES public.cost_catalog_codes(id) ON DELETE CASCADE,
  is_primary boolean NOT NULL DEFAULT false,
  UNIQUE (catalog_item_id, catalog_code_id)
);

CREATE TABLE IF NOT EXISTS public.cost_catalog_prices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  catalog_item_id uuid NOT NULL REFERENCES public.cost_catalog_items(id) ON DELETE CASCADE,
  material_unit_cost numeric(14, 2),
  labor_unit_cost numeric(14, 2),
  equipment_unit_cost numeric(14, 2),
  subcontract_unit_cost numeric(14, 2),
  blended_unit_cost numeric(14, 2),
  effective_at timestamptz,
  expires_at timestamptz,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

-- TENANT_SCHEMA_START
-- Create these tables inside each office schema following the existing
-- Use the dynamic `FOR schema_name IN SELECT ... WHERE schema_name LIKE 'office_%'`
-- pattern from `0025_tenant_schema_baseline_reconciliation.sql`, and execute the
-- DDL with `EXECUTE format(...)` for each office schema.

CREATE TABLE IF NOT EXISTS estimate_source_documents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  document_type text NOT NULL,
  filename text NOT NULL,
  storage_key text NOT NULL,
  mime_type text NOT NULL,
  file_size integer,
  version_label text,
  uploaded_by_user_id uuid,
  content_hash text,
  ocr_status text NOT NULL DEFAULT 'queued',
  parsed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS estimate_document_pages (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  document_id uuid NOT NULL REFERENCES estimate_source_documents(id) ON DELETE CASCADE,
  page_number integer NOT NULL,
  sheet_label text,
  sheet_type text,
  ocr_text text,
  page_image_key text,
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS estimate_extractions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  document_id uuid NOT NULL REFERENCES estimate_source_documents(id) ON DELETE CASCADE,
  page_id uuid REFERENCES estimate_document_pages(id) ON DELETE SET NULL,
  extraction_type text NOT NULL,
  raw_label text NOT NULL,
  normalized_label text NOT NULL,
  quantity numeric(14, 3),
  unit text,
  division_hint text,
  confidence numeric(5, 2) NOT NULL DEFAULT 0,
  evidence_text text,
  evidence_bbox_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  status text NOT NULL DEFAULT 'pending',
  metadata_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS estimate_extraction_matches (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  extraction_id uuid NOT NULL REFERENCES estimate_extractions(id) ON DELETE CASCADE,
  catalog_item_id uuid REFERENCES public.cost_catalog_items(id) ON DELETE SET NULL,
  catalog_code_id uuid REFERENCES public.cost_catalog_codes(id) ON DELETE SET NULL,
  historical_line_item_id uuid REFERENCES estimate_line_items(id) ON DELETE SET NULL,
  match_type text NOT NULL,
  match_score numeric(5, 2) NOT NULL DEFAULT 0,
  status text NOT NULL DEFAULT 'suggested',
  reason_json jsonb NOT NULL DEFAULT '{}'::jsonb
);

CREATE TABLE IF NOT EXISTS estimate_generation_runs (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  status text NOT NULL DEFAULT 'pending',
  triggered_by_user_id uuid,
  input_snapshot_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  output_summary_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  error_summary text,
  started_at timestamptz NOT NULL DEFAULT now(),
  completed_at timestamptz,
  catalog_sync_run_id uuid REFERENCES public.cost_catalog_sync_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS estimate_pricing_recommendations (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  extraction_match_id uuid NOT NULL REFERENCES estimate_extraction_matches(id) ON DELETE CASCADE,
  recommended_quantity numeric(14, 3),
  recommended_unit text,
  recommended_unit_price numeric(14, 2),
  recommended_total_price numeric(14, 2),
  price_basis text NOT NULL,
  catalog_baseline_price numeric(14, 2),
  historical_median_price numeric(14, 2),
  market_adjustment_percent numeric(8, 3) NOT NULL DEFAULT 0,
  confidence numeric(5, 2) NOT NULL DEFAULT 0,
  assumptions_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  created_by_run_id uuid REFERENCES estimate_generation_runs(id) ON DELETE SET NULL
);

CREATE TABLE IF NOT EXISTS estimate_review_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  deal_id uuid NOT NULL,
  project_id uuid,
  subject_type text NOT NULL,
  subject_id uuid NOT NULL,
  event_type text NOT NULL,
  before_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  after_json jsonb NOT NULL DEFAULT '{}'::jsonb,
  reason text,
  user_id uuid,
  created_at timestamptz NOT NULL DEFAULT now()
);
-- TENANT_SCHEMA_END
```

- [ ] **Step 4: Add the Drizzle schema files and exports**

```ts
export { costCatalogSources, costCatalogSyncRuns } from "./public/cost-catalog-sources.js";
export {
  costCatalogCodes,
  costCatalogItems,
  costCatalogItemCodes,
  costCatalogPrices,
} from "./public/cost-catalog-items.js";
export { estimateSourceDocuments, estimateDocumentPages } from "./tenant/estimate-source-documents.js";
export {
  estimateExtractions,
  estimateExtractionMatches,
  estimatePricingRecommendations,
  estimateGenerationRuns,
  estimateReviewEvents,
} from "./tenant/estimate-extractions.js";
```

- [ ] **Step 5: Re-run the focused schema export test**

Run: `npx vitest run server/tests/modules/estimating/schema-exports.test.ts`

Expected: PASS

- [ ] **Step 6: Commit the storage layer**

```bash
git add migrations/0028_cost_catalog_and_estimate_generation.sql shared/src/schema/public/cost-catalog-sources.ts shared/src/schema/public/cost-catalog-items.ts shared/src/schema/tenant/estimate-source-documents.ts shared/src/schema/tenant/estimate-extractions.ts shared/src/schema/index.ts server/tests/modules/estimating/schema-exports.test.ts
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
    expect(result.price.blendedUnitCost).toBe("45");
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
}
```

- [ ] **Step 5: Add explicit on-demand and scheduled catalog refresh entrypoints plus snapshot linkage**

```ts
adminRouter.post("/admin/procore/catalog-sync", requireAdmin, async (req, res) => {
  const syncRun = await startCatalogSync({ triggeredByUserId: req.user.id });
  res.status(202).json({ syncRun });
});
```

`adminRouter` here means the existing admin router defined in `server/src/modules/admin/routes.ts`, not a new ad hoc router.

```ts
export async function runScheduledCatalogSync() {
  return syncCostCatalog({ trigger: "scheduled" });
}
```

```ts
// worker/src/index.ts
cron.schedule("7 */6 * * *", async () => {
  console.log("[Worker:cron] Running public Procore catalog refresh...");
  await runScheduledCatalogSync();
});
```

```ts
const [run] = await db.insert(costCatalogSyncRuns).values({
  sourceId,
  status: "running",
}).returning();
```

- [ ] **Step 6: Re-run the catalog test and the broader Procore tests**

Run: `npx vitest run server/tests/modules/procore/catalog-sync-service.test.ts server/tests/modules/procore/*.test.ts`

Expected: PASS for the new catalog test, existing Procore tests remain green.

- [ ] **Step 7: Commit the catalog sync task**

```bash
git add server/src/modules/procore/catalog-sync-service.ts server/src/modules/procore/sync-service.ts server/src/modules/admin/routes.ts server/src/app.ts worker/src/index.ts worker/src/jobs/procore-sync.ts server/tests/modules/procore/catalog-sync-service.test.ts
git commit -m "feat: sync procore cost catalog into local tables"
```

## Task 3: Add Estimating Document Upload and OCR Queueing

**Files:**
- Create: `server/src/modules/estimating/document-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Create: `worker/src/jobs/estimate-document-ocr.ts`
- Modify: `worker/src/jobs/index.ts`
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
  const existing = input.contentHash
    ? await tenantDb
        .select({ id: estimateSourceDocuments.id, contentHash: estimateSourceDocuments.contentHash })
        .from(estimateSourceDocuments)
        .where(eq(estimateSourceDocuments.contentHash, input.contentHash))
        .limit(1)
    : [];

  const versionLabel = existing.length > 0 ? `v${existing.length + 1}` : "v1";
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
      versionLabel,
      ocrStatus: "queued",
      uploadedByUserId: input.userId,
    })
    .returning();

  await enqueueEstimateDocumentOcr({
    documentId: document.id,
    dealId: document.dealId,
    officeId: input.officeId,
  });
  return document;
}
```

- [ ] **Step 4: Persist page-level OCR artifacts and reprocessing metadata in the worker job**

```ts
export async function runEstimateDocumentOcr(payload: { documentId: string }, officeId: string | null) {
  const { pool } = await import("../db.js");
  const resolved = await resolveOfficeSchema(pool, officeId, null);
  if (!resolved) throw new Error("Unable to resolve office schema for estimating OCR");

  const tenantDb = createTenantDrizzle(pool, resolved.schemaName);
  const pages = await extractPdfPages(payload.documentId);

  for (const page of pages) {
    await tenantDb.insert(estimateDocumentPages).values({
      documentId: payload.documentId,
      pageNumber: page.pageNumber,
      sheetLabel: page.sheetLabel ?? null,
      sheetType: page.sheetType ?? null,
      ocrText: page.text,
      pageImageKey: page.imageKey ?? null,
      metadataJson: {
        extractionProvider: page.provider,
        reprocessedAt: new Date().toISOString(),
      },
    });
  }

  await tenantDb
    .update(estimateSourceDocuments)
    .set({ ocrStatus: "completed", parsedAt: new Date() })
    .where(eq(estimateSourceDocuments.id, payload.documentId));
}
```

- [ ] **Step 5: Normalize OCR page text into structured extraction rows**

```ts
const extractionRows = await extractEstimateScopeRows({
  documentId: payload.documentId,
  pages,
});

for (const row of extractionRows) {
  await tenantDb.insert(estimateExtractions).values({
    dealId: row.dealId,
    projectId: row.projectId ?? null,
    documentId: payload.documentId,
    pageId: row.pageId ?? null,
    extractionType: row.extractionType,
    rawLabel: row.rawLabel,
    normalizedLabel: row.normalizedLabel,
    quantity: row.quantity ?? null,
    unit: row.unit ?? null,
    divisionHint: row.divisionHint ?? null,
    confidence: row.confidence,
    evidenceText: row.evidenceText ?? null,
    evidenceBboxJson: row.evidenceBboxJson ?? {},
    metadataJson: {
      extractionProvider: row.provider,
      extractionMethod: row.method,
    },
  });
}
```

- [ ] **Step 6: Register the new OCR and generation jobs in the worker job registry**

```ts
import { runEstimateDocumentOcr } from "./estimate-document-ocr.js";
import { runEstimateGeneration } from "./estimate-generation.js";

registerJobHandler("estimate_document_ocr", async (payload, officeId) => {
  await runEstimateDocumentOcr(payload, officeId);
});

registerJobHandler("estimate_generation", async (payload, officeId) => {
  await runEstimateGeneration(payload, officeId);
});
```

- [ ] **Step 7: Add routes and a document upload panel in the estimate tab**

```ts
router.post("/deals/:dealId/estimating/documents", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");

  const uploadedFile = await finalizeUploadedFileForDeal({
    tenantDb: req.tenantDb!,
    officeSlug: req.officeSlug!,
    userId: req.user!.id,
    uploadToken: req.body.uploadToken,
    dealId: req.params.dealId,
  });

  const document = await createEstimateSourceDocument({
    tenantDb: req.tenantDb,
    enqueueEstimateDocumentOcr,
    input: {
      dealId: req.params.dealId,
      filename: uploadedFile.originalName,
      storageKey: uploadedFile.storageKey,
      mimeType: uploadedFile.mimeType,
      userId: req.user.id,
      officeId: req.user.activeOfficeId ?? req.user.officeId,
    },
  });

  res.status(201).json({ document });
});
```

- [ ] **Step 8: Re-run the focused service tests and a client typecheck**

Run: `npx vitest run server/tests/modules/estimating/document-service.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit the upload and OCR queueing task**

```bash
git add server/src/modules/estimating/document-service.ts server/src/modules/estimating/extraction-service.ts server/src/modules/deals/routes.ts worker/src/jobs/estimate-document-ocr.ts worker/src/jobs/index.ts client/src/pages/deals/deal-estimates-tab.tsx client/src/components/estimating/estimate-documents-panel.tsx server/tests/modules/estimating/document-service.test.ts
git commit -m "feat: add estimating document upload and ocr queueing"
```

## Task 3B: Add Security and Failure-Mode Coverage

**Files:**
- Create: `server/tests/modules/estimating/estimating-security.test.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `server/src/modules/estimating/document-service.ts`
- Modify: `server/src/modules/procore/catalog-sync-service.ts`

- [ ] **Step 1: Write failing security and recovery tests**

```ts
import { describe, expect, it } from "vitest";

describe("estimating security and recovery", () => {
  it("rejects document upload when the user cannot access the deal", async () => {
    expect(true).toBe(false);
  });

  it("marks OCR status failed when OCR processing throws", async () => {
    expect(true).toBe(false);
  });

  it("keeps the previous catalog snapshot available when a sync run fails", async () => {
    expect(true).toBe(false);
  });

  it("blocks pricing history and copilot answers from other office schemas", async () => {
    expect(true).toBe(false);
  });
});
```

- [ ] **Step 2: Run the security test**

Run: `npx vitest run server/tests/modules/estimating/estimating-security.test.ts`

Expected: FAIL because the security and recovery behavior is not implemented yet.

- [ ] **Step 3: Implement permission, tenant-scope, OCR failure, and sync-recovery hooks**

```ts
try {
  await runEstimateDocumentOcr(payload, officeId);
} catch (error) {
  await tenantDb
    .update(estimateSourceDocuments)
    .set({ ocrStatus: "failed" })
    .where(eq(estimateSourceDocuments.id, payload.documentId));
  throw error;
}
```

```ts
if (!deal) throw new AppError(404, "Deal not found");
if (deal.officeId !== req.user!.activeOfficeId) throw new AppError(403, "Forbidden");
```

- [ ] **Step 4: Re-run the security test**

Run: `npx vitest run server/tests/modules/estimating/estimating-security.test.ts`

Expected: PASS

- [ ] **Step 5: Commit the security and recovery task**

```bash
git add server/tests/modules/estimating/estimating-security.test.ts server/src/modules/deals/routes.ts server/src/modules/estimating/document-service.ts server/src/modules/procore/catalog-sync-service.ts
git commit -m "test: add estimating security and failure-mode coverage"
```

## Task 4: Build Extraction, Matching, and Pricing Services

**Files:**
- Create: `server/src/modules/estimating/extraction-service.ts`
- Create: `server/src/modules/estimating/historical-pricing-service.ts`
- Create: `server/src/modules/estimating/matching-service.ts`
- Create: `server/src/modules/estimating/pricing-service.ts`
- Create: `server/src/modules/estimating/catalog-read-model-service.ts`
- Create: `worker/src/jobs/estimate-generation.ts`
- Test: `server/tests/modules/estimating/matching-service.test.ts`
- Test: `server/tests/modules/estimating/pricing-service.test.ts`

- [ ] **Step 1: Write failing matching and pricing tests**

```ts
describe("buildPricingRecommendation", () => {
  it("applies a geography and project-type market adjustment from the market-rate service", () => {
    const result = buildPricingRecommendation({
      quantity: 3,
      catalogBaselinePrice: 100,
      historicalPrices: [110, 115, 120],
      vendorQuotePrice: 130,
      awardedOutcomeAdjustmentPercent: -2,
      internalAdjustmentPercent: 5,
      regionId: "dfw",
      projectTypeId: "roofing",
    });

    expect(result.priceBasis).toBe("catalog_baseline_with_adjustments");
    expect(result.comparableHistoricalPrices).toEqual([110, 115, 120]);
    expect(result.marketAdjustmentPercent).toBe(10);
    expect(result.assumptions.catalogBaselineUsed).toBe(true);
    expect(result.confidence).toBeGreaterThan(0);
  });
});
```

```ts
describe("rankExtractionMatches", () => {
  it("uses catalog fit and similar historical line items when ranking matches", async () => {
    const results = await rankExtractionMatches({
      extraction: { normalizedLabel: "parapet wall flashing", unit: "ft", divisionHint: "07" } as any,
      catalogItems: [
        { id: "a", name: "Parapet Wall Flashing", unit: "ft", primaryCode: "07-100", catalogBaselinePrice: "100.00" },
        { id: "b", name: "Flashing", unit: "ea", primaryCode: "08-200", catalogBaselinePrice: "20.00" },
      ] as any,
      historicalItems: [
        { id: "hist-1", description: "Parapet Wall Flashing", unit: "ft", costCode: "07-100" },
      ] as any,
    });

    expect(results[0]?.catalogItemId).toBe("a");
    expect(results[0]?.historicalLineItemIds).toContain("hist-1");
  });
});
```

- [ ] **Step 2: Run the matching and pricing tests**

Run: `npx vitest run server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts`

Expected: FAIL because the matching and pricing services do not exist yet.

- [ ] **Step 3: Implement the historical pricing retrieval service**

```ts
export async function getHistoricalPricingSignals(db: TenantDb, dealId: string) {
  const historicalItems = await loadSimilarHistoricalEstimateLineItems(db, dealId);
  const awardedOutcomes = await loadAwardedDealOutcomes(db, dealId);
  const vendorQuotes = await loadHistoricalVendorQuoteSignals(db, dealId);
  const wonBidPatterns = await loadWonBidPatterns(db, dealId);

  return {
    historicalItems,
    awardedOutcomes,
    vendorQuotes,
    wonBidPatterns,
  };
}
```

- [ ] **Step 4: Implement the catalog read model used by matching and pricing**

```ts
export async function listCatalogCandidatesForMatching(db: TenantDb, sourceId: string) {
  return db
    .select({
      id: costCatalogItems.id,
      name: costCatalogItems.name,
      unit: costCatalogItems.unit,
      primaryCode: costCatalogCodes.code,
      catalogBaselinePrice: costCatalogPrices.blendedUnitCost,
    })
    .from(costCatalogItems)
    .leftJoin(costCatalogItemCodes, eq(costCatalogItemCodes.catalogItemId, costCatalogItems.id))
    .leftJoin(costCatalogCodes, eq(costCatalogCodes.id, costCatalogItemCodes.catalogCodeId))
    .leftJoin(costCatalogPrices, eq(costCatalogPrices.catalogItemId, costCatalogItems.id))
    .where(and(eq(costCatalogItems.sourceId, sourceId), eq(costCatalogItemCodes.isPrimary, true)));
}
```

- [ ] **Step 5: Implement the extraction normalization and matching logic**

```ts
export function buildPricingRecommendation(input: BuildPricingRecommendationInput) {
  const historicalMedian =
    input.historicalPrices.length > 0
      ? [...input.historicalPrices].sort((a, b) => a - b)[Math.floor(input.historicalPrices.length / 2)]
      : null;
  const quoteAdjustedBase =
    input.vendorQuotePrice != null
      ? (input.catalogBaselinePrice ?? input.vendorQuotePrice) * 0.5 + input.vendorQuotePrice * 0.5
      : input.catalogBaselinePrice ?? historicalMedian ?? 0;
  const awardedAdjustedBase =
    quoteAdjustedBase * (1 + (input.awardedOutcomeAdjustmentPercent ?? 0) / 100);
  const afterInternal = awardedAdjustedBase * (1 + input.internalAdjustmentPercent / 100);
  const regionalAdjustmentPercent = getRegionalMarketAdjustmentPercent({
    projectTypeId: input.projectTypeId,
    regionId: input.regionId,
  });
  const adjusted = Number((afterInternal * (1 + regionalAdjustmentPercent / 100)).toFixed(2));

  return {
    priceBasis: "catalog_baseline_with_adjustments",
    recommendedUnitPrice: adjusted,
    recommendedTotalPrice: Number((adjusted * input.quantity).toFixed(2)),
    comparableHistoricalPrices: input.historicalPrices,
    historicalMedianPrice: historicalMedian,
    catalogBaselinePrice: input.catalogBaselinePrice ?? null,
    marketAdjustmentPercent: regionalAdjustmentPercent,
    assumptions: {
      catalogBaselineUsed: input.catalogBaselinePrice != null,
      vendorQuotePrice: input.vendorQuotePrice ?? null,
      awardedOutcomeAdjustmentPercent: input.awardedOutcomeAdjustmentPercent ?? 0,
      internalAdjustmentPercent: input.internalAdjustmentPercent,
    },
    confidence: historicalMedian != null ? 0.84 : 0.58,
  };
}
```

- [ ] **Step 6: Implement matching to include historical evidence and store reviewable reasons**

```ts
export async function rankExtractionMatches({
  extraction,
  catalogItems,
  historicalItems,
}: RankExtractionMatchesArgs) {
  const normalizedLabel = extraction.normalizedLabel.toLowerCase();

  return catalogItems
    .map((item) => {
      const similarHistory = historicalItems.filter((historicalItem) => {
        return (
          historicalItem.description.toLowerCase().includes(normalizedLabel) ||
          historicalItem.costCode === item.primaryCode
        );
      });

      return {
        catalogItemId: item.id,
        historicalLineItemIds: similarHistory.map((row) => row.id),
        historicalUnitPrices: similarHistory
          .map((row) => Number(row.unitPrice))
          .filter((value) => Number.isFinite(value)),
        catalogBaselinePrice: item.catalogBaselinePrice ?? null,
        vendorQuotePrice: similarHistory.find((row) => row.vendorQuotePrice != null)?.vendorQuotePrice ?? null,
        awardedOutcomeAdjustmentPercent:
          similarHistory.length > 0 ? deriveAwardedOutcomeAdjustment(similarHistory) : 0,
        internalAdjustmentPercent: deriveInternalAdjustmentPercent(item, extraction),
        matchScore:
          (item.name.toLowerCase() === normalizedLabel ? 50 : 0) +
          (item.unit && extraction.unit && item.unit === extraction.unit ? 15 : 0) +
          (item.primaryCode?.startsWith(extraction.divisionHint ?? "") ? 15 : 0) +
          Math.min(similarHistory.length * 10, 20),
        reasons: {
          exactNameMatch: item.name.toLowerCase() === normalizedLabel,
          unitMatched: item.unit === extraction.unit,
          historicalCount: similarHistory.length,
        },
      };
    })
    .sort((a, b) => b.matchScore - a.matchScore);
}
```

- [ ] **Step 5: Orchestrate generation to write extraction matches and pricing recommendations with evidence**

```ts
const historicalSignals = await getHistoricalPricingSignals(tenantDb, deal.id);

for (const extraction of pendingExtractions) {
  const catalogItems = await listCatalogCandidatesForMatching(tenantDb, catalogSourceId);
  const matches = await rankExtractionMatches({
    extraction,
    catalogItems,
    historicalItems: historicalSignals.historicalItems,
  });
  const topMatch = matches[0];
  if (!topMatch) {
    await insertEstimateReviewEvent(tenantDb, {
      dealId: extraction.dealId,
      subjectType: "estimate_extraction",
      subjectId: extraction.id,
      eventType: "unmatched",
      afterJson: { normalizedLabel: extraction.normalizedLabel },
    });
    continue;
  }

  const recommendation = buildPricingRecommendation({
    quantity: Number(extraction.quantity ?? 1),
    catalogBaselinePrice: topMatch.catalogBaselinePrice ?? null,
    historicalPrices: topMatch.historicalUnitPrices ?? [],
    vendorQuotePrice: topMatch.vendorQuotePrice ?? historicalSignals.vendorQuotes[0]?.unitPrice ?? null,
    awardedOutcomeAdjustmentPercent:
      topMatch.awardedOutcomeAdjustmentPercent ?? deriveAwardedOutcomeAdjustment(historicalSignals.awardedOutcomes),
    internalAdjustmentPercent: topMatch.internalAdjustmentPercent ?? 0,
    regionId: deal.regionId,
    projectTypeId: deal.projectTypeId,
  });

  await saveExtractionMatchAndRecommendation({
    extraction,
    topMatch,
    recommendation,
    runId,
  });
}
```

- [ ] **Step 7: Re-run the matching and pricing tests**

Run: `npx vitest run server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts`

Expected: PASS

- [ ] **Step 8: Commit the extraction, matching, and pricing task**

```bash
git add server/src/modules/estimating/catalog-read-model-service.ts server/src/modules/estimating/historical-pricing-service.ts server/src/modules/estimating/extraction-service.ts server/src/modules/estimating/matching-service.ts server/src/modules/estimating/pricing-service.ts worker/src/jobs/estimate-generation.ts server/tests/modules/estimating/matching-service.test.ts server/tests/modules/estimating/pricing-service.test.ts
git commit -m "feat: add estimate extraction matching and pricing services"
```

## Task 5: Promote Approved Draft Rows Into the Existing Estimate Model

**Files:**
- Create: `server/src/modules/estimating/draft-estimate-service.ts`
- Modify: `server/src/modules/deals/estimate-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Test: `server/tests/modules/estimating/draft-estimate-service.test.ts`

- [ ] **Step 1: Write a failing promotion test**

```ts
import { describe, expect, it, vi } from "vitest";
import { promoteApprovedRecommendationsToEstimate } from "../../../src/modules/estimating/draft-estimate-service.js";

describe("promoteApprovedRecommendationsToEstimate", () => {
  it("is idempotent for the same approved recommendation set", async () => {
    const tenantDb = {
      insert: vi.fn(),
      select: vi.fn().mockReturnValue({
        from: vi.fn().mockReturnValue({
          where: vi.fn().mockResolvedValue([{ subjectId: "rec-1" }]),
        }),
      }),
    } as any;

    await promoteApprovedRecommendationsToEstimate({
      tenantDb,
      dealId: "deal-1",
      generationRunId: "run-1",
      approvedRecommendationIds: ["rec-1"],
    });

    expect(tenantDb.insert).not.toHaveBeenCalled();
  });
});
```

```ts
export function getRegionalMarketAdjustmentPercent(input: {
  regionId: string | null;
  projectTypeId: string | null;
}) {
  const table = {
    "dfw:roofing": 10,
    "dfw:waterproofing": 8,
  } as const;

  return table[`${input.regionId ?? "unknown"}:${input.projectTypeId ?? "unknown"}`] ?? 0;
}
```

- [ ] **Step 2: Run the promotion test**

Run: `npx vitest run server/tests/modules/estimating/draft-estimate-service.test.ts`

Expected: FAIL because the draft estimate service does not exist yet.

- [ ] **Step 3: Implement promotion through the existing estimate service path**

```ts
export async function promoteApprovedRecommendationsToEstimate({
  tenantDb,
  dealId,
  generationRunId,
  approvedRecommendationIds,
}: PromoteApprovedRecommendationsArgs) {
  const alreadyPromoted = await listPreviouslyPromotedRecommendationIds(
    tenantDb,
    dealId,
    approvedRecommendationIds
  );

  const recommendations = await loadApprovedRecommendationsForRun(
    tenantDb,
    dealId,
    generationRunId,
    approvedRecommendationIds.filter((id) => !alreadyPromoted.includes(id))
  );

  for (const sectionGroup of groupRecommendationsIntoSections(recommendations)) {
    const section = await createSection(tenantDb, dealId, sectionGroup.sectionName);

    for (const line of sectionGroup.lines) {
      const lineItem = await createLineItem(tenantDb, dealId, section.id, {
        description: line.description,
        quantity: line.quantity,
        unit: line.unit,
        unitPrice: line.unitPrice,
        notes: line.notes ?? null,
      });

      await insertEstimateReviewEvent(tenantDb, {
        dealId,
        subjectType: "estimate_pricing_recommendation",
        subjectId: line.recommendationId,
        eventType: "promoted",
        afterJson: { estimateLineItemId: lineItem.id },
      });
    }
  }
}
```

- [ ] **Step 4: Add approval in Task 5 only, and reserve Task 6 for edit/remap/load endpoints**

```ts
router.post("/deals/:dealId/estimating/recommendations/:recommendationId/approve", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");

  const recommendation = await approveEstimateRecommendation({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    recommendationId: req.params.recommendationId,
    userId: req.user.id,
    reason: req.body.reason ?? null,
  });

  res.status(200).json({ recommendation });
});
```

```ts
export async function approveEstimateRecommendation(args: ApproveEstimateRecommendationArgs) {
  await assertRecommendationBelongsToDeal(args.tenantDb, args.dealId, args.recommendationId);
  await markRecommendationApproved(args.tenantDb, args.recommendationId);
  await insertEstimateReviewEvent(args.tenantDb, {
    dealId: args.dealId,
    subjectType: "estimate_pricing_recommendation",
    subjectId: args.recommendationId,
    eventType: "approved",
    userId: args.userId,
    reason: args.reason,
  });
}
```

- [ ] **Step 5: Add the gated promotion route**

```ts
router.post("/deals/:dealId/estimating/promote", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");

  const approvedRecommendationIds = await listApprovedRecommendationIdsForRun(
    req.tenantDb,
    req.params.dealId,
    req.body.generationRunId
  );

  if (approvedRecommendationIds.length === 0) {
    throw new AppError(400, "At least one approved recommendation is required before promotion");
  }

  await promoteApprovedRecommendationsToEstimate({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    generationRunId: req.body.generationRunId,
    approvedRecommendationIds,
  });

  res.status(200).json({ ok: true });
});
```

- [ ] **Step 6: Re-run the promotion test and current estimate-service tests**

Run: `npx vitest run server/tests/modules/estimating/draft-estimate-service.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 7: Commit the draft estimate promotion task**

```bash
git add server/src/modules/estimating/draft-estimate-service.ts server/src/modules/deals/estimate-service.ts server/src/modules/deals/routes.ts server/tests/modules/estimating/draft-estimate-service.test.ts
git commit -m "feat: promote approved estimate recommendations into estimates"
```

## Task 6: Add the Estimating Workflow UI and Advisory Copilot

**Files:**
- Create: `client/src/components/estimating/estimating-workflow-shell.tsx`
- Create: `client/src/components/estimating/estimate-overview-panel.tsx`
- Create: `client/src/components/estimating/estimate-extraction-review-table.tsx`
- Create: `client/src/components/estimating/estimate-catalog-match-table.tsx`
- Create: `client/src/components/estimating/estimate-pricing-review-table.tsx`
- Create: `client/src/components/estimating/estimate-review-log-panel.tsx`
- Create: `client/src/components/estimating/estimate-copilot-panel.tsx`
- Create: `server/src/modules/estimating/copilot-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `client/src/pages/deals/deal-estimates-tab.tsx`
- Test: `server/tests/modules/estimating/copilot-service.test.ts`
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
      matchRows={[]}
      pricingRows={[]}
      reviewEvents={[]}
      copilotEnabled
    />
  );

  expect(screen.getByText("Overview")).toBeInTheDocument();
  expect(screen.getByText("Documents")).toBeInTheDocument();
  expect(screen.getByText("Draft Pricing")).toBeInTheDocument();
  expect(screen.getByText("Review Log")).toBeInTheDocument();
});
```

- [ ] **Step 2: Add a failing copilot service test**

```ts
import { describe, expect, it } from "vitest";
import { answerEstimatingCopilotQuestion } from "../../../src/modules/estimating/copilot-service.js";

describe("answerEstimatingCopilotQuestion", () => {
  it("returns a priced answer with evidence references", async () => {
    const result = await answerEstimatingCopilotQuestion({
      question: "What should this line item price be?",
      context: {
        historicalComparables: [{ id: "hist-1", unitPrice: 118, description: "Parapet Wall Flashing" }],
        pricingRecommendation: { recommendedUnitPrice: 121.54, priceBasis: "catalog_baseline_with_adjustments" },
      } as any,
    });

    expect(result.answer).toContain("121.54");
    expect(result.evidence.length).toBeGreaterThan(0);
  });

  it("answers a historical win-pattern question with grouped evidence", async () => {
    const result = await answerEstimatingCopilotQuestion({
      question: "What kinds of bids have we historically won?",
      context: {
        wonBidPatterns: [
          { id: "won-1", projectType: "roofing", region: "DFW", marginBand: "standard" },
          { id: "won-2", projectType: "roofing", region: "DFW", marginBand: "standard" },
        ],
      } as any,
    });

    expect(result.answer.toLowerCase()).toContain("roofing");
    expect(result.evidence.some((row: any) => row.type === "won_bid_pattern")).toBe(true);
  });
});
```

- [ ] **Step 3: Run the UI and copilot tests**

Run: `npx vitest run client/src/components/estimating/estimating-workflow-shell.test.tsx`
Run: `npx vitest run server/tests/modules/estimating/copilot-service.test.ts`

Expected: FAIL because the workflow shell and copilot service do not exist yet.

- [ ] **Step 4: Implement the workflow shell, overview panel, and review log**

```tsx
export function EstimatingWorkflowShell(props: EstimatingWorkflowShellProps) {
  return (
    <div className="space-y-6">
      <nav className="flex flex-wrap gap-2 text-sm">
        {["Overview", "Documents", "Extraction", "Catalog Match", "Draft Pricing", "Estimate", "Copilot", "Review Log"].map((step) => (
          <div key={step} className="rounded-full border px-3 py-1">
            {step}
          </div>
        ))}
      </nav>

      <EstimateOverviewPanel dealId={props.dealId} />
      <EstimateDocumentsPanel dealId={props.dealId} documents={props.documents} />
      <EstimateExtractionReviewTable rows={props.extractionRows} />
      <EstimateCatalogMatchTable rows={props.matchRows} />
      <EstimatePricingReviewTable rows={props.pricingRows} />
      <div className="rounded-2xl border border-border/60 p-4">
        <h3 className="text-sm font-semibold">Estimate</h3>
        <p className="text-sm text-muted-foreground">
          Approved recommendations promote into the existing estimate editor below.
        </p>
      </div>
      {props.copilotEnabled ? <EstimateCopilotPanel dealId={props.dealId} /> : null}
      <EstimateReviewLogPanel events={props.reviewEvents} />
    </div>
  );
}
```

- [ ] **Step 5: Add concrete review-state mutations for extraction, match, and pricing rows**

```ts
router.get("/deals/:dealId/estimating", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");
  const workflow = await getEstimatingWorkflowState(req.tenantDb!, req.params.dealId);
  res.status(200).json(workflow);
});

router.post("/deals/:dealId/estimating/extractions/:extractionId/approve", async (req, res) => {
  const extraction = await approveEstimateExtraction({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    extractionId: req.params.extractionId,
    userId: req.user.id,
  });

  res.status(200).json({ extraction });
});

router.patch("/deals/:dealId/estimating/extractions/:extractionId", async (req, res) => {
  const extraction = await updateEstimateExtraction(req.tenantDb!, req.params.dealId, req.params.extractionId, req.body);
  await insertEstimateReviewEvent(req.tenantDb!, {
    dealId: req.params.dealId,
    subjectType: "estimate_extraction",
    subjectId: req.params.extractionId,
    eventType: "edited",
    afterJson: req.body,
    userId: req.user!.id,
  });
  res.status(200).json({ extraction });
});

router.post("/deals/:dealId/estimating/matches/:matchId/select", async (req, res) => {
  const match = await selectEstimateExtractionMatch({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    matchId: req.params.matchId,
    userId: req.user.id,
  });

  res.status(200).json({ match });
});

router.patch("/deals/:dealId/estimating/matches/:matchId", async (req, res) => {
  const match = await remapEstimateExtractionMatch(req.tenantDb!, req.params.dealId, req.params.matchId, req.body);
  await insertEstimateReviewEvent(req.tenantDb!, {
    dealId: req.params.dealId,
    subjectType: "estimate_extraction_match",
    subjectId: req.params.matchId,
    eventType: "remapped",
    afterJson: req.body,
    userId: req.user!.id,
  });
  res.status(200).json({ match });
});

router.patch("/deals/:dealId/estimating/recommendations/:recommendationId", async (req, res) => {
  const recommendation = await overrideEstimateRecommendation(
    req.tenantDb!,
    req.params.dealId,
    req.params.recommendationId,
    req.body
  );
  await insertEstimateReviewEvent(req.tenantDb!, {
    dealId: req.params.dealId,
    subjectType: "estimate_pricing_recommendation",
    subjectId: req.params.recommendationId,
    eventType: "overridden",
    afterJson: req.body,
    userId: req.user!.id,
  });
  res.status(200).json({ recommendation });
});

router.post("/deals/:dealId/estimating/recommendations/:recommendationId/reject", async (req, res) => {
  const recommendation = await rejectEstimateRecommendation({
    tenantDb: req.tenantDb,
    dealId: req.params.dealId,
    recommendationId: req.params.recommendationId,
    userId: req.user.id,
    reason: req.body.reason,
  });

  res.status(200).json({ recommendation });
});
```

```tsx
<EstimateExtractionReviewTable
  rows={props.extractionRows}
  onApprove={(extractionId) => approveExtraction(extractionId)}
  onEdit={(extractionId, patch) => updateExtraction(extractionId, patch)}
  onReject={(extractionId, reason) => rejectExtraction(extractionId, reason)}
/>

<EstimateCatalogMatchTable
  rows={props.matchRows}
  onSelect={(matchId) => selectMatch(matchId)}
  onRemap={(matchId, catalogItemId) => remapMatch(matchId, catalogItemId)}
  onReject={(matchId, reason) => rejectMatch(matchId, reason)}
/>

<EstimatePricingReviewTable
  rows={props.pricingRows}
  onApprove={(recommendationId) => approveRecommendation(recommendationId)}
  onOverride={(recommendationId, patch) => overrideRecommendation(recommendationId, patch)}
  onReject={(recommendationId, reason) => rejectRecommendation(recommendationId, reason)}
/>
```

- [ ] **Step 6: Implement the copilot backend and review-log route coverage**

```ts
export async function answerEstimatingCopilotQuestion(input: AnswerEstimatingCopilotQuestionArgs) {
  if (/historically won|won bids|win patterns/i.test(input.question)) {
    return {
      answer: summarizeWonBidPatterns(input.context.wonBidPatterns ?? []),
      evidence: (input.context.wonBidPatterns ?? []).map((row: any) => ({
        type: "won_bid_pattern",
        id: row.id,
      })),
    };
  }

  if (/line item|price/i.test(input.question)) {
    return {
      answer: `Recommended unit price: ${input.context.pricingRecommendation.recommendedUnitPrice}`,
      evidence: [
        {
          type: "pricing_recommendation",
          id: input.context.pricingRecommendation.id ?? "generated",
        },
        ...input.context.historicalComparables.map((row: any) => ({
          type: "historical_line_item",
          id: row.id,
        })),
      ],
    };
  }

  return {
    answer: summarizeEstimateRiskAndAssumptions(input.context),
    evidence: collectRiskEvidence(input.context),
  };
}
```

```ts
router.get("/deals/:dealId/estimating/review-log", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");
  const events = await listEstimateReviewEvents(req.tenantDb, req.params.dealId);
  res.status(200).json({ events });
});

router.post("/deals/:dealId/estimating/copilot", async (req, res) => {
  const deal = await getDealById(req.tenantDb!, req.params.dealId, req.user!.role, req.user!.id);
  if (!deal) throw new AppError(404, "Deal not found");
  const answer = await answerEstimatingCopilotQuestion(req.body);
  res.status(200).json({ answer });
});
```

- [ ] **Step 7: Integrate the workflow shell into the existing estimate tab**

```tsx
return (
  <div className="space-y-6">
    <EstimatingWorkflowShell
      dealId={dealId}
      documents={documents}
      extractionRows={extractionRows}
      matchRows={matchRows}
      pricingRows={pricingRows}
      reviewEvents={reviewEvents}
      copilotEnabled
    />
    <ExistingEstimateEditor sections={sections} onRefresh={fetchEstimates} />
  </div>
);
```

- [ ] **Step 8: Re-run the UI test, copilot test, and workspace typecheck**

Run: `npx vitest run client/src/components/estimating/estimating-workflow-shell.test.tsx`
Expected: PASS

Run: `npx vitest run server/tests/modules/estimating/copilot-service.test.ts`
Expected: PASS

Run: `npm run typecheck`
Expected: PASS

- [ ] **Step 9: Commit the workflow UI task**

```bash
git add client/src/components/estimating/estimating-workflow-shell.tsx client/src/components/estimating/estimate-overview-panel.tsx client/src/components/estimating/estimate-extraction-review-table.tsx client/src/components/estimating/estimate-catalog-match-table.tsx client/src/components/estimating/estimate-pricing-review-table.tsx client/src/components/estimating/estimate-review-log-panel.tsx client/src/components/estimating/estimate-copilot-panel.tsx client/src/pages/deals/deal-estimates-tab.tsx server/src/modules/estimating/copilot-service.ts server/src/modules/deals/routes.ts server/tests/modules/estimating/copilot-service.test.ts client/src/components/estimating/estimating-workflow-shell.test.tsx
git commit -m "feat: add estimating workflow review ui and copilot"
```

## Self-Review

- [ ] Confirm the plan covers all approved spec sections:
  catalog sync, document upload, OCR extraction, catalog matching, pricing recommendations, estimate promotion, review log, and copilot advisory scope.
- [ ] Confirm every task points to exact files and includes runnable test commands before and after implementation.
- [ ] Confirm the plan reuses the existing estimate model instead of inventing a parallel final-estimate schema.
- [ ] Confirm the plan keeps Procore sync one-way and does not promise push-back in Phase 1.
- [ ] Confirm the plan includes security and failure-mode tests for upload permissions, tenant scoping, failed OCR status, and catalog-sync recovery.

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-04-20-estimating-ai-bid-drafting.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
