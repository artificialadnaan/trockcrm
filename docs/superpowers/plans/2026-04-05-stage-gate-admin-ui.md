# Stage Gate Admin UI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a real admin editor for pipeline stage-gate requirements so required fields, documents, and approvals can be configured in product instead of directly in the database.

**Architecture:** Reuse the existing `/api/admin/pipeline` update path, but validate stage-gate arrays on the server before persisting them. Extend the existing `Admin > Pipeline` page with structured multi-value editors backed by known deal-field, file-category, and approval-role option lists.

**Tech Stack:** React 19, TypeScript, Vite, Vitest, Express, Drizzle ORM

---

### Task 1: Server validation

**Files:**
- Modify: `server/src/modules/admin/pipeline-service.ts`
- Create: `server/tests/modules/admin/pipeline-service.test.ts`

- [ ] Add failing tests for accepted and rejected stage-gate config payloads.
- [ ] Run the focused server test and confirm it fails for missing validation.
- [ ] Implement server-side normalization and validation for `requiredFields`, `requiredDocuments`, and `requiredApprovals`.
- [ ] Re-run the focused server test until it passes.

### Task 2: Client editor helpers

**Files:**
- Create: `client/src/lib/stage-gate-options.ts`
- Create: `client/src/lib/stage-gate-options.test.ts`

- [ ] Add failing tests for option parsing, deduping, and preserving only valid config values.
- [ ] Run the focused client test and confirm it fails first.
- [ ] Implement stage-gate option constants and small helper functions for the editor UI.
- [ ] Re-run the focused client test until it passes.

### Task 3: Pipeline admin UI

**Files:**
- Modify: `client/src/pages/admin/pipeline-config-page.tsx`
- Modify: `client/src/hooks/use-admin-pipeline.ts`
- Modify: `client/src/pages/admin/help/admin-guide-page.tsx`

- [ ] Extend the stage edit state to include stage-gate requirement arrays.
- [ ] Add structured editors for required fields, required documents, and required approvals.
- [ ] Keep the page readable on desktop and smaller laptop widths.
- [ ] Update the admin guide text now that the UI editor exists.

### Task 4: Verification and review

**Files:**
- No additional code files required unless review findings demand them.

- [ ] Run focused tests and typechecks for server and client.
- [ ] Send the slice for code review.
- [ ] Fix findings and repeat review until clean.
- [ ] Push `main`, deploy, and smoke test the admin pipeline page in production.
