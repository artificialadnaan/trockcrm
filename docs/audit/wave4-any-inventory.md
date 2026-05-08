# Wave 4 Type-Safety Inventory

Date: 2026-05-07

Scope: `server/`, `shared/`, `worker/`, plus the allowed library exception `client/src/lib/api.ts`. `client/src/` application and UI files are intentionally excluded.

Inventory command pattern: scan TypeScript files for `as any`, explicit `: any` / generic defaults such as `<T = any>`, `any[]`, `Record<string, any>`, and `@ts-ignore` / `@ts-expect-error`. `expect.any(...)` test assertions and prose-only matches were excluded. Root typecheck currently passes, so no implicit `any` surfaced through compiler diagnostics.

## Summary

| Severity | Count | Main sources |
| --- | ---: | --- |
| High | 75 | Procore integration state, admin user/audit paths, internal RFP parsing, file/delete-sensitive code |
| Medium | 587 | Reports, dashboard, AI/copilot, migration, worker queue/job payloads, generic HTTP clients |
| Low | 1002 | Tests, mocks, fixture builders, route invocation harnesses |

| Category | Count |
| --- | ---: |
| Type assertion `as any` | 859 |
| Explicit `any` annotation | 519 |
| `Record<string, any>` | 171 |
| `any[]` | 115 |
| `@ts-ignore` / `@ts-expect-error` | 0 |

## High-Severity Inventory

| Module | Locations | Notes |
| --- | --- | --- |
| `server/src/lib/procore-client.ts` | `180`, `210`, `307`, `309`, `310`, `311`, `312` | External Procore response contract defaults and mock response shape use `any`. |
| `server/src/modules/admin/audit-service.ts` | `65`, `89`, `92`, `112`, `113` | Audit-log query row shape is known but cast through `any`. |
| `server/src/modules/admin/users-service.ts` | `72`, `73`, `269`, `270`, `324`, `325`, `402`, `449`, `450` | Admin user rows and auth-event rows cast through `any`; `449` is the audit-flagged local-auth event query. |
| `server/src/modules/call-recordings/service.ts` | `395`, `396` | Call-recording audit/activity row shape cast through `any`. |
| `server/src/modules/files/routes.ts` | `400`, `453`, `488` | File/photo route request parsing and delete-adjacent flows use `any`. |
| `server/src/modules/internal-rfp/routes.ts` | `39`, `156`, `324`, `367` | External inbound payload parsing returns/stores `any`; high because it is an integration boundary. |
| `server/src/modules/procore/routes.ts` | `106`, `223` | Sync-status summary rows and conflict-data payload use `any`; current line numbers differ from the original audit after Wave 2 conflict-resolution edits. |
| `worker/src/jobs/procore-photos.ts` | `26`, `49`, `80`, `97`, `103`, `143`, `205`, `224`, `246`, `264`, `276`, `286`, `344`, `381` | Procore photo sync external payloads and multipart responses use `any`. |
| `worker/src/jobs/procore-sync.ts` | `68`, `71`, `72`, `92`, `129`, `240`, `311`, `394`, `398`, `638`, `642`, `746`, `831` | Procore worker payloads and client responses are untyped. |

## Medium-Severity Inventory

