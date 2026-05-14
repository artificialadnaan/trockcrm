# Lead Form Field Batch Discovery

Date: 2026-05-14  
Branch: `fix/lead-form-field-batch`  
Base: `origin/main` at `24f9c1c1bfd544af99620f79c87af377dd7ac12d`

## Assumptions

- The production API Dockerfile runs `node server/dist/migrations/runner.js` before `server/dist/index.js`, so a new idempotent SQL migration is the startup migration path for enum/questionnaire changes.
- The project should preserve legacy POC role enum values in storage because existing rows may still hold them, but the lead form create/edit dropdown should only offer the new business-approved option list.
- For Budget vs Estimated Value, "remove" means remove from active UI/write path and preserve existing stored answers for audit/history. This PR will not destructively drop JSON answers or DB columns.
- For Life Safety, the initial discovery default was to log non-empty free text and unset it. Round 1 review found that would turn required production answers into missing gate data after deploy. Final policy: log the originals, map recognizable negative/not-applicable values (`no`, `n/a`, `na`, `none`, `not applicable`) to `false`, and map other non-empty strings to `true` for manual review without blocking existing records.

## Coordination

- Existing `.reviews/*/in-progress.md` files: none found in this worktree before discovery.
- Declared branch coordination file: `.reviews/lead-form-field-batch/in-progress.md`.
- Expected files touched after discovery:
  - `shared/src/types/enums.ts`
  - `client/src/lib/lead-display-labels.ts`
  - `client/src/components/leads/lead-form.tsx`
  - `client/src/components/leads/lead-questionnaire-sections.tsx`
  - `client/src/components/deals/deal-scoping-workspace.tsx`
  - `server/src/modules/leads/service.ts`
  - `migrations/0117_lead_form_field_batch.sql`
  - focused tests under `client/src/components/leads`, `client/src/components/deals`, `server/tests/modules/leads`
  - `scripts/smoke-lead-form-batch.ts`

## Form Surface

- Main lead create/edit component: `client/src/components/leads/lead-form.tsx`.
- Universal questionnaire renderer: `client/src/components/leads/lead-questionnaire-sections.tsx`.
- Deal scoping Opportunity Review component: `client/src/components/deals/deal-scoping-workspace.tsx`.
- POC role labels: `client/src/lib/lead-display-labels.ts`.
- POC role enum source: `shared/src/types/enums.ts`.
- V2 questionnaire nodes are stored in `public.project_type_question_nodes` and rendered from `/leads/questionnaire-template`.
- Form library: custom React state and local validation. No `react-hook-form` or Formik in the lead form path.

## Bug-by-Bug Findings

### Bug 1 - POC Role Options

- Current enum/options: `property_manager`, `construction_manager`, `director`, `other`.
- Current form uses `LEAD_POC_ROLES` directly, so storage enum values and dropdown options are coupled.
- Required fix: add new enum values and labels; keep legacy enum values for existing data compatibility; introduce a form option list containing only:
  - Regional Manager
  - Regional VP
  - VP
  - Asset Manager
  - Facilities Manager
  - Project Manager
  - Other
- Production enum type currently exists as `public.lead_poc_role` with labels `{property_manager,construction_manager,director,other}`.

### Bug 2 - Lead Name Required Indicator

- Validation blocks missing lead name in `handleSubmit`.
- The create/edit label currently uses plain `<Label htmlFor="name">Lead Name</Label>`, unlike required fields using `QuestionLabel required`.
- Required fix: switch Lead Name to `QuestionLabel required` and render a field-level required message consistently in create mode.

### Bug 3 - Currency Prefixes

- Estimated Value is `qualificationPayload.estimated_value` in Sales Validation Fields, rendered as a raw number input.
- Budget is a universal questionnaire `currency` node, rendered as a raw number input by `LeadQuestionnaireSections`.
- Other lead questionnaire currency fields include `unit_upgrades_cost_per_unit` / "Cost per Unit / Average Budget".
- Required fix: use a shared local currency input treatment with a `$` prefix for `estimated_value` and questionnaire `inputType === "currency"` fields.

### Bug 4 - `__unanswered__` Dropdown Placeholder

Occurrences found:

- `client/src/components/leads/lead-questionnaire-sections.tsx`
  - boolean questions
  - select questions
- `client/src/components/leads/lead-form.tsx`
  - legacy/non-V2 boolean questions

Root cause:

- The sentinel value is used as a selected option, so the displayed item can look like a real answer. In some UI/test paths it can surface as the raw sentinel.

Required fix:

