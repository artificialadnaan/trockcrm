# HubSpot Deals Re-Import Dry Run

## Assumptions

- Dry-run only. No production writes were performed.
- Target tenant: `office_dallas`
- CSV path: `/Users/adnaaniqbal/Downloads/hubspot-crm-exports-all-deals-2026-05-14-1.csv`
- Dedup key: `hubspot_deal_id`
- Secondary safety check for creates: same project number + same deal name + create date within 24h
- Safe update fields only: amount, deal_name, project_number, project_type, last_modified_at

## Bucket Counts

- EXISTS_UNCHANGED: 785
- EXISTS_NEWER_IN_CSV: 15
- MISSING: 0
- AMBIGUOUS: 0
- SOFT_DELETED: 2
- Skipped field-clears (blank CSV vs non-null CRM): 0
- Ambiguous rate: 0.00%
- Hard stop threshold breached: no

## Sample Rows

### EXISTS_UNCHANGED
| HubSpot Record ID | Deal Name | Project Number | Create Date | Stage |
| --- | --- | --- | --- | --- |
| 324845155013 | Waters Edge At Mansfield | DFW-4-13226-ae | 2026-05-12T19:52:00.000Z | Closed Won |
| 322269410002 | Tides Park Lane | DFW-4-11426-aa | 2026-04-24T13:31:00.000Z | Service - Estimating |
| 323517795024 | Cottages at Bedford | DFW-1-12626-aa | 2026-05-06T12:22:00.000Z | Internal Review |
| 319860772597 | Hidden Ridge Apartments | DFW-1-09726-aa | 2026-04-07T16:56:00.000Z | Internal Review |
| 323519184582 | Hidden Ridge laundry rooms/unit 2072 | DFW-2-12526-aa | 2026-05-05T19:44:00.000Z | Internal Review |
| 324845154005 | Neuhaus Lake Worth | DFW-4-13226-ad | 2026-05-12T19:45:00.000Z | Estimating |
| 324965696186 | 3883 turtle creek | DFW-4-13326-ac | 2026-05-13T20:10:00.000Z | Proposal Sent |
| 323641734879 | Presidio River East | DFW-4-12626-ad | 2026-05-06T20:07:00.000Z | Closed Won |
| 324965692122 | The Hendry | DFW-4-13326-ab | 2026-05-13T19:36:00.000Z | Closed Won |
| 321440797413 | Tides on 51st Street | DFW-1-11026-ab | 2026-04-20T13:40:00.000Z | Internal Review |

### EXISTS_NEWER_IN_CSV
| HubSpot Record ID | Deal Name | Project Number | Create Date | Stage |
| --- | --- | --- | --- | --- |
| 316634100467 | watersong villas | DFW-1-07626-ac | 2026-03-17T20:25:00.000Z | Internal Review |
| 324287813317 | Premier Apartments | ATL-1-12826-af | 2026-05-08T16:50:00.000Z | RFP |
| 324282042060 | Cottages of Bedford pool renovation | DFW-1-12826-ae | 2026-05-08T14:58:00.000Z | Pipe Line |
| 276777157317 | Avela Real Estate Partners | DFW-5-02826-ac | 2026-01-28T18:12:00.000Z | Estimating |
| 323527098093 | Amherst Apartments roof | DFW-3-12526-ad | 2026-05-05T20:22:00.000Z | Pipe Line |
| 323231764174 | The Locale Fayetteville | DFW-1-12026-ab | 2026-04-30T14:33:00.000Z | Estimating |
| 315801099985 | Tides on Royal Lane North | DFW-4-07026-ac | 2026-03-11T17:28:00.000Z | Deal Canceled |
| 318904216306 | Tides Royal Lane North | DFW-4-09026-am | 2026-03-31T20:28:00.000Z | Deal Canceled |
| 259780904640 | Crestview Commons | DFW-1-01326-ab | 2026-01-13T18:07:00.000Z | Deal Canceled |
| 262368118502 | Park 220 | DFW-1-01426-aa | 2026-01-14T20:00:00.000Z | Deal Canceled |

### MISSING
_None_

### AMBIGUOUS
_None_

### SOFT_DELETED
| HubSpot Record ID | Deal Name | Project Number | Create Date | Stage |
| --- | --- | --- | --- | --- |
| 323231075004 | The Avenues at Holcomb Bridge | ATL-1-12026-af | 2026-04-30T19:50:00.000Z | Deal Canceled |
| 324288514808 | 4600 Ross | DFW-4-12826-aa | 2026-05-08T13:16:00.000Z | Deal Canceled |


## Update Field Diffs

| HubSpot Record ID | Deal Name | Field | CRM Value | CSV Value |
| --- | --- | --- | --- | --- |
| 316634100467 | watersong villas | last_modified_at | 2026-05-10T21:10:21.289Z | 2026-05-14T01:11:00.000Z |
| 324287813317 | Premier Apartments | last_modified_at | 2026-05-12T02:31:35.732Z | 2026-05-14T14:09:00.000Z |
| 324282042060 | Cottages of Bedford pool renovation | last_modified_at | 2026-05-12T02:31:36.834Z | 2026-05-14T14:22:00.000Z |
| 276777157317 | Avela Real Estate Partners | last_modified_at | 2026-05-10T19:29:34.405Z | 2026-05-13T12:07:00.000Z |
| 323527098093 | Amherst Apartments roof | last_modified_at | 2026-05-12T02:31:34.242Z | 2026-05-13T14:55:00.000Z |
| 323231764174 | The Locale Fayetteville | last_modified_at | 2026-05-10T21:09:25.337Z | 2026-05-13T22:01:00.000Z |
| 315801099985 | Tides on Royal Lane North | last_modified_at | 2026-05-11T14:19:46.648Z | 2026-05-11T21:58:00.000Z |
| 318904216306 | Tides Royal Lane North | last_modified_at | 2026-05-11T13:23:18.917Z | 2026-05-11T21:58:00.000Z |
| 259780904640 | Crestview Commons | last_modified_at | 2026-05-10T19:29:45.558Z | 2026-05-12T14:21:00.000Z |
| 262368118502 | Park 220 | last_modified_at | 2026-05-10T19:29:39.981Z | 2026-05-12T14:21:00.000Z |
| 259776511728 | White Oaks Estates | last_modified_at | 2026-05-10T19:30:02.324Z | 2026-05-12T14:21:00.000Z |
| 316625530589 | River Park Apartments | last_modified_at | 2026-05-10T21:09:49.996Z | 2026-05-11T21:58:00.000Z |
| 315770603207 | Parkwest | last_modified_at | 2026-05-10T19:30:07.975Z | 2026-05-11T12:27:00.000Z |
| 288839537381 | The Arcadian in Victory Park | last_modified_at | 2026-05-10T19:30:02.324Z | 2026-05-14T15:30:00.000Z |
| 264972024515 | The Pointe Apartments | last_modified_at | 2026-05-10T19:29:56.713Z | 2026-05-11T16:24:00.000Z |


## Risk Assessment

- Soft-deleted HubSpot-linked deals exist and need human review before any restore/create action.
- Stage, assignment, and other workflow-owned fields are intentionally excluded from update application.
- Bucket b update plans are limited to amount, deal_name, project_number, project_type, and last_modified_at.