| Module | Locations | Notes |
| --- | --- | --- |
| `client/src/lib/api.ts` | `32`, `37`, `86` | Allowed client library exception. `86` is the audit-flagged default generic `api<T = any>`. |
| `server/src/lib/geocoding.ts` | `131`, `135` | Google geocoding response component arrays use `any[]`. |
| `server/src/lib/graph-client.ts` | `7`, `72`, `76`, `131` | Graph client response/body/error defaults use `any`. |
| `server/src/middleware/rate-limit.ts` | `7` | Request user access is cast through `any`. |
| `server/src/modules/activities/service.ts` | `89`, `116`, `119`, `165` | Activity filters/enums use loose `any` conditions. |
| `server/src/modules/admin/admin-reporting-service.ts` | `124`, `125`, `126`, `127`, `129` | Admin reporting query rows are cast through `any`. |
| `server/src/modules/admin/cleanup-queue-service.ts` | `449`, `462` | Tenant DB argument is cast through `any`. |
| `server/src/modules/admin/routes.ts` | `131`, `140`, `181`, `618`, `631`, `752`, `812` | Route error handling, fallback tenant DB, and audit action parsing use `any`. |
| `server/src/modules/ai-copilot/*` | 126 total | AI/cognitive surfaces heavily use `Record<string, any>` for policy, context, recommendation, provider, and query result shapes. |
| `server/src/modules/companies/*` | `routes.ts:78`; `service.ts:61`, `91`, `128`, `161`, `162`, `194`, `195`, `230`, `263` | Company route/service rows and filters use loose query results. |
| `server/src/modules/contacts/*` | 20 total | Contact filters, directory/dedupe mapping, and association inputs use `any`. |
| `server/src/modules/dashboard/service.ts` | `343`, `344`, `415`, `416`, `463`, `464`, `489`, `574`, `575`, `660`, `661`, `662`, `739`, `775`, `827`, `828`, `865`, `893`, `959`, `963`, `1250`-`1257`, `1295`, `1309`, `1318`, `1444`, `1445`, `1689`, `1690`, `1778`, `1794`, `1819`, `1834`, `1876`, `1890` | Dashboard SQL row shapes are known but cast through `any`; `344` is the audit-flagged stale-leads row mapper. |
| `server/src/modules/deals/*` | 33 total | Deal services, stage gates, imports, and query helpers use loose row/filter types. |
| `server/src/modules/estimating/*` | 26 total | Deferred estimating module uses loose AI/parse/recommendation row types. |
| `server/src/modules/field-users/*` | 15 total | Field-user route/service payload and row shapes use `any`. |
| `server/src/modules/migration/*` | 37 total | HubSpot migration payloads and route errors use `any`. |
| `server/src/modules/public-photo-tokens/*` | 12 total | Token route/service rows and payloads use `any`. |
| `server/src/modules/reports/service.ts` | `227`, `390`-`392`, `396`, `405`, `483`, `553`, `554`, `608`, `609`, `664`, `665`, `720`, `721`, `798`, `799`, `875`, `876`, `887`, `935`, `936`, `1009`, `1010`, `1331`-`1334`, `1339`, `1348`, `1527`-`1532`, `1539`, `1547`, `1548`, `1556`, `1594`, `1641`, `1751`-`1753`, `1761`, `1767`, `1826`, `2199`-`2210`, `2213`, `2218`, `2224`, `2235`, `2249`, `2258`, `2272`, `2279`, `2291`, `2308`, `2358`, `2463`, `2464`, `2668`, `2669`, `2680` | Reports SQL row shapes are known but cast through `any`; `390` is the audit-flagged forecast variance row cluster. |
| `server/src/modules/reports/report-builder-service.ts` | `250` | Report-builder rows use `any` at query boundary. |
| `server/src/modules/reports/routes.ts` | `263`, `279` | Express request/response handler parameters use `any`. |
| `server/src/modules/reports/saved-reports-service.ts` | `106`, `112`, `139`, `299` | Saved-report enum/config updates use `any`. |
| `server/src/modules/search/*` | 12 total | Search query/result payloads use `any`. |
| `server/src/services/directoryDedup.ts` | `163`, `258`, `266`, `267`, `297`, `305` | Directory dedupe dynamic table/row access uses `any`. |
| `server/src/services/projectNumber.ts` | `111`, `128`, `157` | Generic `execute` query argument typed as `any`. |
| `shared/src/schema/public/project-type-config.ts` | `8` | Recursive Drizzle reference uses `(): any`. |
| `worker/src/jobs/*` | `index.ts` 11 total; `email-sync.ts` 25; `estimate-generation.ts` 23; `rfp-request-delivery.ts` 4; `stale-deals.ts` 2; `task-completed.ts` 3; `weekly-digest.ts` 1; plus smaller job files | Worker job payloads, queue rows, and external responses use `any`. |
| `worker/src/listener.ts` | `21` | Domain event callback accepts `any`. |
| `worker/src/queue.ts` | `3`, `66`, `76`, `113` | Core job handler and job rows are untyped. |

## Low-Severity Inventory

Low-severity usages are concentrated in tests and mocks. Largest clusters:

| Test area | Count | Notes |
| --- | ---: | --- |
| `server/tests/modules/estimating/*` | 213 | Deferred estimating module mocks and fake Drizzle chains. |
| `server/tests/modules/email/*` | 116 | Email route/service mocks. |
| `server/tests/modules/ai-copilot/*` | 106 | AI/copilot policy and provider fixtures. |
| `server/tests/modules/leads/*` | 94 | Lead service/route fake DB rows. |
| `server/tests/modules/deals/*` | 71 | Deal service, stage gate, and board fake DB rows. |
| `server/tests/modules/tasks/*` | 71 | Task service/job mocks. |
| `server/tests/modules/reports/*` | 47 | Report service mocks. |
| `worker/tests/jobs/estimate-generation.test.ts` | 46 | Deferred estimating worker fake DB and module mocks. |

## Task 2/3 Target Set

Based on go-live risk and the original audit flags, the next cleanup pass should start with:

- `server/src/modules/reports/service.ts:390` forecast variance row cluster.
- `server/src/modules/dashboard/service.ts:343`-`344` stale lead row cluster.
- `server/src/modules/admin/users-service.ts:449` local auth event row cluster.
- `server/src/modules/procore/routes.ts:106` sync-status summary row and `server/src/modules/procore/routes.ts:223` conflict-data payload.

Broader follow-up candidates after Wave 4:

- Remaining `server/src/modules/reports/service.ts` report row clusters.
- Remaining `server/src/modules/dashboard/service.ts` SQL row clusters.
- `server/src/modules/admin/audit-service.ts`, because audit rows are high-risk.
- Worker Procore job payloads and `server/src/lib/procore-client.ts` default response types.