- Keep a non-empty sentinel internally for shadcn/Radix Select compatibility, but display `Select...` as a muted placeholder option and convert it to `null`/empty on change.

### Bug 5 - Opportunity Review Dropdowns

- Component: `client/src/components/deals/deal-scoping-workspace.tsx`.
- Current values:
  - `preBidMeetingCompleted`: `__unset__`/Pending, `yes`/Completed.
  - `siteVisitDecision`: `__unset__`/Pending, `required`/Site Visit Required, `not_required`/No Site Visit Required.
  - `siteVisitCompleted`: `__unset__`/Pending, `completed`/Completed.
- Backend scoping rule currently requires `siteVisitCompleted` only when `siteVisitDecision === "required"`.
- Required fix per prompt:
  - Pre-Bid Meeting Completed options become Scheduled / Reviewing / Completed.
  - Site Visit Decision options become Scheduled / Reviewing / Completed.
  - Leave Site Visit Completed as Pending / Completed unless discovery shows otherwise.
- Discovery decision: leave Site Visit Completed unchanged. The prompt explicitly defaults to leaving it alone, and no code path indicates it should adopt the new 3-option progress set.

### Bug 6 - Estimated Value vs Budget Consolidation

Downstream references:

- `qualificationPayload.estimated_value` is referenced by:
  - lead conversion gating: `server/src/modules/leads/conversion-service.ts`
  - lead stage gate checklist: `server/src/modules/leads/stage-gate.ts`
  - questionnaire gate evaluation: `server/src/modules/leads/questionnaire-service.ts`
  - lead detail/list display and tests
- `Budget` questionnaire answer is a universal project question and is not the primary downstream gate field.

Production data counts, read-only via Railway Postgres:

| Schema | Leads | Estimated Value count | Budget answer count | Estimated-only | Budget-only | Both |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `office_atlanta` | 0 | 0 | 0 | 0 | 0 | 0 |
| `office_dallas` | 53 | 27 | 16 | 11 | 0 | 16 |
| `office_pwauditoffice` | 0 | 0 | 0 | 0 | 0 | 0 |

Decision:

- Keep `qualificationPayload.estimated_value`.
- Deactivate the universal `budget` question node for future forms.
- Backfill `qualificationPayload.estimated_value` from the Budget answer only where Estimated Value is missing.
- Do not drop the Budget answer data in this PR.

Required-vs-optional treatment:

- Estimated Value is required by downstream Sales Validation/conversion gates, but lead creation currently allows early leads before Sales Validation is complete. The UI should show it as required in the Sales Validation section because that is the retained field, while create-submit gating remains unchanged to avoid blocking initial lead creation unexpectedly.

### Bug 7 - Life Safety Dropdown

- Current node: `life_safety`, label `Life Safety`, `input_type = 'textarea'`, `is_required = true`.
- Production non-empty Life Safety answer counts:
  - `office_dallas`: 15
  - other office schemas: 0
- Sample values include:
  - `Smoke test answer`
  - `standard access`
  - `fdsa`
  - `fsda`
  - `sure`
  - `NA`, `N/A`, `n/a`
  - `no`, `No`
- Required fix:
  - Change active Life Safety node to boolean, rendering as Yes/No dropdown.
  - Log existing non-empty free-text values to a migration audit table.
  - Convert logged answers to boolean JSON using the documented negative/not-applicable mapping, preserving the audit trail for manual review.

## Migration Plan

New migration: `migrations/0117_lead_form_field_batch.sql`.

Idempotent actions:

1. Add new POC role enum values to `public.lead_poc_role`.
2. Backfill missing `qualification_payload.estimated_value` from active Budget question answers across office schemas.
3. Deactivate active universal `budget` questionnaire node.
4. Change active `life_safety` questionnaire node to `input_type = 'boolean'`.
5. Create `public.lead_form_field_batch_life_safety_audit`.
6. Insert non-empty pre-migration Life Safety free-text values into the audit table once.
7. Convert logged Life Safety answers to boolean JSON: obvious negative/not-applicable values become `false`, other non-empty free-text values become `true`. This avoids silently dropping data or blocking required-question gates.

## Test Plan

- Add failing UI tests before implementation for:
  - POC role options.
  - Lead Name required marker/message.
  - currency prefix on retained Estimated Value and questionnaire currency inputs.
  - no visible `__unanswered__`.
  - Budget question hidden when active nodes no longer include it.
  - Life Safety rendered as a Yes/No dropdown.
  - Opportunity Review new Scheduled / Reviewing / Completed options.
- Add server migration/validation coverage for new POC values where practical.
- Run focused tests, typecheck, build, and production smoke after deploy.
