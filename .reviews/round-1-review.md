## Findings

### P1 - Mixed Procore/change-order associations are still hidden by the client-side linked filter

The new server filters treat linked types as association predicates, so `linkedType=procore` returns any row with `procore_project_id IS NOT NULL` and `linkedType=change_order` returns any row with `change_order_id IS NOT NULL` (`server/src/modules/files/service.ts:267-270`, `server/src/modules/files/service.ts:744`). The page then applies a defensive client filter using `linkedType(file)`, but that helper returns the first matching association in priority order: deal, lead, contact, then procore/change_order (`client/src/pages/files/files-page.tsx:91-96`, `client/src/pages/files/files-page.tsx:453-459`).

That means a file with both `dealId` and `procoreProjectId`, or both `dealId` and `changeOrderId`, will be returned by the backend for the Procore/Change Orders filters and then removed before rendering. The label helper has the same precedence, so these mixed-association files are displayed as deal-linked even though they also have the new linked taxonomy. Since the upload/create model allows multiple association fields and these associations are not modeled as mutually exclusive, this leaves the Procore/change-order filter incomplete and contradicts the server-side taxonomy being added for this task. The client fallback needs to match the server predicate semantics, or the backend needs to enforce the same exclusive primary-link semantics explicitly.

### P2 - Library KPIs do not refresh after upload or delete

The page now sources header/metric/library totals from `useFileStats()` (`client/src/pages/files/files-page.tsx:445`, `client/src/pages/files/files-page.tsx:466-475`), but mutation paths still only call the file-list `refetch`. Delete calls `refetch()` after `deleteFileRecord` (`client/src/pages/files/files-page.tsx:487-492`), and upload passes `onUploadComplete={refetch}` to `FileUploadZone` (`client/src/pages/files/files-page.tsx:580`). Because `useFileStats` exposes its own `refetch` but it is not wired into either path (`client/src/hooks/use-files.ts:173-203`), the unfiltered KPIs remain stale until a full remount/page refresh after successful uploads or deletes.

This is a regression from the previous implementation where those totals were derived from the same `files` state that was refreshed by the existing upload/delete flow. The separate stats endpoint is the right direction for filter-independent scope, but the mutation completion path should refresh both the list and stats.

## Residual Risks

- I did not find issues with the basic `fileKind=photos|documents` database predicates, canonical category chip generation, `All Types` resetting the tab to `all`, or the new `aria-pressed` attributes on the view toggles.
- The patch keeps client-side defensive filters, which is reasonable, but any remaining mismatch between those filters and the backend predicates can still produce pagination/count surprises because the server response is already paginated before the client filter runs.
