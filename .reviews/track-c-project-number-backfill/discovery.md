# Project Number Backfill Discovery

Date: 2026-05-10
Branch: feat/project-number-backfill

## Scope

Backfill only canonical project numbers preserved in `hubspot_extra_properties->>'project_number'`.
Legacy/freeform values remain null for manual triage.

Canonical regex:

```text
^(DFW|ATL)-[0-9]+-[0-9]{5}-[a-z]{2}$
```

## Schema

Source file: `shared/src/schema/tenant/deals.ts`

- `projectNumber: text("project_number")`
- `hubspotExtraProperties`: production column exists as `jsonb`
- `hubspotDealId`: `varchar(50)`

Migration source: `migrations/0104_redesign_a2_tier2_schema.sql`

- Adds `project_number text` to tenant `deals`
- Creates `deals_project_number_uidx`

Production column discovery:

```text
office_dallas.deals.project_number: text, nullable
office_atlanta.deals.project_number: text, nullable
office_dallas.deals.hubspot_extra_properties: jsonb, nullable
office_atlanta.deals.hubspot_extra_properties: jsonb, nullable
```

## Uniqueness

`project_number` uniqueness is tenant-local, not global:

```text
office_dallas.deals:  CREATE UNIQUE INDEX deals_project_number_uidx ON office_dallas.deals (project_number) WHERE project_number IS NOT NULL
office_atlanta.deals: CREATE UNIQUE INDEX deals_project_number_uidx ON office_atlanta.deals (project_number) WHERE project_number IS NOT NULL
```

Collision handling should therefore check existing `project_number` values within the same tenant. The script also detects duplicate canonical values within the candidate set before updating to avoid intra-batch unique-index failures.

## Production Counts

Read-only query via Railway Postgres shell.

```text
tenant          null_project  preserved  canonical  legacy  missing
office_dallas   755           736        425        311     19
office_atlanta    0             0          0          0      0
```

Canonical prefix breakdown:

```text
tenant         prefix  count
office_dallas  ATL     40
office_dallas  DFW     385
```

This differs from the initial brief's statement that Atlanta has 52 canonical preserved values. In the current production database, `office_atlanta` has no null `project_number` rows and no preserved candidates. The ATL-prefixed canonical values are currently in `office_dallas`.

Existing populated `project_number` values:

```text
office_dallas:  0
office_atlanta: 0
```

Candidate collisions with existing populated values:

```text
office_dallas:  0
office_atlanta: 0
```

Duplicate canonical candidates within the null-project candidate set:

```text
office_dallas:  0
office_atlanta: 0
```

## Samples

Legacy/freeform preserved samples that must stay null:

```text
1-ELC.1-061625
1-HPL1-081425
1-LGP.#1-090425
1-PKH-#1RPM-091225
1-PPW.1-08212025
1-RBR.1-093025
1-RNA.1-073125
1-SVE.1.-101025
1-THR.1-FCP-092425
1-TLV.1-081525
```

Canonical examples from the accepted rule:

```text
DFW-1-12826-aa
ATL-3-12526-ab
```

## Decision

Implement support for `office_dallas`, `office_atlanta`, and `all`.

Given current production data:

- `office_dallas --dry-run` should report about 425 eligible canonical updates, 311 legacy skips, and 19 missing skips.
- `office_atlanta --dry-run` should report 0 examined/eligible/skipped unless new data lands before execution.
- No existing-value collisions are expected today, but collision logic remains mandatory because `deals_project_number_uidx` is tenant-local and production data can change.

