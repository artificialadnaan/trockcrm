# Track A Conversion Project Type Discovery

Date: 2026-05-10
Branch: fix/lead-conversion-projecttype
Base: origin/main at ae41ee5

## Scope

Read-only discovery for the lead-to-deal conversion path. No code or data changes were made before this artifact.

## 1. Current bug verification

The bug still exists on current origin/main.

- `client/src/hooks/use-leads.ts:800-804` defines `convertLeadToOpportunity(leadId)` and posts to `/leads/${leadId}/convert` with no JSON body.
- `client/src/components/leads/lead-convert-dialog.tsx:28-33` calls `convertLeadToOpportunity(lead.id)` directly from the Convert button.
- `server/src/modules/leads/routes.ts:413-441` accepts the POST body, strips trusted fields, and passes the remaining body into `convertLead`.
- `server/src/modules/leads/conversion-service.ts:229-254` calls `createDeal` with `projectTypeId: input.projectTypeId`.
- Because the current UI sends no body, `input.projectTypeId` is `undefined`, so the created deal gets `projectTypeId: null` in `server/src/modules/deals/service.ts:990`.

## 2. End-to-end projectTypeId flow

1. Lead stores canonical project type at `leads.project_type_id`, declared in `shared/src/schema/tenant/leads.ts:82-83`.
2. Frontend conversion button sends no payload.
3. Route passes no `projectTypeId` to `convertLead`.
4. `convertLead` loads and locks the lead, derives workflow route and target Opportunity stage, then calls `createDeal`.
5. `createDeal` inserts `deals.project_type_id` from `input.projectTypeId ?? null`.

The conversion service already passes `projectType: lead.projectType ?? undefined`, but that is the legacy text field. It does not preserve the canonical FK.

## 3. Other conversion fields checked

Fields with existing lead fallback:

- `name`: `input.name ?? lead.name`
- `assignedRepId`: `input.assignedRepId ?? lead.salesRepId ?? lead.assignedRepId`
- `primaryContactId`: falls back to `lead.primaryContactId` when input is undefined
- `companyId`: `lead.companyId`
- `propertyId`: `lead.propertyId`
- `sourceLeadId`: `lead.id`
- `source`: `input.source ?? lead.source ?? undefined`
- `description`: `input.description ?? lead.description ?? undefined`
- `officeCode`: `lead.officeCode ?? "dfw"`
- `projectType`: `lead.projectType ?? undefined`

Fields that do not have matching lead columns and should not get invented fallbacks:

- `dealStageId`: conversion target control, not a lead field
- `workflowRoute`: derived by `resolveWorkflowRoute(lead)` and guarded against body mismatch
- `ddEstimate`, `bidEstimate`, `awardedAmount`: lead has `preQualValue`, not same semantics
- `regionId`: no matching lead column
- `expectedCloseDate`: no matching lead column

Only same-name dropped lead field found: `projectTypeId`.

## 4. Existing call sites and null/undefined behavior

Call sites found:

- `convertLeadToOpportunity(leadId)` sends no body. This is the live detail-page conversion path.
- `convertLead(leadId, input)` and `useLeadBoard().convertLead` can send `projectTypeId?: string | null`, but no repo call site was found intentionally sending explicit `projectTypeId: null`.
- Route tests intentionally verify trusted context fields cannot be overridden, but `projectTypeId` is not trusted context today.

Given the conversion endpoint's purpose, explicit `projectTypeId: null` should be treated the same as omitted for this fix: preserve the lead's project type. Clearing project type during conversion is almost certainly client error and recreates the broken Opportunity deal.

## 5. Downstream cascade when projectTypeId is null

- `createDeal` allows `projectTypeId` null and creates the deal.
- RFP enqueue does not appear to require project type. `server/src/modules/deals/rfp-enqueue.ts` builds delivery payload after Opportunity entry and reads company/contact/bid due date data; no project-type validation is visible in that enqueue path.
- Post-conversion enrichment marks `projectTypeId` missing. `server/src/modules/deals/post-conversion-enrichment.ts:28-33` includes `projectTypeId` in required converted-deal fields.
- Opportunity Scope tab can fail on mount. `server/src/modules/deals/scoping-service.ts:337-371` uses GET `/scoping-intake` as load-or-create. When no intake exists it seeds `projectTypeId: resolvedDeal.resolved.projectTypeId`; for a null project type this becomes null. For manual legacy deals without source lead, `upsertDealScopingIntake` can call `applyProjectTypeChange(..., null, ...)` and trigger `projectType cannot be cleared after Opportunity`. Converted deals with source lead avoid that exact manual-deal writeback branch, but they still carry an incomplete/null project type into scoping readiness and post-conversion enrichment.

## 6. Discovery conclusion

This track should make a backend-only conversion fix:

- Change conversion `projectTypeId` passed to `createDeal` from `input.projectTypeId` to `input.projectTypeId ?? lead.projectTypeId ?? undefined`.
- Widen `ConvertLeadInput.projectTypeId` to accept null because the client hook already types it as `string | null` and the route can pass request JSON null.
- Add regression coverage for omitted input, explicit different input, and explicit null.

No schema changes or migrations are needed.
