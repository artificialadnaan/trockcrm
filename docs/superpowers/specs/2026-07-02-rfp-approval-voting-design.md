# RFP Approval Voting (non-service) — Design

- **Date:** 2026-07-02
- **Status:** Approved (design); pending implementation plan
- **Feature branch:** `feat/rfp-approval-voting` (trockcrm) + a small companion change in `trocksynchubv3`
- **Owner:** Adnaan

## 1. Summary

Today, when an RFP is triggered on a non-service deal, **any one** of the configured
approvers can single-handedly approve it, which immediately creates the Bid Board /
Procore project. We are replacing that single-approver model with a **three-person
voting system** for non-service deals:

- Three fixed voters (**Sidney, Tim, James**) are asked to approve or reject.
- **2-of-3 majority decides:** two approvals ⇒ **go** (create Bid Board); two rejections ⇒ **no-go**.
- Rejections **require a written reason**; approvals do not.
- Every vote (who / choice / reason / time) is **recorded on the deal** and shown
  **live** in the deal detail card while the deal is in the "Pending RFP" state, so
  anyone can see who has and hasn't voted.
- A **no-go still escalates** to Takashi + Adam Shaw for a final override/deny — this
  escalation path **already exists**; we only change what triggers it (a 2/3 rejection
  instead of a single decline).

**Service / type-4 deals are unchanged**: they keep the existing SyncHub email flow with
approvers **Colby + James**, first-approval-creates, **no voting**.

## 2. Current state (grounded)

This is how the flow works today, verified against both repos.

### 2.1 Trigger (trockcrm)
- `POST /api/deals/:id/trigger-rfp` (`server/src/modules/deals/routes.ts:1187`) guards
  (feature flag, auth, canonical stage must be `opportunity`, not already
  handed-off/triggered), then **atomically reserves** the deal by stamping
  `rfp_approval_requested_at`, `rfp_approval_request_event_id` (a uuid), `rfp_approval_requested_by`,
  and `rfp_approval_status='pending_outbox'` in one conditional UPDATE (the guard-UPDATE
  **is** the concurrency lock; `routes.ts:1247-1272`).
- It enqueues a `job_queue` row `job_type='rfp_request_delivery'`
  (`server/src/modules/deals/rfp-enqueue.ts:151`), payload built by
  `buildNormalizedRfpRequestBody` (`server/src/modules/deals/rfp-payload.ts:167`).
- A separate worker (`worker/src/jobs/rfp-request-delivery.ts:139`) HMAC-signs
  (`x-rfp-request-signature` = `sha256=HMAC(rawBody, SYNCHUB_SHARED_SECRET)`) and POSTs to
  SyncHub `{SYNCHUB_BASE_URL}/api/rfp-requests`; on 200/201 it writes back
  `rfp_approval_request_id` (SyncHub int id) + `rfp_approval_token` and flips status to `pending`.
- **Project-type routing is NOT in the CRM.** The CRM only computes a numeric code
  (`resolveProjectTypeCode`, `server/src/services/projectNumber.ts:53`; `workflowRoute==='service' ⇒ '4'`
  at `:66`; `shared/src/types/project-types.ts:5` confirms service == code 4) and forwards
  `projectType` + `workflowRoute` to SyncHub. Recipient/approver selection and the
  create decision live in **SyncHub**.

### 2.2 Approval (trocksynchubv3)
- `createRfpApprovalRequestFromNormalizedInput` (`server/rfp-approval.ts:~1105`) mints
  **one shared token per request** and emails each configured approver a single
  `/rfp-review/{token}` "Review & Approve" link (`sendRfpReviewEmails:~903`). Recipients
  come from the `rfp_approver_config` table (`getRfpReviewRecipients:~559`); hardcoded
  fallback is **2** people — non-service `[Sidney, James]`, type-4 `[James, Colby]` — plus
  admins auto-CC'd as observers (`GLOBAL_CC_RECIPIENTS`).
