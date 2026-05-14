# HubSpot Deals Re-Import Discovery

Date: 2026-05-14

## Assumptions

- The authoritative CSV for this run is `/Users/adnaaniqbal/Downloads/hubspot-crm-exports-all-deals-2026-05-14-1.csv`. The originally supplied `/mnt/user-data/uploads/...` path was not present in this shell session.
- `office_dallas` is the target tenant for this reconciliation, based on prior production usage and the fact that the live Dallas deals table contains the existing HubSpot-linked import population.
- This session remains read-only against production. No writes will occur without a separate explicit `--apply --confirm-production` execution later.

## Schema Findings

- Deal schema file: `shared/src/schema/tenant/deals.ts`
- HubSpot dedup column on deals: `hubspot_deal_id` (`hubspotDealId` in Drizzle)
- Soft-delete column on deals: `is_active` (`isActive` in Drizzle)
- Related timestamp for prior sync context: `last_synced_from_hubspot_at`
- Schemas with a `deals` table in production:
  - `office_atlanta`
  - `office_dallas`
  - `office_pwauditoffice`

## CSV Snapshot

- File used: `/Users/adnaaniqbal/Downloads/hubspot-crm-exports-all-deals-2026-05-14-1.csv`
- Rows: `802`
- Columns: `269`
- Verified header starts with `Record ID`, `Amount`, etc.

## Production Counts (office_dallas)

Read-only queries run against production via the configured public Postgres URL:

- Total deals: `836`
- Active deals: `801`
- Inactive deals: `35`
- Active deals with populated `hubspot_deal_id`: `784`
- Distinct active `hubspot_deal_id`: `784`
- Inactive deals with populated `hubspot_deal_id`: `2`

## Initial Discrepancy Read

- CSV rows: `802`
- Active CRM deals: `801`
- Active CRM deals with HubSpot IDs: `784`
- Raw gap between CSV rows and active HubSpot-linked CRM deals: `18`

This does **not** yet mean 18 rows should be created. Some of that gap may be explained by:

- active CRM deals created natively without a HubSpot ID
- inactive CRM deals that still carry a HubSpot ID
- rows whose HubSpot ID exists but whose CRM record has older/newer field values
- ambiguous secondary matches by project number + deal name + create date

The dry-run reconciliation script will classify those cases explicitly before any write plan is considered.
