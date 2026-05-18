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
- `Would import / Imported`: records that resolved to one active CRM deal plus one mapped CRM user
- `Already imported`: records already present in the idempotency ledger with `status='imported'`
- `Skipped (orphan, no deal)`: HubSpot records with no active CRM deal match
- `Skipped (ambiguous, multiple deals)`: HubSpot records whose HubSpot deal associations resolve to multiple active CRM deals
- `Skipped (unmapped user)`: HubSpot owner could not be mapped to an active CRM user
- `Failed`: records whose write or mapping flow raised an exception

## Production verification

Production smoke is intentionally banned for this rollout.

Safe verification path:

1. Run `--dry-run` for `--type=note`
2. Review top deals and orphan/unmapped samples
3. Run `--execute` for `--type=note`
4. Inspect the ledger rows in `public.hubspot_activity_backfill_ledger`
5. Verify deal timelines through admin/read-only inspection rather than manual smoke mutation

## Safe reruns

Reruns are safe because:

- imported HubSpot records are tracked in `public.hubspot_activity_backfill_ledger`
- the unique key is `(tenant_schema, hubspot_object_type, hubspot_object_id)`
- imported rows are skipped on subsequent runs
- skipped and failed rows are upserted, so later reruns can replace stale skip/failure outcomes once underlying mappings are repaired

Implementation note:

- `--since` and `--limit` are local runner filters. HubSpot’s v3 object list endpoints do not provide a native timestamp filter for this flow, so the script may still need to page through the underlying type inventory before applying those filters.
