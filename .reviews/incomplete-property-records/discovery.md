# Discovery: Incomplete Property Records on Lead and Deal Forms

## Coordination Read

- Branch: `fix/incomplete-property-records`
- Worktree: `/Users/adnaaniqbal/projects/trockcrm/.worktrees/fix-incomplete-property-records`
- Existing branch-local coordination files found before discovery: `.reviews/incomplete-property-records/in-progress.md`
- No other `.reviews/*/in-progress.md` files were present in this fresh worktree snapshot.
- Parallel-risk assumption: surrounding lead/deal form layout may move on other branches, so this branch keeps the implementation centered on the shared `PropertySelector`, existing lead property repair block, property PATCH service, and deal scoping property-change flow.

## Production Property Counts

Read-only Railway query run through the `Postgres` service using `.reviews/incomplete-property-records/property-discovery.mjs`.

| Schema | Total | Active | With street address | Missing street address | City/state only | Active missing street |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `office_dallas` | 740 | 725 | 33 | 707 | 581 | 707 |
| `office_atlanta` | 0 | 0 | 0 | 0 | 0 | 0 |
| `office_pwauditoffice` | 0 | 0 | 0 | 0 | 0 | 0 |

Sample incomplete records in `office_dallas`:

- Abacus Capital Group / `Spoke Pool and Amenity Renovation Property` / Atlanta, GA / no street / no ZIP
- Abacus Capital Group / `Banyon Grove Leasing Office  Property` / Virginia Beach, VA / no street / no ZIP
- Abacus Capital Group / `Banyon Grove Property` / Virginia Beach, VA / no street / no ZIP
- aflalorealty.com / `6010 Victor St - Concrete Replacement - Revival Property` / no city/state/street/ZIP
- amalgamated / `Gateway Cedars  Property` / forney, TX / no street / no ZIP
- AOG Living Management / `Aventine Apartments Property` / Fort Worth, TX / no street / no ZIP
- AOG Living Management / `Heather Glenn Townhomes Property` / no city/state/street/ZIP
- AOG Living Management / `Tiffany Square Town Homes Property` / no city/state/street/ZIP
- AOG Living Management / `Village at Fox Creek Property` / no city/state/street/ZIP
- Arey Group / `Lofts at Mercer Landing Property` / no city/state/street/ZIP

## DB Schema

Canonical model: `shared/src/schema/tenant/properties.ts`

- Table: `properties` in tenant schemas such as `office_dallas`
- Address columns:
  - `address` (`text`) - street address / address line 1
  - `city` (`varchar(255)`)
  - `state` (`varchar(2)`)
  - `zip` (`varchar(10)`)
- Identity/context columns used by selectors:
  - `id`
  - `company_id`
  - `name`
  - joined `companies.name` as `companyName`
- Other lead-create required property fields:
  - `build_year`
  - `unit_count`

No migration is required for this fix. Completeness is deterministic from nullable address columns, and persisting a flag would add consistency risk without solving the workflow blocker.

## UI Surfaces

Shared selector:

- `client/src/components/properties/property-selector.tsx`
  - Used by:
    - `client/src/components/leads/lead-form.tsx` for Lead form `Project Address`
    - `client/src/components/deals/deal-scoping-workspace.tsx` for Deal scoping `Property Details -> Change Property`
    - `client/src/components/deals/deal-form.tsx` for direct deal creation property selection

Lead form:

- `client/src/components/leads/lead-form.tsx`
- Current selector call passes `requireLeadCreateFields`.
- Existing inline repair only covers `buildYear` and `unitCount`.
- Current selected-property lookup prefers the parent `useProperties` list before `usePropertyDetail`, so a just-enriched property can remain stale if the list snapshot had the incomplete record.

Deal scoping form:

- `client/src/components/deals/deal-scoping-workspace.tsx`
- `handlePropertyChange` immediately calls `patchResolvedDealFields(deal.id, { propertyId })`, which copies the selected property snapshot into deal fields via `server/src/modules/deals/lineage-resolver.ts`.
- If the property is incomplete, the deal gets blank `propertyAddress`/`propertyZip` values.

## Validation and Server Behavior

Frontend lead validation:

- `client/src/components/leads/lead-form.tsx`
- `createRequirementErrors` blocks creation when the selected property lacks:
  - `property.address`
  - `property.city`
  - `property.state`
  - `property.zip`
  - `property.buildYear`
  - `property.unitCount`

Backend lead validation:

- `server/src/modules/leads/service.ts`
- `assertLeadCreateRequirements` has the same required property checks and raises `LEAD_CREATE_REQUIREMENTS_UNMET`.

Property API:

- `server/src/modules/properties/routes.ts`
- `PATCH /api/properties/:id` currently accepts only `buildYear` and `unitCount`.
- There is no admin-only guard on PATCH, so reps can already perform the existing property enrichment. The route needs a narrow extension for `address`, `city`, `state`, and `zip`.
- `POST /api/properties` intentionally requires a complete address through `validatePropertyAddressFields`; the production bug is migrated records, not normal user-created properties.

## Chosen UX Approach

Use one shared approach across the lead form, direct deal form, and deal scoping form:

1. `PropertySelector` visually flags incomplete address records in the dropdown.
2. Complete-address records sort before incomplete records.
3. Incomplete entries include property name, company name, and city/state/ZIP so duplicate city/state rows are distinguishable.
4. Selecting an incomplete address opens an inline repair panel immediately inside the selector instead of firing `onChange`.
5. The repair panel requests the missing address fields required by backend lead creation (`address`, plus city/state/ZIP if missing or invalid). This is broader than street-only because production samples often also lack ZIP, and the backend currently requires all four fields for lead creation.
6. Saving the repair calls `PATCH /api/properties/:id`, then fires `onChange` with the repaired property id so the lead/deal flow proceeds.
7. Lead form selected-property resolution should prefer freshly fetched `usePropertyDetail` over the stale parent list.

This keeps the submit gate honest: users are not silently blocked, and they can repair the exact property record inline before lead/deal submission.

## Assumptions

- Any authenticated CRM user who can select a property can enrich its missing address fields; no permission-system change is needed.
- We should not loosen backend lead create requirements in this PR, because downstream estimating, reports, and RFP handoff still expect usable address data.
- Existing complete properties should keep their current label behavior and selection path.
