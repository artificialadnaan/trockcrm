# Direct Deal Creation Office Code Diagnosis

## Scope

Investigated the `/deals/new` direct-create flow after PR #284 allowed deals without `sourceLeadId`. The observed production error is:

`officeCode must be 'dfw' or 'atl'`

## Surface Area

- Frontend create page: `client/src/pages/deals/deal-new-page.tsx`
- Frontend form submitter: `client/src/components/deals/deal-form.tsx`
- Frontend auth context: `client/src/lib/auth.tsx`
- Frontend office list hook: `client/src/hooks/use-accessible-offices.ts`
- Deal create API client: `client/src/hooks/use-deals.ts`
- Backend create route: `server/src/modules/deals/routes.ts`
- Backend create service and validation: `server/src/modules/deals/service.ts`
- Lead conversion contrast path: `server/src/modules/leads/conversion-service.ts`
- Office slug/code normalizer already in use for project numbers: `server/src/services/projectNumber.ts`

## Root Cause

`DealForm` builds a direct-create payload with user-entered deal fields, then appends:

- `stageId`
- `assignedRepId`
- `creationContext: "direct"`

It does not include `officeCode`.

The backend route strips unsafe client-supplied `creationContext`, `sourceLeadWriteMode`, and `migrationMode`, then calls `createDeal` with:

- `actorUserId: req.user!.id`
- `officeId: req.user!.activeOfficeId`
- `creationContext: "direct"`
- request body rest fields

`createDeal` immediately validates `input.officeCode` using `assertValidOfficeCode`, which accepts only `dfw` or `atl`. Since direct-create callers omit `officeCode`, validation receives `undefined` and throws the observed 400.

Lead conversion does not hit this bug because `server/src/modules/leads/conversion-service.ts` explicitly passes `officeCode: lead.officeCode ?? "dfw"` into `createDeal`.

## Active Office Context

Frontend canonical user context is `useAuth()` from `client/src/lib/auth.tsx`, which exposes:

- `user.officeId`
- `user.activeOfficeId`

Accessible office metadata is available from `useAccessibleOffices()`, backed by `GET /api/auth/accessible-offices`, returning `{ id, name, slug }`.

Backend canonical active office is `req.user!.activeOfficeId ?? req.user!.officeId`, populated by `authMiddleware`. For tenant-scoped routes, `tenantMiddleware` also resolves and attaches `req.officeSlug` from the active office.

## Office Code Mapping

The deal API requires short office codes:

- `dfw`
- `atl`

Existing normalizer: `server/src/services/projectNumber.ts` `resolveOfficeCode(location)` maps Atlanta/ATL to `atl` and defaults all other office names/slugs/codes to `dfw`. This is compatible with current Dallas/Atlanta offices and the existing project-number behavior.

## Other Missing Auto-Injections

Compared lead conversion and direct create:

- Already injected by backend direct route: `actorUserId`, `officeId`, `creationContext`.
- Already enforced by backend direct route: reps are assigned to themselves; admins/directors may assign.
- Missing and blocking: `officeCode`.
- Missing but not currently blocking: `projectType`. The direct form sends `projectTypeId`, while lead conversion sends both `projectType` and `projectTypeId`. `createDeal` currently generates project numbers from `projectType`, so direct-created deals can fall back to project type code `9` even when a structured `projectTypeId` is selected. This PR should derive `projectType` from the selected project type label/value on the frontend and preserve a backend fallback only when the client omits it.

## Fix Plan

1. Add a shared office-code resolver usable by frontend and backend.
2. Frontend: resolve the active office from `useAuth()` plus `useAccessibleOffices()`, inject `officeCode`, and block create with the inline error `Cannot create deal: no active office. Contact admin.` if unresolved.
3. Frontend: inject `projectType` from the selected project type option when `projectTypeId` is present.
4. Backend: if `officeCode` is missing, resolve it from `req.officeSlug` or the user active-office identifier as a safety net before calling `createDeal`.
5. Backend: preserve rejection of invalid explicit `officeCode` values.
6. Add regression tests for frontend explicit injection and backend missing-officeCode resolution.
