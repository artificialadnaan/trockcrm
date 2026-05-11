# Projects Tab Discovery Verification

Date: 2026-05-11

## Discovery Status

I re-read the `/tmp/projects-tab-discovery/` package and verified the load-bearing files in this worktree. No halt condition is triggered.

One important implementation detail: the SyncHub -> CRM relay payload does **not** include a full Procore project snapshot today. It includes enough data to create a minimal CRM project row and link it to a deal. Rich metadata/team/documents must come from backfill or future detail polling.

## Exact SyncHub -> CRM Relay Payload Shape

Source: `/Users/adnaaniqbal/projects/trocksynchubv3/server/trockcrm-relay.ts`

```ts
type TrockCrmRelayPayload = {
  eventType: "procore.project.created";
  source: "synchub";
  procore: {
    companyId: string;
    portfolioProjectId: string;
    projectNumber: string;
    projectName: string;
  };
  synchub: {
    webhookLogId: string;
    syncMappingId: string;
    bidboardProjectId: string | null;
    hubspotDealId: string | null;
    receivedAt: string;
    enrichedAt: string;
  };
  rawProcoreWebhook: {
    id: string;
    reason: string;
    resource_type: string;
    resource_id: string;
  };
};
```

Current CRM validator in `server/src/modules/synchub/procore-project-relay-service.ts` accepts the same core shape and treats `rawProcoreWebhook` as unknown.

## SyncHub `procore_projects` Table Columns

Source: `/Users/adnaaniqbal/projects/trocksynchubv3/shared/schema.ts`

- `id`
- `procore_id`
- `name`
- `display_name`
- `project_number`
- `address`
- `city`
- `state_code`
- `zip`
- `country_code`
- `phone`
- `active`
- `stage`
- `project_stage_name`
- `start_date`
- `completion_date`
- `projected_finish_date`
- `estimated_value`
- `total_value`
- `store_number`
- `delivery_method`
- `work_scope`
- `company_id`
- `company_name`
- `properties`
- `last_synced_at`
- `procore_updated_at`
- `last_role_check_at`
- `created_at`
- `updated_at`

Related SyncHub mirrors:

- `procore_change_history`: field-level changes and snapshots.
- `procore_role_assignments`: project team/role assignments.
- `trockcrm_relay_outbox`: durable CRM relay queue.
- `sync_mappings`: HubSpot/BidBoard/Portfolio/CompanyCam bridge.

## Procore Phase Values

Known default US Procore phases from official docs and discovery:

- Concept
- Bidding
- Pre-Construction
- Course of Construction
- Post-Construction
- Warranty

I could not query live distinct SyncHub `procore_projects` phase values because the local SyncHub checkout does not have an `.env` file with DB credentials. The implementation will mirror phase names exactly from payload/backfill data and not hard-code a translation layer.

## SyncHub Capture Coverage

From `server/procore.ts` and `shared/schema.ts`:

- Dates: yes. Captures `start_date`, `completion_date`, `projected_finish_date`.
- Financials: partial. Captures `estimated_value` and `total_value`; no separate budget breakdown table found in the project mirror.
- Team/roles: yes. Captures role assignments in `procore_role_assignments` using `/rest/v1.0/project_roles`.
- Documents: not in `procore_projects`; document APIs are known, but no project documents mirror table was found in SyncHub's main schema excerpt.
- Raw snapshot: yes. Captures the source project payload in `procore_projects.properties`.

## CRM Files Verified

- `server/src/modules/procore/sync-service.ts`
- `server/src/modules/procore/webhook-routes.ts`
- `server/src/modules/synchub/procore-project-relay-routes.ts`
- `server/src/modules/synchub/procore-project-relay-service.ts`
- `client/src/pages/projects/projects-page.tsx`
- `client/src/pages/projects/project-detail-page.tsx`
- `shared/src/schema/tenant/deals.ts`

## Implementation Implications

- Relay upsert must support minimal payloads.
- Backfill must use the existing CRM `procoreClient`; no new Procore API client.
- Projects tables must be tenant-scoped.
- Frontend must be display-only.
- `/projects` can replace the existing deal-backed UI, but existing routes must remain valid.

