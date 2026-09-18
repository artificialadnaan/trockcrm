# Bid Board: CRM activity note on create + due-date read-back — design

Date: 2026-08-17
Repos: `trockcrm` (CRM) and `trocksynchubv3` (SyncHub)
Status: approved design, ready for an implementation plan

## Context

Two independent asks, both about the CRM↔Procore Bid Board boundary.

1. **Activity → Bid Board.** When the CRM causes a Bid Board project to be created, the estimator
   opening that project in Procore sees none of the sales history. Everything the rep logged on the
   deal — calls, site visits, notes — stays in the CRM. They want it carried over as a note on the
   Bid Board project.

2. **Due date → CRM.** The Bid Board is the source of truth for the bid due date, and the export
   already carries a `Due Date` column, but a due-date change made in Procore never reaches the CRM
   in any form a user or a report can see.

### What already exists

**Create path (CRM → Bid Board).** The only route by which the CRM creates a Bid Board project is
the RFP flow:

```
deal enters Opportunity
  → CRM builds a normalized RFP body (buildNormalizedRfpRequestBody)
  → job_queue 'rfp_request_delivery'  → SyncHub POST /api/rfp-requests   (approval email path — LIVE)
     …or job_queue 'rfp_bidboard_create' → SyncHub POST /api/bid-board/create-from-rfp (voting path)
  → SyncHub stores the body, and on approval calls createBidBoardProjectFromDeal
  → Playwright drives Procore's Bid Board UI to create the project
```

Both SyncHub paths flatten the CRM body into a `dealData` property bag before Playwright reads it:
`server/rfp-approval.ts` (`normalizedDealData`, the live email path) and
`server/sync/bidboard-create-worker.ts` (the voting path). Both currently set
`description` and a duplicate `notes` from the same CRM `deal.description`.

