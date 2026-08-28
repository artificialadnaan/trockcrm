# T Rock Core weekly-report read API v1

This is a service-to-service, read-only view over CRM's existing weekly-report system. CRM remains the
canonical authoring, approval, send, correction, and withdrawal system. This API does not create another
report lifecycle.

## Routes

All calls are `POST` requests with `Content-Type: application/json` under:

`/api/integrations/trock-core/v1/weekly-reports`

| Path | Signed action | Request |
| --- | --- | --- |
| `/deals/resolve` | `resolve-deal` | `{ "officeSlug", "projectNumber" }` |
| `/reports/list` | `list-reports` | `{ "officeSlug", "dealId", "canonicalProjectNumber", "limit", "cursor?" }` |
| `/reports/detail` | `report-detail` | `{ "officeSlug", "dealId", "canonicalProjectNumber", "reportId" }` |

The maximum request body is 16 KiB. Before deserialization, the raw JSON scanner rejects duplicate object
keys, including escape-equivalent spellings; parsers then reject unknown, missing, malformed, or
non-canonical fields. `limit` is required and ranges from 1 through 100. `cursor` is opaque and may be
`null` or omitted on the first page.

## Authentication

Required headers:

- `x-trock-core-request-id`: a UUID unique to this call;
- `x-trock-core-timestamp`: ten-digit Unix time in seconds;
- `x-trock-core-signature`: `sha256=<lowercase hex HMAC-SHA256>`.

The HMAC input is the following byte frame, including newlines and the exact request body bytes:

```text
trock.crm.core-weekly-report-api.v1
<signed-action>
<lowercase-request-id>
<unix-seconds>
<exact-json-body-bytes>
```

CRM accepts timestamps no more than 300 seconds in the past or future and compares digests in constant
time. The read operations are idempotent; the signed request id and timestamp bind an intercepted request
to its action, exact bytes, and bounded replay window. Current and previous keys support coordinated
rotation. Keys must contain at least 32 bytes, may not carry leading/trailing whitespace or control
characters, and the two rotation slots must differ. The API fails closed on any missing/unsafe key
configuration before looking up an office.

Set `TROCK_CORE_WEEKLY_REPORT_API_SECRET` on CRM and the matching secret on Core. During rotation only, set
`TROCK_CORE_WEEKLY_REPORT_API_PREVIOUS_SECRET` to the retiring key.

## Deal resolution and binding

Resolution uses CRM's Bid Board project-number canonicalizer across the established deal project-number
columns inside exactly the signed `officeSlug` tenant schema. It returns one active root, non-change-order
deal:

```json
{
  "version": "trock.crm.core-weekly-report-deal.v1",
  "requestId": "00000000-0000-4000-8000-000000000001",
  "deal": {
    "id": "00000000-0000-4000-8000-000000000010",
    "canonicalProjectNumber": "dfw-1-12345-aa"
  }
}
```

A change-order-only match is indistinguishable from no match (`404`). More than one eligible parent is a
conflict (`409`), never a first-row choice. List and detail calls must send the returned deal id and
canonical project number together; CRM revalidates that binding in the same office on every request.
The binding and report read run in one tenant transaction. Shared row locks hold the deal identity and,
for detail, the publication/withdrawal eligibility through the canonical snapshot load and projection.

## Provider-accepted send history

`/reports/list` returns only rows satisfying CRM's existing portal-publication predicate:

- status is `sent` and `sent_at` is present;
- a frozen sent snapshot exists;
- `send_delivered_at` is present; and
- the provider verdict is neither `bounced` nor `failed`.

Queued, stalled, draft, pending-review, merely-approved, bounced, failed, and snapshot-less rows are not
published. Results order by week, version, and report id descending. The signed keyset cursor binds the
office, deal, canonical number, page limit, first-page `asOf` boundary, issue/expiry time, and last
position. Cursors live for at most 15 minutes and are valid on the half-open interval
`[issuedAt, expiresAt)`. A provider acceptance after `asOf` cannot enter a later page. Changing the page
limit or any identity binding requires a fresh first page.

Each item exposes:

```json
{
  "id": "00000000-0000-4000-8000-000000000200",
  "weekOf": "2026-08-27",
  "version": 2,
  "publicationStatus": "sent",
  "lifecycleState": "latest",
  "supersededByReportId": null,
  "sendAcceptedAt": "2026-08-27T18:00:00.000Z"
}
```

`sendAcceptedAt` means the provider accepted the send; it is not a claim that a recipient opened it or
that the receiving mailbox confirmed delivery. A later known `bounced` or `failed` verdict removes it
from a fresh list/detail read, while a null verdict remains eligible under the existing CRM gate.

`publicationStatus` is fixed to `sent` in v1. `latest` has no later eligible accepted version for that week;
`superseded` names the next eligible accepted version; `withdrawn` means CRM retained historical metadata
but disabled content access. A correction that was never accepted or has a known failure does not
supersede the preceding eligible version.

## Detail allowlist

`/reports/detail` loads the canonical `WeeklyReportView` through the existing PDF/public-view source and
requires `fromSnapshot`. It then projects only the frozen client display fields, client/T Rock team names,
report narrative, schedule/duration display fields, and ordered photo references:

```json
{
  "fileId": "00000000-0000-4000-8000-000000000300",
  "caption": "North elevation complete",
  "sortOrder": 0
}
```

For a legacy sent snapshot with no frozen property display name, the canonical view would fall back to the
current live `deals.name`. Core receives `propertyName: null` in that one case; the live fallback never
crosses this boundary.

The response never spreads an internal view, report row, or file row. It never includes public share
tokens or URLs, send/provider payloads, email addresses, storage buckets or object keys, external source
URLs, draft/pending/approved-only content, or another deal's data. Withdrawn detail returns `410`; an
ineligible or differently bound report returns `404`.

## Protected media seam

`fileId` is only an opaque reference. A later media endpoint may accept the same signed office/deal/report
binding plus `fileId`, verify that the file is an active photo linked to that eligible report, and stream
bytes from CRM with bounded size, safe content headers, and audit metadata. Core must not receive a public
share token, presigned/raw URL, R2 key, bucket, or provider locator. Until that separately reviewed stream
exists, Core should render captions/placeholders and must not attempt to derive a file URL.

## Response handling

CRM responses are `Cache-Control: private, no-store`. Core may keep loaded list metadata only for the
active portal interaction; it must not persist or retain detail narrative/team/schedule/photo-caption
content as a second report store. A later page/detail request revalidates the current deal binding,
publication gate, correction state, and withdrawal state in CRM.

## Observability

Audit logs contain action, request id, office slug, stable deal/report ids, result code, key slot, item
count, pagination presence, and elapsed time. They must not log request bodies, frozen content, narrative,
captions, contact names, cursor contents, secrets, signatures, or raw authorization headers.
