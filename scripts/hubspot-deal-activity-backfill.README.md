# HubSpot Deal Activity Backfill

Phase 1 pilot:

```bash
npx tsx scripts/hubspot-deal-activity-backfill.ts --office=office_dallas --type=note --dry-run
```

Phase 2 wider run:

```bash
npx tsx scripts/hubspot-deal-activity-backfill.ts --office=office_dallas --type=all --dry-run
```

Execute mode is always explicit:

```bash
npx tsx scripts/hubspot-deal-activity-backfill.ts --office=office_dallas --type=note --execute
```

Supported flags:

- `--office=<schema>` required
- `--type=<note|call|meeting|email|all>` defaults to `note`
- `--dry-run` optional; default behavior when `--execute` is not present
- `--execute` required for writes
- `--since=<YYYY-MM-DD>` optional post-fetch filter
- `--limit=<n>` optional per-type cap for testing
- `--deal-id=<uuid>` optional pilot mode for a single CRM deal

## How to read the report

- `Fetched`: HubSpot records fetched for the selected type after local filters
- `Would import / Imported`: records that resolved to one active CRM entity plus one mapped CRM user
- `Would import to deals / companies / contacts` and `Imported to deals / companies / contacts`: per-entity landing breakdown using resolution priority `deal > company > contact`
- `Already imported`: records already present in the idempotency ledger with `status='imported'`
- `Skipped (orphan, no entity match)`: HubSpot records with no active CRM deal, company, or contact match
- `Skipped (ambiguous, multiple entity matches)`: HubSpot records whose highest-priority HubSpot associations resolve to multiple active CRM records
- `Skipped (unmapped user)`: HubSpot owner could not be mapped to an active CRM user
- `Failed`: records whose write or mapping flow raised an exception

Resolution priority:

1. Direct HubSpot deal association -> CRM deal by `deals.hubspot_deal_id`
2. Otherwise HubSpot company association -> CRM company by `companies.hubspot_company_id` or legacy `companies.hubspot_id`
3. Otherwise HubSpot contact association -> CRM contact by `contacts.hubspot_contact_id`
4. Otherwise skip as orphan

## Production verification

Production smoke is intentionally banned for this rollout.

Safe verification path:

1. Run `--dry-run` for `--type=note`
2. Review top entities plus orphan/unmapped samples
3. Run `--execute` for `--type=note`
4. Inspect the ledger rows in `public.hubspot_activity_backfill_ledger`
5. Verify the matching deal, company, or contact activity timelines through admin/read-only inspection rather than manual smoke mutation

## Safe reruns

Reruns are safe because:

- imported HubSpot records are tracked in `public.hubspot_activity_backfill_ledger`
- the unique key is `(tenant_schema, hubspot_object_type, hubspot_object_id)`
- imported rows are skipped on subsequent runs
- skipped and failed rows are upserted, so later reruns can replace stale skip/failure outcomes once underlying mappings are repaired

Implementation note:

- `--since` and `--limit` are local runner filters. HubSpot’s v3 object list endpoints do not provide a native timestamp filter for this flow, so the script may still need to page through the underlying type inventory before applying those filters.