- The token is **not recipient-bound**: the same token is sent to everyone, and approver
  identity is just the email typed into the page — anyone with a forwarded link can
  approve as anyone (recipient-binding is the deferred issue #47).
- **First approval wins:** `POST /api/rfp-approval/:token/approve` (`server/routes/rfp-approval.ts:~520`)
  gates on `status==='pending'` + an in-process set, returns 202, and in the background
  runs `processRfpApproval` (`rfp-approval.ts:~1295`) → `createBidBoardProjectFromDeal`
  (Playwright, `server/playwright/bidboard.ts:~1923`) → `storage.createSyncMapping` → marks
  request `approved` → enqueues the CRM `bid-board-created` callback.
- **Decline** captures only the decliner's email (**no reason field today**),
  sets `status='declined'`, and — only for `trock_crm`-sourced RFPs — enqueues the CRM
  `rfp-declined` callback (`denialReason` exists in the payload contract but is never populated).

### 2.3 Pending-RFP state + detail card (trockcrm)
- "Pending RFP" is **derived, not a stored stage**: `stage_id` stays `opportunity`; the
  deal is "pending" when `rfp_approval_status ∈ {pending_outbox, pending}`
  (`isPendingRfpApprovalStatus`, `server/src/modules/internal-rfp/routes.ts:198-200`).
- The only RFP UI on the card is `RfpApprovalStatusBlock`
  (`client/src/pages/deals/deal-detail-page.tsx:1421-1514`, rendered at `:915`) — a single
  status banner keyed off `deal.rfpApprovalStatus`.
- Data reaches the card via `useDealDetail` → `GET /deals/:id/detail` → `getDealDetail`
  (`server/src/modules/deals/service.ts:1964-2065`), which already spreads all `rfp_*`
  columns (`...getTableColumns(deals)` at `:1978`). The card is **refetch-on-load only**;
  no poll/SSE. (An SSE transport exists at `client/src/hooks/use-notifications.ts:147`, and
  a 5-second poll pattern exists in `client/src/pages/rfp-review/rfp-review-page.tsx:~94`.)

### 2.4 Escalation / override (trockcrm) — ALREADY BUILT
- On decline, migration `0148`'s DB trigger `deals_rfp_rejected_email_trg` fires the
  `rfp_rejected_email` worker job (`worker/src/jobs/rfp-rejection-email.ts:13`), emailing the
  requesting rep + `RFP_REJECTION_EMAIL_RECIPIENTS` (Takashi + Adam Shaw) a "Review & Decide"
  link to `/rfp-review/:dealId`.
- On that page the reviewers can **approve the override** (`POST /api/deals/:id/rfp-override/approve`
  → `requestOverrideApproval`, `server/src/modules/deals/rfp-override-service.ts:98` → POSTs
  SyncHub `override-approve` → Playwright create) or **re-confirm the denial**
  (`.../reconfirm-decline` → `reconfirmRfpDecline:248`, terminal). All three routes
  (`routes.ts:1433-1498`) are gated by `requireRfpReviewer` (`server/src/middleware/rbac.ts:43-63`),
  which authorizes only the `RFP_REJECTION_EMAIL_RECIPIENTS` email allowlist
  (`shared/src/lib/rfpReviewerEmails.ts`). The frontend gets an `isRfpReviewer` flag
  (`server/src/modules/auth/routes.ts:185`).
- **Gotcha:** `requestOverrideApproval` currently POSTs to SyncHub's `override-approve`
  keyed by `deals.rfp_approval_request_id` (a SyncHub row). Voting-path deals never create a
  SyncHub request row, so this path must be re-pointed (see §5.6).

## 3. Goals / non-goals

**Goals**
1. Collect three votes (approve/reject) per non-service RFP.
2. Require a reason on reject; none on approve.
3. Decide on the first 2 matching votes (2 approve ⇒ go, 2 reject ⇒ no-go).
4. Record who voted what/when, permanently, and show it **live** in the deal card.
5. On go, create the Bid Board project (reusing existing Playwright + callback).
6. On no-go, drive the deal into the **existing** Takashi/Adam escalation, enriched to
   show the three votes.

**Non-goals (v1 — deferred)**
- Per-office voter sets (v1 is one fixed global trio).
- Deadlines / auto-escalation on a stalled 1-1 (v1 has no deadline).
- Changing a vote after cast (v1 votes are final).
- Per-vote notifications (v1 notifies invitations + final outcome only).
- Any voting on service / type-4 deals (they stay single-approver Colby + James).
- Recipient-bound SyncHub email tokens (#47) — not needed, since voting moves to the CRM.

## 4. Locked decisions

| Decision | Choice | Rationale |
|---|---|---|
| Where votes live / how voters are identified | **CRM-owned**, via a login-gated CRM vote page | Strongest accountability (identity = logged-in user); CRM already owns the deal, card, auth, and escalation |
| Voter set | **Fixed global trio: Sidney, Tim, James** | One config to manage; matches current non-service group intent |
| Decision timing | **Decide on first 2 matching votes**; no deadline | 3rd vote can't change a 2/3 outcome; unresolved split stays visibly Pending RFP |
| Vote changes | **Locked on cast** | Simplest state machine + cleanest audit; fire-on-2 makes the change window tiny |
| Real-time | **Poll while unresolved** | Reuses the existing `/rfp-review` 5s poll pattern; stops when decided |
| Notifications | **Invitations + final outcome only** | Live progress is on the card; avoid per-vote spam |
| Service / type-4 | **Unchanged** (Colby + James, first-approve, SyncHub email) | Out of scope by product decision |

## 5. Detailed design

### 5.1 Type branch at trigger (trockcrm)
`trigger-rfp` gains a branch keyed on service vs non-service (using the same
`workflowRoute==='service'` / project-type-code 4 signal already resolved in
`resolveProjectTypeCode`):

- **Service / type-4:** unchanged — enqueue `rfp_request_delivery` → SyncHub email path.
- **Non-service:** open a **vote round** instead:
  - Keep the existing reserve stamps (`rfp_approval_requested_at`,
    `rfp_approval_request_event_id`, `rfp_approval_status='pending' /* voting */`,
    `rfp_approval_requested_by`) — the `rfp_approval_request_event_id` uuid becomes the
    **round key** for votes.
  - Do **not** call SyncHub `/api/rfp-requests`.
  - Send the three invitation emails (§5.7).

The exact "pending" status token used for an open vote round is reused from the existing
`pending` value so `isPendingRfpApprovalStatus` and the whole "Pending RFP" derivation
(dashboard, board, detail) keep working with **no changes** to those surfaces.

### 5.2 Data model (trockcrm)

**New per-office tenant table `rfp_votes`** — declared as a bare `pgTable("rfp_votes", …)`
(no schema literal) in `shared/src/schema/tenant/rfp-votes.ts`, re-exported from
`shared/src/schema/index.ts`, and created by a new migration that includes **both** the
`office_%` DO-loop **and** a `-- TENANT_SCHEMA_START/END` block (mirroring
`migrations/0153_deal_change_orders.sql`), so new offices provision it.

Columns:

| Column | Type | Notes |
|---|---|---|
| `id` | uuid pk `defaultRandom()` | |
| `deal_id` | uuid | FK → `office_x.deals(id)` ON DELETE CASCADE |
| `round_event_id` | uuid | = `deals.rfp_approval_request_event_id` at vote time; scopes a round so a re-trigger starts fresh |
| `voter_user_id` | uuid | FK → `public.users(id)` ON DELETE SET NULL (cross-schema, per convention) |
| `voter_email` | text | denormalized for display/audit robustness if the user row is gone |
| `decision` | text | `'approve'` \| `'reject'` (plain text, matching the no-enum convention of migration 0151) |
| `reason` | text | required (non-empty) when `decision='reject'`; null for approve |
| `created_at` | timestamptz `defaultNow()` | |

Constraint: **`UNIQUE(deal_id, round_event_id, voter_user_id)`** — one vote per voter per
round; enforces "locked on cast".

**Voter config:** a new global env var `RFP_VOTER_EMAILS` (comma-separated), resolved by a
new `shared/src/lib/rfpVoterEmails.ts` helper mirroring `rfpReviewerEmails.ts`
(`parseVoterEmails` / `resolveRfpVoterEmails` / `isRfpVoterEmail`, dev/test fallback, fails
closed in prod when unset). A new `isRfpVoter` boolean is added to the auth payload next to
`isRfpReviewer` (`server/src/modules/auth/routes.ts:185`) and to the client user type.

**Deal status is reused, not duplicated.** No new status columns on `deals`. The vote
outcome writes the **existing** `rfp_approval_status`:
- open round → `pending`
- 2 approvals → stays `pending` until the SyncHub `bid-board-created` callback flips it to
  `approved` (existing behavior)
- 2 rejections → `declined` + aggregated `rfp_declined_reason` (§5.5)

### 5.3 Vote lifecycle / state machine (trockcrm)

`POST /api/deals/:id/rfp-vote` body `{ decision: 'approve'|'reject', reason?: string }`:

1. **Authz:** `req.user` must be one of the three (`isRfpVoterEmail(req.user.email)`); else 403
   (mirror `requireRfpReviewer`). Deal must be a non-service deal in an open vote round.
2. **Validation:** `reject` requires a non-empty `reason`; `approve` ignores/forbids `reason`.
3. **Atomic tally transaction** (the concurrency-critical part):
   - Insert the vote row (unique constraint rejects a second vote by the same voter → 409).
   - Re-count the round's votes.
   - Compute outcome via the single helper `computeRfpVoteState` (§5.8).
   - **If** the outcome just crossed to decided **and** the deal is not already decided
     (guard on `rfp_approval_status` still `pending`), transition it:
     - **approve-majority:** mark decided-go and fire the create driver (§5.4).
     - **reject-majority:** apply the decline (§5.5).
   - The "not already decided" check inside the same transaction is the idempotency lock —
     it guarantees exactly one create/decline even under simultaneous 2nd-and-3rd votes.
4. Votes are **final**: no update/delete endpoint in v1.

A 1-1 split with no third vote simply remains `pending` (visible on the card) — no deadline.

### 5.4 GO path — 2 approvals (trockcrm → trocksynchubv3)

On approve-majority the CRM invokes **one new HMAC endpoint on SyncHub**:
`POST /api/bid-board/create-from-rfp` (name TBD in plan). It:
- verifies `x-rfp-request-signature` with the existing `RFP_REQUEST_SYNC_SECRET`,
- takes the normalized deal payload (same shape as `/api/rfp-requests` `deal` + attachments)
  plus `sourceDealId`, keyed for idempotency,
- calls the existing `createBidBoardProjectFromDeal` (reusing the `syncMappings`
  adopt-guard at `bidboard.ts:2006-2031` so a duplicate signal never creates two projects),
- emits the **existing** `POST {TROCK_CRM_BASE_URL}/api/internal/bid-board-created`
  callback (`status: created|failed`).

The CRM delivers this via the existing worker/job + outbox pattern (a new `job_type`, or a
reused delivery job carrying a `decision:'approved'`/`autoCreate:true` flag that makes
SyncHub skip the email and create immediately). It consumes the `bid-board-created`
callback **exactly as today** (`server/src/modules/internal-rfp/routes.ts`), advancing the
deal to estimating / service-estimating and clearing RFP state.

During the create-in-flight window `rfp_approval_status` remains `pending`, but that is not
ambiguous on the card: the panel derives its "approved by vote (2/3) — creating Bid Board…"
display from `computeRfpVoteState(votes)` (§5.8), not from the deal status. Polling can stop
once the vote outcome is decided (votes won't change); the eventual callback advances the
stage on the next detail refetch.

> Implementation note: the reused-delivery-flag approach is preferred if it keeps SyncHub
> changes to a single handler branch; the plan phase picks the concrete shape. Either way,
> **no per-vote state is stored in SyncHub** — the CRM is the source of truth.

### 5.5 NO-GO path — 2 rejections (trockcrm)

On reject-majority the CRM applies the decline **itself** (no SyncHub round-trip):
- Set `rfp_approval_status='declined'`, `rfp_declined_at=now`, and
  `rfp_declined_reason` = an aggregated summary built from the two (or three) reject reasons,
  e.g. `"Rejected by vote (2 of 3). Sidney: …; James: …"`.
- This `pending → declined` transition **fires the existing** `deals_rfp_rejected_email_trg`
  (migration 0148) → the existing rep + Takashi + Adam escalation email + `/rfp-review/:dealId`
  page. Reuse `applyRfpDeclineToDeal` (`server/src/modules/deals/rfp-decline-service.ts:20`)
  so the transition is written through the same path the trigger expects (keeping its
  idempotency receipts intact).

**Escalation page enrichment:** `getRfpReviewDetail` (`rfp-override-service.ts:303`) and the
`/rfp-review` page additionally surface the three voters' choices + reasons (read from
`rfp_votes` for the round), instead of only a single decline reason. The reviewers'
approve-override / reconfirm-decline actions are otherwise unchanged.

### 5.6 Override-approve unification (trockcrm → trocksynchubv3)

Because voting-path deals never create a SyncHub request row, the current
`requestOverrideApproval` dependency on `deals.rfp_approval_request_id` is repointed: for a
voting-path deal, **Takashi/Adam's override-approve funnels through the same new
`create-from-rfp` endpoint** as the 2/3-yes path (carrying the deal payload), rather than
SyncHub's `override-approve` (which requires a pre-existing declined request row). The
legacy service/type-4 override path (which does have a request id) may keep the existing
call. This gives one create path used by two triggers (vote-yes, override-approve).

### 5.7 UI (trockcrm)

- **Read-only vote panel on the deal detail card**, inside/adjacent to
  `RfpApprovalStatusBlock` (`deal-detail-page.tsx:1421-1514`): shows all three voters, each
  as voted-approve / voted-reject (+ reason) / awaiting-vote, plus the running tally and the
  "needs 2 of 3" caption. Visible to **anyone** viewing a Pending-RFP non-service deal.
- **Casting a vote:**
  - An eligible voter who hasn't voted sees an inline **Cast your vote** action on the panel.
  - The invitation email deep-links to a **focused, login-gated `/rfp-vote/:dealId` page**
    (mirrors the `/rfp-review` page shape; mobile-friendly single-purpose), sharing the same
    vote components. Reject reveals a required reason field.
- **Data:** extend `getDealDetail`'s return + the `DealDetail` type with a `rfpVotes` array
  (`{ voterUserId, voterName, voterEmail, decision, reason, votedAt }`) plus a derived
  `rfpVoteState` (from §5.8). Add the join in `getDealDetail` (`service.ts:2046-2064`).
- **Live:** the panel **polls** the detail (or a slim votes endpoint) every few seconds
  **only while unresolved**, reusing the `/rfp-review` interval pattern; stops on decision.

Card panel sketch:

```
┌─ RFP Approval Vote ─────────────────────────  Pending · needs 2 of 3 ─┐
│  ✅ Sidney Gibson    Approved                                  2:14 PM │
│  ❌ James Helms      Rejected — "Margins too thin for this scope"      │
│  ⏳ Tim …            Awaiting vote                                     │
│                                                                        │
│  Tally: 1 approve · 1 reject — no decision yet                         │
│  [ Cast your vote ]      ← only if you're a voter who hasn't voted     │
└────────────────────────────────────────────────────────────────────────┘
```

### 5.8 One-helper reconciliation invariant

A single pure helper `computeRfpVoteState(votes, voterConfig)` is the **only** place the
threshold/tally/outcome logic lives. It returns `{ approvals, rejections, outcome:
'pending'|'approved'|'rejected', decidedBy }`. It is consumed identically by:
1. the card panel (display),
2. the fire-on-2 decision in the vote transaction (§5.3),
3. the escalation-page summary (§5.5).

Per the standing reconciliation rule, this prevents drift across card / decision /
escalation. PGlite-backed tests prove that card state == decision == escalation summary for
the same vote set.

## 6. CRM ↔ SyncHub contract changes

**New (SyncHub, small):** one HMAC-guarded create-on-command entrypoint that wraps
`createBidBoardProjectFromDeal` and emits the existing `bid-board-created` callback. Auth via
existing `RFP_REQUEST_SYNC_SECRET` / `x-rfp-request-signature`. No new vote storage.

**Reused unchanged:** `POST {TROCK_CRM_BASE_URL}/api/internal/bid-board-created`
(`status: created|failed`) consumed by the CRM's `internal-rfp` routes; the eligibility-check
guard is optional for this path (the CRM already decided) — decided in plan.

**Retired for non-service:** the CRM no longer calls `/api/rfp-requests` for non-service
deals, so SyncHub sends no review email for them.

## 7. Key files to touch

**trockcrm (most of the work)**
- `shared/src/schema/tenant/rfp-votes.ts` (new) + `shared/src/schema/index.ts` (register).
- `migrations/NNNN_rfp_votes.sql` (new; `office_%` loop + `TENANT_SCHEMA` block). **Confirm the
  next free migration number at authoring time** — numbers are not enforced unique (0158/0163/0164
  appear twice) and ordering is filename-alphabetical; 0171 is currently highest.
- `shared/src/lib/rfpVoterEmails.ts` (new); `server/src/modules/auth/routes.ts:185` +
  client user type (`isRfpVoter`).
- `server/src/modules/deals/routes.ts` — type branch at trigger (`~1187`) + new
  `POST /:id/rfp-vote` route.
- New `server/src/modules/deals/rfp-vote-service.ts` — vote insert + atomic tally + outcome
  drivers; new `shared/src/lib/rfpVoteState.ts` — `computeRfpVoteState`.
- GO driver: new outbound call + (reused) worker delivery job; NO-GO: reuse
  `rfp-decline-service.ts:20`.
- `server/src/modules/deals/service.ts:1964-2065` — join `rfp_votes` into `getDealDetail`;
  `client/src/hooks/use-deals.ts` — `DealDetail` type + poll-while-pending.
- `client/src/pages/deals/deal-detail-page.tsx:1421-1514` — vote panel; new
  `client/src/pages/rfp-vote/rfp-vote-page.tsx` + hook.
- `server/src/modules/deals/rfp-override-service.ts:303` + `/rfp-review` page — escalation
  enrichment; `:98` — override-approve repoint (§5.6).
- Rep outcome notification (new worker email or reuse notification plumbing).

**trocksynchubv3 (small)**
- One new HMAC `create-from-rfp` endpoint reusing `createBidBoardProjectFromDeal`
  (`server/playwright/bidboard.ts:1923`) + existing `bid-board-created` callback
  (`server/sync/bidboard-callback-worker.ts`). No vote storage.

## 8. Testing strategy

- **Vote tally / reconciliation:** PGlite-backed tests (real SQL, not string mocks) proving
  `computeRfpVoteState` == decision == card == escalation for every vote-order permutation
  (approve/approve, reject/reject, approve/reject/approve, etc.), including the
  simultaneous-2nd-and-3rd-vote race (exactly one create/decline).
- **Authz:** only the three voters can vote; non-voters (incl. admins) get 403; read panel is
  visible to all.
- **Locked-on-cast:** second vote by same voter → 409.
- **Type branch:** service/type-4 still takes the SyncHub email path (no vote round);
  non-service opens a round and sends no SyncHub request.
- **No-go trigger:** a 2/3 reject writes `declined` through `applyRfpDeclineToDeal` and fires
  the existing escalation (assert the receipt/idempotency behavior is preserved).
- **CI gate:** name server tests `*.runtime.test.ts` and client/acceptance tests so they
  actually execute in the CI gate (per prior lessons); the build gate runs `test:runtime` and
  client vitest.

## 9. Config / env / rollout

- **Feature flag:** gate the new voting branch so it ships inert and is flipped deliberately
  (mirror `isOpportunityRfpEventEnabled`).
- **`RFP_VOTER_EMAILS`** must be set on **both** the server and worker services in prod; unset
  ⇒ fails closed. **Confirm Tim's exact CRM user / email** (known Tim-vs-Timothy ambiguity in
  the estimator mapping) before enabling.
- **`RFP_REQUEST_SYNC_SECRET` / `TROCK_CRM_BASE_URL`** are used in code but not in SyncHub's
  `.env.example` — confirm they're provisioned for the new create endpoint (both directions).
- **Prod data writes** (any backfill / env changes touching prod) are run by Adnaan, not
  Claude — Claude provides inert/dry-run scripts and guidance only.

## 10. Open items / risks

1. **Concrete GO mechanism** (new dedicated SyncHub endpoint vs. reused delivery-job flag) —
   pick in plan; both reuse `createBidBoardProjectFromDeal` + existing callback.
2. **Eligibility-check on the create path** — keep as a guard or skip (CRM already decided)?
3. **Migration number** collision check at authoring time.
4. **Tim identity** resolution to a real `users` row / email.
5. **Cross-instance atomicity** of the tally is handled by the DB (unique constraint +
   in-transaction "not already decided" guard), not in-process state — verify under the
   worker/server topology.
6. **Re-trigger semantics:** votes are scoped by `round_event_id`; confirm a
   cancel/re-trigger starts a clean round and old rows don't leak into a new tally.

## 11. Out of scope (restated)

Per-office voter sets; deadlines/auto-escalation; vote editing; per-vote notifications;
voting on service/type-4; SyncHub recipient-bound tokens (#47).