The RFP body is **snapshotted at trigger time** and stored — the RFP is static after trigger (#875).

**The voting path is the exception, and it predates this work.** `enqueueRfpBidBoardCreate`
re-fetches *every* payload field from the database at approval time (`loadRfpPayloadDeal` is
DB-authoritative by design, so a voter's committed edits flow into the created project). The activity
log therefore reflects **approval** time on that path, exactly like `amount`, `description` and
`estimator` do. Only the email-approval path — the live one today, since `ENABLE_RFP_VOTING=false` —
carries a true trigger-time snapshot, because SyncHub stores the body it received.

**Export path (Bid Board → CRM).** SyncHub scrapes the Bid Board export to Excel, forwards the raw
rows (`row["Due Date"]` included) to the CRM's `POST /api/bid-board-sync/ingest`, which durably
queues them; the worker runs `ingestBidBoardRows`. That already parses the due date
(`parseBidBoardDueDate`, with range validation and warnings) and stores it in
`deals.bid_board_due_date`.

`deals.bid_board_due_date` is written on every sync and **read by nothing** — no UI, no report, no
worker job. The CRM's user-facing field is `deals.bid_due_date`, and for a lead-converted deal the
READ resolves from `leads.bid_due_date` (`lineage-resolver.ts`, `getDealDetail`), which is why simply
writing the deal column would leave the detail banner unchanged.

### The thing that makes change 2 expensive

`deals.bid_due_date` stopped being a display field on 2026-07-27. It is now the **auto-park horizon
for genuine estimating-stage deals**, in both the TS rule (`isDealEffectivelyOnHold` /
`resolveHoldHorizonDay`, `shared/src/types/deal-hold-risk.ts`) and its SQL twin (`holdHorizonDateSql`,
`shared/src/types/deal-reporting.ts`, which reads the column directly). A horizon more than
`CLOSE_TARGET_HOLD_HORIZON_DAYS` (90) CT-days out makes the deal effectively on hold, which **zeros
its value** on cards, dashboards, at-risk counts and the worker rollups.

The column is documented as NULL on **91% of deals**, and the same comment records that changing this
one field's null-handling would have moved **$4,389,810.67** of reported prod pipeline. So populating
it from the Bid Board moves money in both directions:

| Bid Board due date | Deal was | Becomes | Reported pipeline |
| --- | --- | --- | --- |
| > 90 days out | not parked (close target ≤ 90d) | **parked** | drops by that deal's value |
| ≤ 90 days out | parked (close target > 90d) | **un-parked** | rises by that deal's value |
| absent | unchanged | unchanged | unchanged |

Non-estimating stages are unaffected — their horizon stays `expected_close_date`.

## Goals

- A Bid Board project created from the CRM carries a Note containing the deal's CRM activity history.
- A due-date change in the Bid Board lands on the CRM deal, visible on the deal and consistent
  across every surface that reads a bid due date.
- Both changes are observable (audit trail, sync metrics) and reversible.

## Non-goals

- **`leads.bid_due_date` is not written.** Lead-side surfaces (lead detail, DD packet) keep the rep's
  original value. The deal is where the Bid Board wins. A converted lead is history.
- The CRM's Bid Due Date field is **not** locked or greyed out for bid-board-owned deals. Reps may
  still edit it; the next sync overwrites it. Same posture as `bid_estimate` and stage today.
- No new notification surface for a due-date change (audit trail + `deal_history` only).
- Activity logged *after* the RFP trigger is not back-filled onto the Bid Board project.
- No CRM→Bid Board push of anything other than the activity note.

## Change A — CRM activity log → a Note on the Bid Board project

### Where the note lands

Procore Bid Board projects have a real **Notes** section on the project's **Overview** tab (verified
against Procore's published documentation): add via a `+` control, plain text with limited formatting
(links become hyperlinks, `@mentions` notify), saved with a **Create** button, editable/deletable via
a vertical-ellipsis menu. This is distinct from Project Description, which continues to carry the
deal description only. The activity log goes in a Note.

References:
- <https://support.procore.com/products/online/user-guide/company-level/bid-board/tutorials/add-or-manage-notes-in-a-bid-board-project>
- <https://support.procore.com/products/online/user-guide/company-level/bid-board/tutorials/add-and-manage-internal-notes-in-a-bid-board-project>

### CRM side

**New module `server/src/modules/deals/bid-board-activity-note.ts`** — two exports, one pure:

- `loadDealActivityNoteEntries(tenantDb, dealId, limit)` — reads `activities` for the deal joined to
  `users` for the actor's display name, `ORDER BY occurred_at DESC`, `LIMIT limit + 1` so the caller
  knows whether there are older entries without a second `COUNT`.
- `formatBidBoardActivityNote({ projectLabel, generatedAt, entries, olderCount })` → `string | null`
  — pure, unit-tested, no DB. Returns `null` when there are no entries (the payload field is then
  `null` and SyncHub posts no note).

Every activity type is included (call, note, meeting, site visit, voicemail, lunch, proposal_sent,
task_completed, …) — the estimator wants the whole history, not just typed notes — **except email.**

**`email`-type activities are excluded, and this is an access-control boundary, not a formatting
preference.** `activities/service.ts` restricts email rows to the mailbox owner
(`or(type <> 'email', responsibleUserId = viewerUserId)`), and those rows carry up to 1000 characters
of real message body written by the Graph sync. A Procore note has no "viewer", so that per-viewer
rule cannot be honoured on the far side — including them would bypass an existing access control and
publish private correspondence to every Bid Board user. The query also excludes any row carrying an
`email_id` regardless of type, because the generic `createActivity` accepts an arbitrary `emailId`
with any type. Do not "restore completeness" here.

**The source lead's activities ARE included.** The CRM's own deal Activity tab ORs in
`activities.lead_id` for a lead-backed deal, and nothing re-points `activities.deal_id` at
conversion — so a deal-id-only query silently omits all pre-conversion prospecting, which is exactly
the history the estimator wants. This matches `loadRfpAttachmentsForDeal`, which already includes the
source lead's files for the same reason. (A lead maps to at most one deal: `deals.source_lead_id`
carries a partial UNIQUE index, so this cannot pull in another deal's activities.)

**Dates render in America/Chicago**, the established business-timezone anchor
(`shared/src/types/deal-hold-risk.ts` / `deal-reporting.ts`), not UTC. A UTC render would show the
wrong calendar day for anything logged after 6pm CT.

**Caps**, applied in this order so the outcome is deterministic (named constants, one place to tune):

1. `MAX_BODY_CHARS = 400` — clamp each activity body first, with a `…` marker when clamped.
2. Accumulate entries newest-first until **either** `MAX_ENTRIES = 40` **or** `MAX_NOTE_CHARS = 8000`
   total is reached — whichever binds first.
3. Everything not accumulated (including entries dropped by the char cap, not just by the entry cap)
   is counted into the trailing `… N older entries not shown (open the deal in the CRM)` line.

So 40 entries is the ceiling, not the target: a deal with 40 long entries emits fewer than 40 and says
so. Rationale for the byte target is in "Body budget" below.

**Format.** The heading's constant prefix — the literal `CRM Activity Log —`, **not** the project
number — is the idempotency marker SyncHub matches on. Notes are already scoped to a single project,
so the number adds no discrimination, and keying on it was actively broken: the CRM heading falls back
to the deal *name* when there is no display number, while the payload's `projectNumber` falls back to
the deal UUID, so a number-keyed guard could never match for HubSpot-imported "Pending" deals and
would have posted a duplicate on every run. The readable label stays in the heading for the human
reading it in Procore; SyncHub ignores it. SyncHub also guarantees the marker on what it posts,
prepending the heading if an incoming string somehow lacks it.

```
CRM Activity Log — TR-26-0412 (as of Aug 17, 2026)

Aug 14, 2026 · Call (connected, 15 min) · Jane Rep
  Owner confirmed scope; wants alternates priced.
Aug 12, 2026 · Site Visit · Bob Estimator
  Roof access via north stair only.
Aug 08, 2026 · Note · Jane Rep
  Referred by the GC on the Maple job.
… 12 older entries not shown (open the deal in the CRM)
```

Fields per entry: occurred-at date, type label, outcome and duration when present, actor display
name, then the body indented on following lines. `subject` is included when it differs from the body
(the log form allows both).

**Payload.** `NormalizedRfpRequestBody["deal"].crmActivityLog: string | null` in
`server/src/modules/deals/rfp-payload.ts`, populated from a new
`RfpPayloadSourceDeal.crmActivityLog`.

**Producer.** `loadRfpPayloadDeal` in `server/src/modules/deals/rfp-enqueue.ts` renders the block.
It is the single DB-authoritative payload loader, so **both** create paths
(`insertOpportunityRfpRequestJob` and `enqueueRfpBidBoardCreate`) inherit the field with no further
change, and a sparse `{ id }` caller still produces a complete payload.

`enqueueRfpVoteInvitation` also calls `buildNormalizedRfpRequestBody`, but it copies a fixed field
list into `dealSummary` — so **the activity log never reaches an email**. That is deliberate and must
stay true: a 8 KB activity dump in the voter invitation would bury the decision.

### Body budget

`rfp-payload.ts` already owns a size limiter: `RFP_BODY_BYTE_BUDGET = 90 KB` (under SyncHub's 100 KB
parser limit — the old 413), with `fitWithinBudget` shrinking the description geometrically, then
trimming attachments from the tail above a protected prefix, then surrendering
`SACRIFICIAL_DEAL_FIELDS` in priority order.

The activity log is a second unbounded input, so it must join that machinery — and it is the **most**
expendable field in the body (purely informational, and the full history is one click away in the
CRM). Therefore:

- `crmActivityLog` is **dropped whole as the first step of `fitWithinBudget`**, *before* the
  description shrink. Ordering matters: leaving it to `SACRIFICIAL_DEAL_FIELDS` would truncate the
  description to preserve an activity log, which is backwards.
- It is nullable in SyncHub's contract, so dropping it can never turn a 413 into a 422.
- The build-time caps mean the drop is a rare backstop, not the normal path.

### SyncHub side

1. **Contract** (`server/routes/rfp-requests.ts`): add to `rfpRequestBodySchema.deal`

   ```ts
   crmActivityLog: z.string().nullable().optional().catch(undefined),
   ```

   A **soft** field, exactly like `ownerName`/`ownerEmail`: a malformed value is dropped rather than
   422'd, because a display extra must never block RFP ingestion. `createFromRfpBodySchema` extends
   this schema, so the voting path is covered for free.

2. **Both flatten sites** add `crm_activity_log`: `normalizedDealData` in `server/rfp-approval.ts`
   and the equivalent map in `server/sync/bidboard-create-worker.ts`. `description` and `notes` are
   left exactly as they are, so the activity log cannot leak into Project Description.

3. **Project data** (`server/playwright/bidboard.ts`): `NewBidBoardProjectData.crmActivityLog?: string`,
   mapped from `properties.crm_activity_log`, and threaded through
   `createBidBoardProjectFromDeal`'s `editedFieldsOverride` merge like the other display fields.

4. **New `server/playwright/bidboard-notes.ts`** → `postBidBoardProjectNote(page, projectId, note)`:

   - navigate to the project (`navigateToProject`, which already lands on
     `…/tools/bid-board/project/{id}/details`) and select the **Overview** tab
   - read the existing notes — the UNION of every note-row match and the section's own text, never
     early-returning on the first selector that yields something, or an unrelated list suppresses the
     fallback and hides an existing note
   - if any of that text contains the constant marker `CRM Activity Log —`, **return
     `{ skipped: true }`** — the idempotency guard that keeps a retry, an adopted pre-existing project,
     or a duplicate command from stacking copies of the same note
   - refuse outright when the deal being processed does not own the resolved mapping (a project-number
     lookup can return a mapping owned by a DIFFERENT deal, and posting there would leak one deal's
     sales history into another's project)
   - click the add (`+`) control in the Notes section, type the note, click **Create**
   - verify the note rendered; return a structured result either way

5. **Selectors** go in `server/playwright/selectors.ts` under `bidboard.newUi.notes*`, **tiered** rather
   than merely ordered — `precise` (structural `aid-*` / `data-qa` hooks, acted on in any scope),
   `scopedOnly` (acted on only inside an already-validated container), and `loose` (text-shaped, e.g.
   `section:has-text("Notes")` or a bare `textarea` — **never acted on**).

   When only `loose` candidates match, the module **refuses and reports not-found**. Since none of
   these selectors has been seen against real DOM, that is today's state: **this ships inert and posts
   nothing until the harness below is run and real hooks are substituted.** That is deliberate. A bare
   `textarea` on the Bid Board project page is the Project *Description* — `bidboard.ts:2402` proves it
   — and `fill()` clears before writing while the Create click blurs, so an unguarded page-wide
   fallback would silently overwrite a real project's description with the activity dump. A note that
   fails to post is a non-event; that is not.

6. **Fail-open.** The note step runs *after* the project is confirmed created and after the existing
   description-verify retry, wrapped so any failure logs and writes an audit row
   (`bidboard_note_failed`) but **never** fails the create or the callback. Creating the project is
   the critical path; a note is not. The audit row is how a silent selector rot becomes visible.

7. **Live-selector harness.** New `POST /api/testing/playwright/bidboard-project-note`, beside the
   existing `bidboard-new-project-form` prober: given a project id it dumps the Notes-section DOM and
   a screenshot, and optionally posts a supplied note. This is the validation vehicle — the selectors
   below are written against documented UI, not observed DOM, and **the harness must be run against a
   real project before this ships**.

### Risks — change A

- **The Notes selectors are unverified against live DOM.** Mitigations: the harness route, the marker
  idempotency, and fail-open. Accepted with the harness run as a release gate.
- Procore's Notes field imposes an unknown length limit (not documented). The 8 KB cap is a guess; if
  the harness shows a shorter limit, lower `MAX_NOTE_CHARS` — it is one constant.
- Procore renders links as hyperlinks and treats `@` as a mention trigger. Activity bodies are
  user-authored free text, so an `@name` in a CRM note could fire a Procore mention notification.
  Acceptable; noted so it is not a surprise.

## Change B — Bid Board due date → CRM bid due date

### One canonical resolver

New `server/src/modules/deals/bid-due-date.ts`:

```ts
resolveDealBidDueDate({ bidBoardDueDate, hasSourceLead, leadBidDueDate, dealBidDueDate })
  → string | null   // date-only "YYYY-MM-DD"
```

**The resolver never reads the mirror's VALUE. It reads it as a SIGNAL.**

- The authoritative CRM value is always `deals.bid_due_date` — the same column every SQL surface
  reads. TS and SQL therefore cannot disagree, by construction.
- `bid_board_due_date`'s only job is to answer *"has the Bid Board's value actually landed in the CRM
  column?"* — true when `(deals.bid_due_date AT TIME ZONE 'UTC')::date` equals it. When that holds,
  the **deal column wins over the lead** (this is the lead-masking fix, which was the only reason a
  read change was needed at all). When it does not hold, the legacy precedence applies untouched.
- The override is additionally skipped outright when `bid_board_detached_at IS NOT NULL`.

Applied at all three read sites, so the banner, the scoping field and the RFP payload cannot disagree:

| Site | File | Today |
| --- | --- | --- |
| deal detail (banner, at-risk, effective value) | `deals/service.ts` `getDealDetail` | lead wins, else deal column |
| resolved fields / scoping readiness | `deals/lineage-resolver.ts` `getResolvedDeal` | lead wins, else deal column |
| RFP payload | `deals/rfp-enqueue.ts` `loadRfpPayloadDeal` | deal column wins, else lead (already inconsistent with the other two) |

**Why not read the mirror directly** (the first draft of this spec did, and it was wrong twice over):

1. *Detached deals leaked.* The write-through refuses deals with `bid_board_detached_at` set, but
   detaching never clears `bid_board_due_date` — so a deal deliberately severed from the board would
   have gone on taking its due date, hold horizon and dollar value from that board forever.
2. *It guaranteed card-vs-aggregate drift.* The three TS read sites would move the instant the flag
   flipped, while `holdHorizonDateSql` and its ~50 SQL consumers kept reading `deals.bid_due_date`
   until the next sync wrote through — and **permanently** for detached deals, deals no longer on the
   export, rows skipped for a null attributor, multi-match rows and template rows. That is precisely
   the reconciliation-consistency failure this codebase has been bitten by before.

The signal formulation dissolves both, and has a useful rollout property: **flipping the flag changes
nothing until a sync actually writes**, so the census measures exactly the thing that moves.

### Write-through on ingest

New `writeBidDueDateIfNeeded()` in `server/src/modules/bid-board-sync/service.ts`, modeled on the
existing `writeEstimateIfNeeded` and called from the same place in the row loop — **after** the match,
detach (`skippedDetached`, migration 0200) and template checks, so a detached deal is never touched.

- Runs only when the export carried a parseable date. **Blank never clears** the CRM value: a Procore
  field nobody filled, or one export where the column doesn't populate, must not wipe dates reps rely
  on. Counted as `bidDueDateSkippedNoValue`.
- Writes `bid_due_date = <YYYY-MM-DD>T00:00:00Z` — the UTC-midnight convention every other writer uses
  (`normalizeOptionalDealBidDueDate`, migration 0132) and the one `holdHorizonDateSql` reads back with
  `AT TIME ZONE 'UTC'`. Guarded `IS DISTINCT FROM` so repeat syncs don't churn `updated_at`.
- On a real change, writes **both**:
  - a `deal_history` row (`field_name: 'bid_due_date'`, `source: 'bid_board_sync'`,
    `reason: 'Bid Board export sync - Due Date -> Bid Due Date'`, `changed_by` = the resolved system
    admin/director, same as the estimate sync), and
  - the audit/activity mirror via `logBidBoardActivity`.
- Applies regardless of stage. Unlike the estimate and stage writebacks there is no financial or
  attribution consequence to correcting a historical deal's bid date, and skipping terminal deals
  would leave permanent drift against the board.
- Metrics: `bidDueDateUpdated`, `bidDueDateSkippedNoValue`, `bidDueDateSkippedNoChange`. One tenant
  migration (`0222`) adds `bid_due_date_updated_count` to `bid_board_sync_runs` so the operator's run
  row shows it, following the tenant-table convention (a `DO` loop **and** a
  `TENANT_SCHEMA_START/END` block). The two skip counters stay in-process/logs.

### Feature flag

`BID_BOARD_DUE_DATE_READBACK`, resolved through `server/src/config/feature-flags.ts` alongside the
existing `is…Enabled` helpers, **default OFF**.

It gates **both halves — the write-through and the read override.** This is not belt-and-braces; it is
required for "ships inert" to be true. `deals.bid_board_due_date` is *already populated on prod* (the
ingest has been writing it all along), so shipping the read override unconditionally would change
which source wins on the deal-detail banner — and, because `getDealDetail` feeds the resolved date
into `attachAtRiskResult`, that deal's at-risk verdict and effective value — with the write-through
still off. That is exactly the surprise the flag exists to prevent.

Mechanically: `resolveDealBidDueDate` stays pure and flag-free (so it is trivially unit-testable), and
a thin `resolveDealBidDueDateForRead(...)` wrapper in the same module consults the flag once. All three
read sites call the wrapper, never the raw resolver. Flag off therefore reproduces today's behaviour
exactly, on every surface — verified by an explicit parity test at each site, including the wire shape
(a `Date` for a lead-less deal, a `"YYYY-MM-DD"` string for a lead-backed one).

The counter column is also written **only when the flag is on**. A tenant schema that has not yet
received migration 0222 would otherwise fail the run's UPDATE — inside its `BEGIN`, rolling back that
office's entire sync — with the feature disabled. Migrations run on **API** deploy and the Worker does
not run them, so a worker-ahead-of-API window is real.

The flag exists at all because this sync runs on a schedule: unlike a manual prod write there is no
human gate between deploy and the first mass write, and that write moves reported dollars (see "The
thing that makes change 2 expensive"). Sequence: ship inert → run the census → flip the flag in
Railway → watch the next run's metrics.

**The flag is a STOP, not an UNDO — verified on a live local stack, not reasoned about.** Turning it
back off after a sync has written stops further change, but the already-written `deals.bid_due_date`
persists and keeps driving every raw-column surface. Measured on the fixture deal after one flag-on
ingest, with the flag then turned off:

| surface | `bidDueDate` | effectively on hold | value |
| --- | --- | --- | --- |
| `GET /deals/:id/detail` (goes through the resolver) | `2026-09-16` (the lead's) | false | $250,000 |
| `GET /deals/:id` (reads the raw column, as do board / lists / dashboards / at-risk / worker rollups) | `2027-03-05` | true | **$0** |

That split is inherent to write-through plus a flag that gates reads, not a defect — but it means a
rollback is a DATA operation, not an env-var one. To genuinely revert, restore `deals.bid_due_date`
from the `deal_history` rows this feature writes (`field_name = 'bid_due_date'`,
`source = 'bid_board_sync'`, which carry the exact `old_value`). Adnaan runs that, per
[[prod-write-division-of-labor]].

The corollary: while the flag is ON the two surfaces AGREE (both read the deal column), so the drift
exists only in the rolled-back state. Do not flip off and walk away assuming the CRM is back to where
it started.

### Census (before the flag is flipped)

A read-only script (`scripts/`-style, run by Adnaan against prod — Claude does dry-run/census only)
that reports, for deals matched by the most recent export:

1. how many would receive a `bid_due_date` write at all, split null→date vs date→different-date;
2. of those, how many are in a **genuine estimating** stage (the only ones whose hold verdict can
   change);
3. the park/un-park transitions: `would_park` (new horizon > 90 CT-days out, currently not parked)
   and `would_unpark` (new horizon ≤ 90 days, currently parked by a far-out close target);
4. the **net effective-value delta in dollars** those transitions imply;
5. a sample of the largest movers by value, with deal number, stage, old/new horizon date.

Computed with the same predicates the app uses (`holdHorizonDateSql`,
`closeTargetFarOutSqlPredicate`) rather than a hand-rolled copy, so the census cannot disagree with
what the app will do — and with the **estimating** value chain (`ESTIMATING_VALUE_CHAIN`, DD over
bid), not the generic one, because every mover it reports is by definition a genuine estimating deal
and that is the chain the deals board totals for that stage.

**A failing census must not look like a clean one.** A per-schema error is not swallowed into a
`SKIPPED` log while the run still prints `Across 0 office(s): net reported-pipeline delta $0` — that
would be a reassuring "no impact" verdict on the single artifact gating a prod flag flip. It exits
non-zero and says explicitly that the result is incomplete.

### Risks — change B

- **Reported-pipeline swing on the first enabled sync** — the whole reason for the flag and the
  census. Both directions are possible; the census quantifies it before anyone is surprised by a
  dashboard.
- `leads.bid_due_date` and the deal both hold a bid due date after this, and they can differ. The
  resolver makes reads consistent, and the non-goal is explicit, but "the lead says one thing and the
  deal another" is real divergence someone will eventually notice.
- The mirror column is populated for any matched deal, not only `is_bid_board_owned` ones. In practice
  every deal on the board becomes bid-board-owned (both stage writeback paths set the flag), so this
  is a distinction without a difference — but the resolver keys on the mirror value, not the flag, so
  it holds either way.

## Testing

**CRM.** The gate runs the server unit suite (~790 tests) plus `*.runtime.test.ts`; verify with
`cd server && npm run test:ci` (a bare `npx vitest run` skips ~35 files including the runtime tests).
Typecheck per package against a built `shared`. No prettier in this repo — match surrounding style by
hand.

- `formatBidBoardActivityNote` unit tests: newest-first ordering, entry cap and the `… N older`
  line, per-body clamp, total-chars clamp, empty → `null`, CT date rendering across a DST boundary
  and for a late-evening UTC timestamp, an entry with outcome + duration, an entry with subject and
  body, missing actor name.
- `buildNormalizedRfpRequestBody`: carries `crmActivityLog`; `null` when absent; **dropped before the
  description is shrunk** when over budget (assert both the drop and the intact description); still
  under budget with a pathological log.
- Runtime (PGlite) test for `loadDealActivityNoteEntries` + `loadRfpPayloadDeal`: real `activities`
  rows produce the block in the job payload, in the right order, with the actor's name — SQL tested
  against a real engine, not a string mock.
- Runtime tests for the ingest: writes `bid_due_date` at UTC midnight; blank export value leaves an
  existing date alone; unchanged value writes nothing (no `updated_at` churn, no history row); a real
  change writes exactly one `deal_history` row with the expected source/reason; a detached deal is
  untouched; **flag off ⇒ no write at all**; run-row counter increments.
- `resolveDealBidDueDate` unit tests for all four precedence combinations, plus runtime tests that
  `getDealDetail` and `getResolvedDeal` surface the Bid Board date over a differing lead value, and
  that a deal with no Bid Board date behaves exactly as it does today (regression guard on the 91%
  null case).
- **Flag-off parity test**, the one that protects prod: a deal that *does* carry a
  `bid_board_due_date` differing from its lead value returns the lead value from both
  `getDealDetail` and `getResolvedDeal` while the flag is off, with an unchanged at-risk verdict.
- One at-risk/hold test pinning the consequence: an estimating deal whose new Bid Board horizon is
  >90 days out reports effectively-on-hold with value 0, and ≤90 days out does not.

**SyncHub.** `npm run check` for types; `npx vitest run tests/<file>` for suites.

- Schema round-trip: `crmActivityLog` accepted, `null` accepted, absent accepted, a non-string
  dropped rather than 422'd.
- Both flatten sites emit `crm_activity_log`, and `description`/`notes` are unchanged.
- `postBidBoardProjectNote` against a stubbed page object: posts when absent; **skips when a note
  with the marker already exists**; returns a failure result (does not throw) when the add control is
  missing.
- A create-path test asserting a note failure does not fail the create or the callback.

## Rollout

Three PRs, in this order:

1. **CRM — activity note payload** (`feat/bidboard-crm-activity-note`). The note builder, the payload
   field, the budget integration, tests. Inert on its own: SyncHub strips the unknown key, so this can
   merge with no coordination.
2. **SyncHub — Notes automation** (schema, both flatten sites, `bidboard-notes.ts`, selectors, the
   testing harness route, tests). Gate: run the harness against a real Bid Board project and confirm
   the selectors before merging.
3. **CRM — due-date read-back** (`feat/bidboard-due-date-readback`, branched off `main`, independent
   of PR 1). Resolver + write-through, both behind `BID_BOARD_DUE_DATE_READBACK`, migration 0222,
   metrics, census script, tests.
   Ships with the flag OFF; the flag is flipped after the census is reviewed.

Per the working agreement: each PR is driven to green and clean and then handed over — Claude does not
merge, and Adnaan runs every prod write and the census himself.
