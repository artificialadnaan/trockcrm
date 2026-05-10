# Project Type Backfill Discovery

Date: 2026-05-10
Branch: `feat/project-type-backfill`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-project-type-backfill`

## Repository State

- Based on `origin/main` at `b629551 docs(audit): record project number backfill run`.
- Recent merges include Track A conversion fix PR #204 (`b3d4523`) and Track B scope-tab GET write fix PR #205 (`3cda068`).
- Railway linked environment confirmed as `T Rock CRM / production / API`.

## Canonical Schema

- `public.project_type_config` shape in `shared/src/schema/public/project-type-config.ts`:
  - `id uuid primary key`
  - `name varchar(100)`
  - `slug varchar(100) unique`
  - `code varchar(8)`
  - `parent_id uuid`
  - `display_order integer`
  - `is_active boolean`
- `code` is stored as text (`varchar(8)`), so numeric HubSpot codes must be compared as trimmed strings.
- `office_*.deals.project_type_id` is present in Drizzle as `uuid("project_type_id")`.
- The actual FK is defined in SQL migrations: `project_type_id UUID REFERENCES public.project_type_config(id)`.
- `office_*.deals.project_type` still exists as legacy normalized text, but this track only backfills the canonical `project_type_id`.

## Production Project Type Config

Active rows:

| code | name | slug |
| --- | --- | --- |
| 1 | Exterior Renovation | exterior-renovation |
| 2 | Interior Renovation | interior-renovation |
| 3 | Roofing | roofing |
| 4 | Service | service |
| 5 | Commercial | commercial |
| 6 | Hospitality | hospitality |
| 7 | Emergency | emergency |
| 8 | Development | development |
| 9 | Residential | residential |

Inactive rows still present:

- Multifamily
- New Construction
- Traditional Multifamily
- Land Development
- Student Housing
- Senior Living
- Restoration

Note: `Maintenance` and `Other` were in the prior legacy list but are not present in production `public.project_type_config`.

## Production Counts

Read-only production query results:

| tenant | deals with `project_type_id IS NULL` |
| --- | ---: |
| office_dallas | 754 |
| office_atlanta | 0 |

Dallas is one row lower than the prior 755 discovery note.

Dallas active-only resolution using the decided precedence:

| bucket | count |
| --- | ---: |
| candidates examined | 754 |
| numeric `project_types` active-code matches | 606 |
| text `project_type` active-label matches after no numeric match | 57 |
| text `project_type` inactive-label matches after no numeric match | 2 |
| no preserved `project_types` or `project_type` | 77 |
| numeric/text conflicts where numeric wins | 40 |
| unmapped numeric codes | 0 |
| unmapped text labels | 44 |

Expected active-only updates without `--include-legacy`: 663 Dallas rows, 0 Atlanta rows.

## Preserved HubSpot Fields

Sample Dallas null-canonical rows confirm:

- `hubspot_extra_properties->>'project_types'` stores codes like `1`, `2`, `3`, `4`, `7`.
- `hubspot_extra_properties->>'project_type'` stores labels such as `Exterior Renovation`, `Interior Renovation`, and legacy labels.

The current sample includes already uppercase-office project numbers such as `DFW-4-08426-ab` and `ATL-1-03026-af`.

## Conflict Cases

There are 40 Dallas rows where numeric code and text label both resolve but disagree. Samples:

| hubspot_deal_id | deal | numeric | text |
| --- | --- | --- | --- |
| 169108941537 | Discovery at the Realm | 4 Service | Interior Renovation |
| 175110048458 | Hendrix Washer/ dryer additions | 4 Service | Interior Renovation |
| 178921261762 | 2-MMC.5-100125- Exterior door repair | 4 Service | Exterior Renovation |
| 212628222707 | Tides Park Lane Stair Tread Emergency | 4 Service | Exterior Renovation |
| 217561632505 | The Villages Reroof | 3 Roofing | Exterior Renovation |

The sampled values support the decided rule that numeric wins: code `4` marks several small repairs/emergency/service-like jobs even when the older text says renovation.

## No-Signal Rows

There are 77 Dallas rows with neither preserved field. Sampled fields include:

- `name`
- `description`
- `source`
- `bid_board_stage_slug`
- `bid_board_stage_status`
- HubSpot JSON keys such as `project_number`, `project_location`, `project_description__briefly_describe_the_project_`, `dealtype`

Sample no-signal deals:

| hubspot_deal_id | deal | old project_number | note |
| --- | --- | --- | --- |
| 169108971249 | Tides Lake Village- Unit 6034-104 | 2-TLV1-100125 | description implies mitigation, not a clean canonical type |
| 180555147971 | Avenues Craig Ranch | ASCRCLBHOU | description says clubhouse renovation |
| 187331613409 | Flats at 5 mile creek | TMFFMROOF | no clean project type field |
| 190563542746 | 4123 Cedar Springs | 2-CSP.1-101325 | old project number may imply code but Track C owns project numbers |
| 190570025678 | Patten West Bld 14 laundry room pipe break | 2-PWA2-111125 | no clean project type field |

Conclusion: do not invent fallbacks from descriptions or legacy project numbers. These rows go to manual triage.

The current legacy `deals.project_type` column does not add usable signal for this run:

- Dallas rows with `project_type_id IS NULL` and populated `deals.project_type`: 0
- Atlanta rows with `project_type_id IS NULL`: 0

## Inactive Text Matches

Two Dallas rows only match inactive `New Construction` and have no numeric active code:

- `32954400281` / `Rise North Arlington Fire building`
- `33050736675` / `Crown Houston`

Tonight's run should not pass `--include-legacy`, so these are skipped and included in manual triage.

## Validator / Track A Check

`server/src/modules/deals/service.ts` only blocks clearing project type at-or-beyond Opportunity:

- non-admin edits after Opportunity are forbidden;
- clearing is rejected when `newProjectTypeId` is falsy and no `projectTypeValue` is supplied;
- setting from null to a real active project type id is not the blocked path.

The backfill script will update the canonical DB column directly and will never set `project_type_id` to null.

Track A conversion logic now passes `projectTypeId` from leads into deal creation and resolves service routing from lead project type. This does not change the legacy Dallas backfill path, but it reinforces that canonical `project_type_id` is the desired field.

## Project Number Follow-Up

A naive `project_number <> upper(project_number)` count returns 425 Dallas rows because canonical suffixes are lowercase (`DFW-1-12826-aa`). The relevant issue is lowercase office prefixes/generator behavior:

- `server/src/services/projectNumber.ts` currently returns lower-case office prefixes in `buildProjectNumber`.
- `server/src/modules/deals/service.ts` currently computes `intendedProjectNumber` with `officeCode.toLowerCase()`.

This track will not modify project number code. File a follow-up issue if production samples show lowercase office prefixes or non-canonical values after the backfill run.
