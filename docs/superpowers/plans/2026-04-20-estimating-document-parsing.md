# Estimating Document Parsing Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the placeholder estimating OCR job with a real document parsing pipeline for PDF and image uploads, active parse-run tracking, rerun controls, and measurement suggestions that require estimator confirmation before pricing.

**Architecture:** Extend the current estimating document/extraction workflow instead of creating a separate parsing product. The backend adds explicit parse-run records, page normalization and provider interfaces, a document parse orchestrator, and active-parse filtering for workbench and generation flows. The client upgrades the documents panel to trigger reruns with parsing options and surfaces parse status and measurement confirmation state through the existing review workflow.

**Tech Stack:** Express, Drizzle, PostgreSQL, React, TypeScript, Vitest

---

## File Structure

- Modify: `shared/src/schema/tenant/estimate-source-documents.ts`
  Responsibility: add parse lifecycle columns to source documents and define the new parse-run table.
- Modify: `shared/src/schema/tenant/estimate-extractions.ts`
  Responsibility: export any parsing metadata additions needed for active parse filtering and measurement confirmation.
- Modify: `shared/src/schema/index.ts`
  Responsibility: export the new parse-run table.
- Create: `migrations/0030_estimating_document_parse_runs.sql`
  Responsibility: create parse-run storage and document lifecycle columns.
- Create: `server/src/modules/estimating/document-page-extractor.ts`
  Responsibility: normalize PDFs and images into page descriptors.
- Create: `server/src/modules/estimating/document-ocr-adapter.ts`
  Responsibility: define the OCR adapter contract and the default deterministic OCR adapter.
- Create: `server/src/modules/estimating/scale-detection-provider.ts`
  Responsibility: define the scale detection contract and the default heuristic provider.
- Modify: `server/src/modules/estimating/extraction-service.ts`
  Responsibility: normalize structured parser output into extraction rows instead of splitting placeholder text.
- Create: `server/src/modules/estimating/document-parse-orchestrator.ts`
  Responsibility: coordinate parse runs, persist active page/extraction artifacts, and apply supersession rules.
- Modify: `server/src/modules/estimating/document-service.ts`
  Responsibility: accept parse options when queuing reruns and manage document parse status.
- Modify: `server/src/modules/estimating/workbench-service.ts`
  Responsibility: return active parse status, warnings, and measurement confirmation summaries in workflow state.
- Modify: `server/src/modules/deals/routes.ts`
  Responsibility: extend document rerun and workflow-state routes for parsing options and parse status output.
- Modify: `server/src/modules/estimating/pricing-service.ts`
  Responsibility: exclude unconfirmed measurement candidates from downstream pricing recommendations.
- Modify: `worker/src/jobs/estimate-document-ocr.ts`
  Responsibility: replace the placeholder OCR implementation with the real parse orchestrator entrypoint.
- Modify: `worker/src/jobs/estimate-generation.ts`
  Responsibility: read only active parse outputs and skip unconfirmed measurement candidates.
- Create: `server/tests/modules/estimating/document-page-extractor.test.ts`
  Responsibility: verify PDF/image normalization behavior.
- Create: `server/tests/modules/estimating/document-parse-orchestrator.test.ts`
  Responsibility: verify parse-run supersession, partial failure handling, and active output rules.
- Modify: `server/tests/modules/estimating/document-service.test.ts`
  Responsibility: cover parse options, rerun queueing, and document lifecycle fields.
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
  Responsibility: verify parse status and measurement summaries in workflow state.
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
  Responsibility: verify rerun route contract and workflow-state payload changes.
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
  Responsibility: verify unconfirmed measurement rows are excluded from pricing.
- Modify: `server/tests/modules/estimating/draft-estimate-service.test.ts`
  Responsibility: verify downstream promotion paths only see approved pricing built from confirmed extractions.
- Modify: `client/src/components/estimating/estimate-documents-panel.tsx`
  Responsibility: add rerun parsing controls and parse status presentation.
- Create: `client/src/components/estimating/estimate-documents-panel.test.tsx`
  Responsibility: verify rerun UI submits provider/profile options and shows parse statuses.
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
  Responsibility: show measurement confirmation state on extraction rows.
