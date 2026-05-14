# Scoping Form UX Discovery

Date: 2026-05-14
Branch: `fix/scoping-form-ux`
Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-scoping-form-ux`

## Coordination Read

- `.reviews/timeline-status-save/in-progress.md`: owns lead Timeline persistence, expected files in lead form / lead questionnaire / lead APIs. No direct conflict expected.
- `.reviews/estimator-notes-backspace/in-progress.md`: owns the Estimator Consultation Notes field and related autosave/input-clobbering diagnosis in the deal scoping form.
- `.worktrees/fix-incomplete-property-records` exists but has no `.reviews/*/in-progress.md` file in that worktree.

This branch owns only:

- Scoping Progress sidebar and Blocking Items scroll behavior.
- Scope docs / Site photos required-status removal.
- Scope section hierarchy, required visual marker, scope selection validation, and scope-selection save behavior.

This branch must not touch the Estimator Consultation Notes field internals beyond regression verification.

## Component Location

- Root component: `client/src/components/deals/deal-scoping-workspace.tsx`.
- Render location: `client/src/pages/deals/deal-detail-page.tsx` renders `DealScopingWorkspace` in the Scoping / Opportunity Scope tab.
- Existing focused unit tests: `client/src/components/deals/deal-scoping-workspace.test.ts`.
- Shared client label/count helpers: `client/src/lib/scoping-intake.ts`.
- Server readiness rules: `server/src/modules/deals/scoping-rules.ts`.
- Server readiness + attachment requirement shaping: `server/src/modules/deals/scoping-service.ts`.
- RFP readiness blocking endpoint path: `server/src/modules/deals/routes.ts` calls `evaluateDealScopingReadiness` before manual RFP trigger.

No `AGENTS.md`, `CLAUDE.md`, or `GEMINI.md` files were found under the worktree within the first three levels.

## Form State / Autosave Model

- The deal scoping workspace is a single-page React component, not a multi-step wizard.
- It does not use `react-hook-form`; it uses local React state:
  - `sectionData`
  - `projectTypeId`
  - `readiness`
  - `saveState`
- `updateField(section, field, value)` mutates local `sectionData`.
- A `useEffect` watches `{ projectTypeId, sectionData }`, waits 400ms, then calls:
  - `patchResolvedDealFields` for lead-owned converted-deal fields.
  - `patchDealScopingIntake` for scoping intake data.
- After every autosave, the component currently calls `buildWorkspaceSectionData(deal, result.intake, result.resolved)` and writes the server response back into `sectionData`.
- That server-response rehydration is the likely source of the awkward refresh/re-render behavior. It is also the same pattern class that `fix/estimator-notes-backspace` is investigating for text input clobbering.

## Bug 1: Sidebar / Blocking Items

Current behavior:

- `SECTION_ORDER` lists Project Overview, Opportunity Review, Property Details, Scope Summary, and Attachments.
- The sidebar renders each section as a static `<div>` with status icon.
- Blocking Items renders missing section fields and missing attachments as static red `<div>` text.
- The right-side form is one scrollable page of cards.

Fix approach:

- Add stable section DOM ids and field DOM ids.
- Render sidebar rows as buttons with `scrollIntoView({ behavior: "smooth", block: "start" })`.
- Render section Blocking Items as buttons that scroll to the specific field id.
- Avoid changing `sectionData`, `projectTypeId`, route state, or query params during scroll, so unsaved form state is preserved.

## Bug 2: Scope Docs / Site Photos Optionality

Current behavior:

- Client:
  - `normalizeWorkspaceReadiness` falls back to required attachment keys from `getDefaultAttachmentRequirementKeys`.
  - Attachment cards show a `Required` badge when missing.
  - Blocking Items includes unsatisfied `attachmentRequirements`.
- Server:
  - `server/src/modules/deals/scoping-rules.ts` requires `scope_docs` and `site_photos` for standard workflow and `site_photos` for service workflow.
  - `server/src/modules/deals/scoping-service.ts` creates `attachmentRequirements`, calculates `missingAttachments`, marks readiness `draft`, and writes `readiness.errors.attachments`.
  - RFP trigger uses those readiness errors as hard blockers.

Decision:

- Scope docs and Site photos will remain visible in the Attachments card as optional upload/link opportunities.
- They will be removed from hard readiness validation and removed from Blocking Items.
- Reason: the prompt default is to remove them from Blocking Items so the sidebar only shows actually blocking issues. That avoids reps reading optional reminders as hard stop conditions.

## Bug 3: Scope Section Hierarchy / Save Behavior

Current behavior:

- There is no standalone `Scope` section card in the deal scoping workspace.
- The closest current control is `Project Type` inside the generic `Scoping Workspace` card.
- Project type is persisted as `projectTypeId` and is currently not required by `evaluateScopingReadiness`.
- The prompt names Roofing, Exterior Paint, Parking Lot, etc. In this codebase those are represented by active project type records from `useProjectTypes()` / `/api/pipeline/project-types`.

Implementation assumption:

- The new `Scope` section should be a dedicated card built from active project types.
- The first selected item remains the legacy primary `projectTypeId` for downstream compatibility.
- Multiple selected scope items will persist in intake JSON at `sectionData.scope.selectedProjectTypeIds`.
- Existing deals with a legacy `projectTypeId` but no `sectionData.scope.selectedProjectTypeIds` should not be broken; the UI and readiness logic should treat the legacy `projectTypeId` as one selected scope item until the user changes it.
- Submitting / RFP readiness with zero selected scope items should fail via server readiness under `errors.sections.scope = ["selectedProjectTypeIds"]`.

Save behavior risk and coordination:

- For scope selection, avoid rehydrating local `sectionData` from the server response after autosave if the server echoes a value that could clobber active UI state.
- Preserve the existing Estimator Consultation Notes field and do not change its handler.
- If `fix/estimator-notes-backspace` lands first, rebase and adopt its state ownership pattern.
- If this branch lands first, the pattern established here is: update local state immediately, persist via existing debounced autosave, update readiness/intake metadata from the response, but avoid replacing the currently edited local scope selection from a stale or normalized response.

## Validation Surface

Required server changes:

- `server/src/modules/deals/scoping-rules.ts`
  - Add required `scope` section.
  - Validate `scope.selectedProjectTypeIds` or legacy `projectTypeId` as the selected scope item source.
  - Stop requiring attachment keys.
- `server/src/modules/deals/scoping-service.ts`
  - Stop producing hard missing attachment readiness errors.
  - Keep optional `attachmentRequirements` metadata for UI display.
  - Seed/normalize scope selection from legacy `projectTypeId` so existing production data remains valid.

Required client changes:

- `client/src/components/deals/deal-scoping-workspace.tsx`
  - Add clickable sidebar and blocking item scroll targets.
  - Add a distinct required `Scope` card.
  - Render multiple project type options as selectable buttons/checkboxes.
  - Mark attachments optional and remove Required badge.
  - Keep save indicator subtle through the existing `saveState` chip.
- `client/src/lib/scoping-intake.ts`
  - Add labels for `scope` and `selectedProjectTypeIds`.
- Tests:
  - Add focused unit tests before implementation.
  - Add `scripts/smoke-scoping-form-ux.ts` for production smoke.

## No Migration Expected

The multi-select scope values fit the existing JSONB `deal_scoping_intake.section_data`; no schema migration is expected.
