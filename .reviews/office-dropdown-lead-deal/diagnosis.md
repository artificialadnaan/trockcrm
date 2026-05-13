# Office Dropdown Lead/Deal Diagnosis

## Discovery Summary

- Lead creation currently hardcodes `officeCode: "dfw"` in `client/src/components/leads/lead-form.tsx`.
- Direct deal creation currently auto-injects `officeCode` from the user's active office in `client/src/components/deals/deal-form.tsx`, using `useAccessibleOffices()` and `resolveOfficeCodeFromOffice()`.
- Backend deal creation already preserves precedence from PR #289: explicit `officeCode` is used first, and missing `officeCode` falls back to the request's active office slug.
- Backend lead creation requires explicit `officeCode` and validates it with the same `dfw | atl` allowlist.
- The existing tenant switch is the `X-Office-Id` header in `authMiddleware`; `tenantMiddleware` uses `req.user.activeOfficeId` to choose the `office_<slug>` schema and exposes `req.officeSlug`.
- Project/deal number generation reads `deals.office_code` through `generateDealNumberForProject()`, so a selected `atl` code yields an `ATL-...` deal number when the create request carries that explicit code.

## Office Data and Permissions

- Canonical production-facing office codes are `dfw` and `atl`.
- Office rows are represented by `public.offices` with slugs like `dallas` and `atlanta`; `resolveOfficeCodeFromOffice()` maps those to `dfw` and `atl`.
- `/api/auth/accessible-offices` returns all active offices for admins and the user's primary office plus `public.user_office_access` rows for non-admin users.
- Assumption documented for this PR: the dropdown uses offices returned by `/api/auth/accessible-offices`. If a rep must create in ATL, that rep needs ATL in their accessible-office set. This respects the existing cross-office permission model instead of silently bypassing it.

## Cross-Office Routing

- Merely sending `officeCode: "atl"` from a Dallas request is not enough. The row would still be inserted in the Dallas tenant schema because `req.tenantDb` is bound before route handlers run.
- Correct routing requires both:
  - request payload `officeCode` for prefix/legacy office fields, and
  - `X-Office-Id` for the selected office so tenant middleware writes to the selected office schema.
- Company, property, and contact IDs are tenant-schema records. To avoid submitting Dallas IDs into the Atlanta schema, lead/deal creation forms must scope company search/create, property list/create/detail, contact list/create, assignee list, and final create requests to the selected `officeId`.
- When the selected office changes during create, existing company/property/contact selections should be cleared because their IDs belong to the previous tenant scope.

## Downstream Routing

- Lead and deal board routes read from the current tenant schema selected by `X-Office-Id`/active office. Records created in the selected office schema will appear in that office's board and not the user's home office board.
- Reports have existing office-code fallback filters for legacy rows, but normal operational routing is tenant-schema based.
- Notification/job queue paths already take `officeId` from the request active office or create input. Scoping create requests with `X-Office-Id` keeps queued side effects aligned with the selected office.

## Implementation Plan

- Add a required create-only Office dropdown to lead and direct-deal forms.
- Place Office directly above Project Type in both forms.
- Default Office from the user's active office when resolvable, otherwise the first accessible DFW/ATL office.
- Submit explicit `officeCode` and pass selected `officeId` as `X-Office-Id` on create-path API calls.
- Keep PR #289 backend fallback unchanged for API callers that omit `officeCode`.
- Add tests for default selection, manual ATL override, request header routing, and invalid explicit office-code rejection staying intact.