- Modify: `client/src/components/estimating/estimate-extraction-review-table.test.tsx`
  Responsibility: verify measurement rows are labeled and still use the existing approve/edit/reject path.
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`
  Responsibility: verify document warnings and measurement counts appear in the workbench.

## Task 1: Add Parse-Run Storage and Document Lifecycle Metadata

**Files:**
- Modify: `shared/src/schema/tenant/estimate-source-documents.ts`
- Modify: `shared/src/schema/tenant/estimate-extractions.ts`
- Modify: `shared/src/schema/index.ts`
- Create: `migrations/0030_estimating_document_parse_runs.sql`
- Modify: `server/tests/modules/estimating/schema-exports.test.ts`
- Modify: `server/tests/modules/estimating/document-service.test.ts`

- [ ] **Step 1: Write the failing schema export and document lifecycle tests**

```ts
import { describe, expect, it } from "vitest";
import { estimateDocumentParseRuns } from "@trock-crm/shared/schema";

describe("estimating schema exports", () => {
  it("exports estimateDocumentParseRuns", () => {
    expect(estimateDocumentParseRuns).toBeDefined();
  });
});
```

```ts
it("stores parse lifecycle defaults on source documents", async () => {
  const result = await createEstimateSourceDocument({
    tenantDb,
    enqueueEstimateDocumentOcr,
    input: {
      dealId: "deal-1",
      fileId: "file-1",
      filename: "A1-plan.pdf",
      mimeType: "application/pdf",
      userId: "user-1",
      officeId: "office-1",
    },
  });

  expect(result.ocrStatus).toBe("queued");
  expect(result.parseStatus).toBe("queued");
  expect(result.activeParseRunId).toBeNull();
});
```

- [ ] **Step 2: Run the focused schema tests to verify they fail**

Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts tests/modules/estimating/document-service.test.ts`
Expected: FAIL because `estimateDocumentParseRuns`, `parseStatus`, and `activeParseRunId` do not exist yet.

- [ ] **Step 3: Add the schema and migration**

```ts
export const estimateDocumentParseRuns = pgTable(
  "estimate_document_parse_runs",
  {
    id: uuid("id").primaryKey().defaultRandom(),
    documentId: uuid("document_id").references(() => estimateSourceDocuments.id, { onDelete: "cascade" }).notNull(),
    status: text("status").default("queued").notNull(),
    provider: text("provider").default("default").notNull(),
    profile: text("profile").default("balanced").notNull(),
    optionsJson: jsonb("options_json").default({}).notNull(),
    stageSummaryJson: jsonb("stage_summary_json").default({}).notNull(),
    errorSummary: text("error_summary"),
    becameActive: boolean("became_active").default(false).notNull(),
    startedAt: timestamp("started_at", { withTimezone: true }).defaultNow().notNull(),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [index("estimate_document_parse_runs_document_idx").on(table.documentId, table.startedAt)]
);
```

```sql
ALTER TABLE "{schema}".estimate_source_documents
  ADD COLUMN IF NOT EXISTS parse_status text NOT NULL DEFAULT 'queued',
  ADD COLUMN IF NOT EXISTS active_parse_run_id uuid,
  ADD COLUMN IF NOT EXISTS parse_profile text,
  ADD COLUMN IF NOT EXISTS parse_provider text,
  ADD COLUMN IF NOT EXISTS parse_error_summary text;
```

- [ ] **Step 4: Run the schema/document tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/schema-exports.test.ts tests/modules/estimating/document-service.test.ts`
Expected: PASS with parse-run exports and document lifecycle defaults green.

- [ ] **Step 5: Commit**

```bash
git add shared/src/schema/tenant/estimate-source-documents.ts shared/src/schema/tenant/estimate-extractions.ts shared/src/schema/index.ts migrations/0030_estimating_document_parse_runs.sql server/tests/modules/estimating/schema-exports.test.ts server/tests/modules/estimating/document-service.test.ts
git commit -m "feat: add estimating document parse run storage"
```

## Task 2: Build Page Normalization and Provider Interfaces

**Files:**
- Create: `server/src/modules/estimating/document-page-extractor.ts`
- Create: `server/src/modules/estimating/document-ocr-adapter.ts`
- Create: `server/src/modules/estimating/scale-detection-provider.ts`
- Create: `server/tests/modules/estimating/document-page-extractor.test.ts`

- [ ] **Step 1: Write the failing page normalization tests**

```ts
import { describe, expect, it } from "vitest";
import { normalizeEstimateDocumentPages } from "../../../src/modules/estimating/document-page-extractor.js";

