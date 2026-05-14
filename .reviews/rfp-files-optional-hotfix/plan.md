# RFP Files Optional Hotfix Plan

Date: 2026-05-14
Branch: `hotfix/rfp-files-optional`
Base: `origin/main` @ `58e16c4c`

## Assumption

`origin/main` already contains part of the intended runtime fix:

- `server/src/modules/deals/scoping-rules.ts` has `requiredAttachmentKeys = []`
- `server/src/modules/deals/scoping-service.ts` only treats attachments as blocking when they are also present in `requiredAttachmentKeys`
- `server/src/modules/deals/stage-gate.ts` already filters scoping attachment blockers through `requiredAttachmentKeys`

So the hotfix is now primarily:

1. Prove current runtime behavior with regression tests
2. Harden the RFP trigger path so attachment-only readiness noise cannot reintroduce blocking
3. Avoid touching unrelated workflow or lineage logic

## Planned Changes Per Scoped File

### 1. `server/src/modules/deals/scoping-rules.ts`

- Minimum change:
  - Keep attachments non-required.
  - Add a short inline comment documenting that scoping attachments remain uploadable/informational but do not gate readiness or RFP.
- Reason:
  - Runtime behavior is already aligned with policy, but the intent is not obvious.

### 2. `server/src/modules/deals/scoping-service.ts`

- Minimum change:
  - Keep `attachmentRequirements` for upload/display visibility.
  - Preserve the current `requiredAttachmentKeySet` filter that prevents attachment absence from forcing `draft`.
  - Add a short comment clarifying why unsatisfied attachment requirements are informational unless explicitly present in `requiredAttachmentKeys`.
- Reason:
  - This file already implements the desired non-blocking behavior for files.

### 3. `server/src/modules/deals/routes.ts`

- Minimum change:
  - Narrow `buildScopeIncompleteError` to message and block based on non-file scoping gaps only.
  - Ensure the trigger path cannot fail solely because `readiness.errors.attachments` is populated.
- Reason:
  - Even though current main no longer produces attachment blockers in the normal path, the route still conceptually treats attachment errors as trigger blockers.

### 4. `server/src/modules/deals/stage-gate.ts`

- Minimum change:
  - Preserve existing stage-gate behavior for section/field completeness.
  - Ensure estimating-entry blocking only reflects non-file scoping gaps, not informational attachment statuses.
- Reason:
  - Current main is close, but regression coverage should guarantee attachment-only gaps never block estimating entry.

### 5. `client/src/pages/deals/deal-detail-page.tsx`

- Minimum change:
  - Keep the `Trigger RFP` button gated by readiness status.
  - No runtime change unless a test exposes file-specific coupling here.
- Reason:
  - The button is already indirectly correct if the server no longer marks attachment absence as `draft`.

## Test Plan

- Add/adjust regression tests in:
  - `server/tests/modules/deals/scoping-service.test.ts`
  - `server/tests/modules/deals/manual-rfp-trigger-route.test.ts`
  - `server/tests/modules/deals/stage-gate.test.ts`
  - `client/src/pages/deals/deal-detail-page.test.tsx`

- Assertions to add:
  - Attachment-free but otherwise complete scoping becomes `ready`
  - Attachment-only readiness errors do not block `POST /api/deals/:id/trigger-rfp`
  - Attachment-only readiness errors do not block estimating/service-estimating transition
  - Missing non-file requirements still block as before
  - Deal detail `Trigger RFP` becomes enabled when readiness is `ready` without any uploaded files

## Out Of Scope

- `server/src/modules/deals/service.ts`
- `server/src/modules/internal-rfp/routes.ts`
- File upload/link/render behavior
- Any change to readiness labels (`draft` / `ready` / `activated`)