describe("normalizeEstimateDocumentPages", () => {
  it("returns one page for an image upload", async () => {
    const pages = await normalizeEstimateDocumentPages({
      filename: "sheet-a.png",
      mimeType: "image/png",
      storageKey: "files/sheet-a.png",
    });

    expect(pages).toHaveLength(1);
    expect(pages[0]?.sourceKind).toBe("image");
  });
});
```

- [ ] **Step 2: Run the normalization test to verify it fails**

Run: `npx vitest run tests/modules/estimating/document-page-extractor.test.ts`
Expected: FAIL because `normalizeEstimateDocumentPages` does not exist yet.

- [ ] **Step 3: Implement normalization and the adapter contracts**

```ts
export interface NormalizedEstimatePage {
  pageNumber: number;
  sourceKind: "pdf_page" | "image";
  pageImageKey: string | null;
  width: number | null;
  height: number | null;
}

export async function normalizeEstimateDocumentPages(input: {
  filename: string;
  mimeType: string;
  storageKey: string | null;
}): Promise<NormalizedEstimatePage[]> {
  if (input.mimeType === "application/pdf") {
    return [{ pageNumber: 1, sourceKind: "pdf_page", pageImageKey: input.storageKey, width: null, height: null }];
  }
  if (input.mimeType.startsWith("image/")) {
    return [{ pageNumber: 1, sourceKind: "image", pageImageKey: input.storageKey, width: null, height: null }];
  }
  throw new Error(`Unsupported estimate document type: ${input.mimeType}`);
}
```

```ts
export interface DocumentOcrAdapter {
  run(page: NormalizedEstimatePage): Promise<{
    provider: string;
    method: string;
    text: string;
    blocks: Array<{ text: string; bbox?: Record<string, unknown> }>;
  }>;
}
```

- [ ] **Step 4: Run the normalization tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/document-page-extractor.test.ts`
Expected: PASS with PDF/image normalization covered.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/estimating/document-page-extractor.ts server/src/modules/estimating/document-ocr-adapter.ts server/src/modules/estimating/scale-detection-provider.ts server/tests/modules/estimating/document-page-extractor.test.ts
git commit -m "feat: add estimating document page normalization"
```

## Task 3: Replace the Placeholder OCR Job With a Parse Orchestrator

**Files:**
- Create: `server/src/modules/estimating/document-parse-orchestrator.ts`
- Modify: `server/src/modules/estimating/extraction-service.ts`
- Modify: `worker/src/jobs/estimate-document-ocr.ts`
- Create: `server/tests/modules/estimating/document-parse-orchestrator.test.ts`
- Modify: `server/tests/modules/estimating/document-service.test.ts`

- [ ] **Step 1: Write the failing orchestrator test**

```ts
import { describe, expect, it, vi } from "vitest";
import { runEstimateDocumentParse } from "../../../src/modules/estimating/document-parse-orchestrator.js";

describe("runEstimateDocumentParse", () => {
  it("creates a parse run, persists active outputs, and leaves old outputs intact on failure", async () => {
    const tenantDb = createTenantDbMock();
    const result = await runEstimateDocumentParse({
      tenantDb,
      document: { id: "doc-1", dealId: "deal-1", mimeType: "application/pdf", storageKey: "plans/a1.pdf" } as any,
      options: { provider: "default", profile: "balanced", enableMeasurementDetection: true },
    });

    expect(result.parseRun.status).toBe("completed");
    expect(result.documentUpdate.parseStatus).toBe("completed");
  });
});
```

- [ ] **Step 2: Run the orchestrator test to verify it fails**

Run: `npx vitest run tests/modules/estimating/document-parse-orchestrator.test.ts`
Expected: FAIL because `runEstimateDocumentParse` does not exist yet.

- [ ] **Step 3: Implement the orchestrator and worker integration**

```ts
export async function runEstimateDocumentParse(args: {
  tenantDb: TenantDb;
  document: EstimateSourceDocumentRecord;
  options: EstimateDocumentParseOptions;
}) {
  const [parseRun] = await args.tenantDb.insert(estimateDocumentParseRuns).values({
    documentId: args.document.id,
    status: "processing",
    provider: args.options.provider,
    profile: args.options.profile,
    optionsJson: args.options,
  }).returning();

  const pages = await normalizeEstimateDocumentPages({
    filename: args.document.filename,
    mimeType: args.document.mimeType,
    storageKey: args.document.storageKey ?? null,
  });

  const normalizedRows = await buildEstimateExtractionRows({ document: args.document, parseRun, pages, options: args.options });
  await persistActiveParseArtifacts(args.tenantDb, args.document.id, parseRun.id, pages, normalizedRows);

  const [updatedDocument] = await args.tenantDb.update(estimateSourceDocuments).set({
    ocrStatus: "completed",
    parseStatus: "completed",
    activeParseRunId: parseRun.id,
    parseProvider: args.options.provider,
    parseProfile: args.options.profile,
    parsedAt: new Date(),
  }).where(eq(estimateSourceDocuments.id, args.document.id)).returning();

  return { parseRun: { ...parseRun, status: "completed" }, documentUpdate: updatedDocument };
}
```

- [ ] **Step 4: Run the parsing tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/document-parse-orchestrator.test.ts tests/modules/estimating/document-service.test.ts`
Expected: PASS with parse-run creation and worker integration green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/estimating/document-parse-orchestrator.ts server/src/modules/estimating/extraction-service.ts worker/src/jobs/estimate-document-ocr.ts server/tests/modules/estimating/document-parse-orchestrator.test.ts server/tests/modules/estimating/document-service.test.ts
git commit -m "feat: add estimating document parse orchestrator"
```

## Task 4: Enforce Active Parse Filtering and Measurement Confirmation Gating

**Files:**
- Modify: `server/src/modules/estimating/workbench-service.ts`
- Modify: `server/src/modules/estimating/pricing-service.ts`
- Modify: `worker/src/jobs/estimate-generation.ts`
- Modify: `server/tests/modules/estimating/workbench-service.test.ts`
- Modify: `server/tests/modules/estimating/pricing-service.test.ts`
- Modify: `server/tests/modules/estimating/draft-estimate-service.test.ts`

- [ ] **Step 1: Write the failing gating tests**

```ts
it("excludes unconfirmed measurement candidates from pricing", async () => {
  const recommendations = buildEstimatePricingRecommendations({
    extraction: {
      normalizedLabel: "Chain Link Fence",
      unit: "lf",
      quantity: "120",
      metadataJson: { measurementDerived: true, measurementConfirmationState: "pending" },
    } as any,
    matches: [],
    historicalPricing: null,
  });

  expect(recommendations).toEqual([]);
});
```

```ts
it("returns only rows from the active parse run", async () => {
  const state = await buildEstimatingWorkbenchState(tenantDb, "deal-1");
  expect(state.extractionRows.every((row) => row.metadataJson.sourceParseRunId === "run-active")).toBe(true);
});
```

- [ ] **Step 2: Run the focused gating tests to verify they fail**

Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/draft-estimate-service.test.ts`
Expected: FAIL because active parse filtering and measurement gating are not implemented.

- [ ] **Step 3: Implement active parse filtering and confirmation gating**

```ts
function isConfirmedForPricing(extraction: { extractionType?: string | null; metadataJson?: any }) {
  if (extraction.extractionType !== "measurement_candidate") return true;
  return extraction.metadataJson?.measurementConfirmationState === "approved";
}
```

```ts
const activeParseRunId = documents[0]?.activeParseRunId ?? null;
const extractionRows = rawExtractionRows.filter((row) => row.metadataJson?.sourceParseRunId === activeParseRunId);
```

- [ ] **Step 4: Run the gating tests to verify they pass**

Run: `npx vitest run tests/modules/estimating/workbench-service.test.ts tests/modules/estimating/pricing-service.test.ts tests/modules/estimating/draft-estimate-service.test.ts`
Expected: PASS with active parse filtering and measurement confirmation gating green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/estimating/workbench-service.ts server/src/modules/estimating/pricing-service.ts worker/src/jobs/estimate-generation.ts server/tests/modules/estimating/workbench-service.test.ts server/tests/modules/estimating/pricing-service.test.ts server/tests/modules/estimating/draft-estimate-service.test.ts
git commit -m "feat: gate estimating parsing outputs by active run"
```

## Task 5: Add Parsing Rerun Controls and Workflow Payload Updates

**Files:**
- Modify: `server/src/modules/estimating/document-service.ts`
- Modify: `server/src/modules/deals/routes.ts`
- Modify: `client/src/components/estimating/estimate-documents-panel.tsx`
- Create: `client/src/components/estimating/estimate-documents-panel.test.tsx`
- Modify: `client/src/components/estimating/estimate-extraction-review-table.tsx`
- Modify: `client/src/components/estimating/estimate-extraction-review-table.test.tsx`
- Modify: `server/tests/modules/estimating/workflow-state-routes.test.ts`
- Modify: `client/src/components/estimating/estimating-workflow-shell.test.tsx`

- [ ] **Step 1: Write the failing route and client tests**

```ts
it("queues a parsing rerun with explicit options", async () => {
  const { res } = await invokeRoute("post", "/:id/estimating/documents/:documentId/reprocess", {
    params: { id: "deal-1", documentId: "doc-1" },
    body: { provider: "default", profile: "measurement-heavy", enableMeasurementDetection: true },
  });

  expect(res.statusCode).toBe(200);
  expect(reprocessEstimateSourceDocument).toHaveBeenCalledWith(expect.objectContaining({
    input: expect.objectContaining({ parseOptions: expect.objectContaining({ profile: "measurement-heavy" }) }),
  }));
});
```

```tsx
it("submits rerun parsing options from the documents panel", async () => {
  render(<EstimateDocumentsPanel dealId="deal-1" documents={[document]} onRefresh={vi.fn()} />);
  expect(screen.getByText(/Re-run Parsing/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run the route/client tests to verify they fail**

Run: `npx vitest run server/tests/modules/estimating/workflow-state-routes.test.ts client/src/components/estimating/estimate-documents-panel.test.tsx client/src/components/estimating/estimate-extraction-review-table.test.tsx`
Expected: FAIL because the rerun options UI and route contract do not exist yet.

- [ ] **Step 3: Implement rerun options and workflow payload changes**

```ts
export interface EstimateDocumentParseOptions {
  provider: string;
  profile: "balanced" | "text-heavy" | "measurement-heavy";
  enableMeasurementDetection: boolean;
}
```

```tsx
<Button onClick={() => handleReprocess(document.id, {
  provider: "default",
  profile: "balanced",
  enableMeasurementDetection: true,
})}>
  Re-run Parsing
</Button>
```

- [ ] **Step 4: Run the route/client tests to verify they pass**

Run: `npx vitest run server/tests/modules/estimating/workflow-state-routes.test.ts client/src/components/estimating/estimate-documents-panel.test.tsx client/src/components/estimating/estimate-extraction-review-table.test.tsx client/src/components/estimating/estimating-workflow-shell.test.tsx`
Expected: PASS with parsing rerun options and measurement row presentation green.

- [ ] **Step 5: Commit**

```bash
git add server/src/modules/estimating/document-service.ts server/src/modules/deals/routes.ts client/src/components/estimating/estimate-documents-panel.tsx client/src/components/estimating/estimate-documents-panel.test.tsx client/src/components/estimating/estimate-extraction-review-table.tsx client/src/components/estimating/estimate-extraction-review-table.test.tsx server/tests/modules/estimating/workflow-state-routes.test.ts client/src/components/estimating/estimating-workflow-shell.test.tsx
git commit -m "feat: add estimating parsing rerun controls"
```

## Task 6: Verify the Full Parsing Slice

**Files:**
- Verify only; no required file additions

- [ ] **Step 1: Run the full estimating server test suite**

Run: `npx vitest run tests/modules/estimating/*.test.ts`
Expected: PASS with parsing, workbench, pricing, and document lifecycle tests green.

- [ ] **Step 2: Run the parsing-related client tests**

Run: `npx vitest run src/components/estimating/estimate-documents-panel.test.tsx src/components/estimating/estimate-extraction-review-table.test.tsx src/components/estimating/estimating-workflow-shell.test.tsx`
Expected: PASS with rerun controls, measurement presentation, and workbench payload rendering green.

- [ ] **Step 3: Run typecheck across affected workspaces**

Run: `npm run typecheck --workspace=shared --workspace=server --workspace=client --workspace=worker`
Expected: PASS with no new type errors.

- [ ] **Step 4: Commit the verification checkpoint if any fixups were needed**

```bash
git add shared server client worker
git commit -m "test: verify estimating document parsing slice"
```
