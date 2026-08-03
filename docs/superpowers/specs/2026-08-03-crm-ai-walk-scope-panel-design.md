# AI walk scope, readable from the CRM

**Status:** approved 2026-08-03. Ready for an implementation plan.

An estimator walks a jobsite in Meta Ray-Bans and narrates. TROCK Scope turns that into a
structured scope of work. Today that scope is extracted correctly, stored durably, and **cannot be
read by anyone** — so the walk produces nothing an estimator can act on.

This spec covers making it readable on the deal. It does not cover editing it, the media in the
Photos tab, or the PDF report; those are separate pieces (see *Out of scope*).

## What exists today

The pipeline works end to end. It was proven in production on 2026-08-03 by re-forwarding a real
25-second walk (`job_queue` 44693): the forward completed, TROCK Scope recognised the re-sent clip as
a duplicate and aborted the upload rather than double-counting the narration, and the walkthrough
still holds exactly 5 scope items.

What that walk produced:

| Work type | Qty | Confidence |
|---|---|---|
| *(uncatalogued)* — replace that fan | — | 0.50 |
| `PAINT-WALL` — wall not identifiable from frames | — | 0.70 |
| `PAINT-WALL` — paint wall red | — | 0.60 |
| *(uncatalogued)* — laminate replacing vinyl | 700 SF | 0.78 |
| *(uncatalogued)* — black laminate | — | 0.55 |

Three facts shape everything below, each verified rather than assumed:

1. **The CRM has no walkthrough record.** No table matching `%walkthrough%` exists in any office
   schema. After the forward completes, the only link between a deal and its Scope walkthrough lives
   in the `job_queue` payload and in Scope's own `external_ref`
   (`trockcrm:glasses-walkthrough:<walkId>:deal:<dealId>`). The CRM keeps one `files` row —
   `walk.mp4`, category `other`.
2. **The CRM cannot read Scope.** `SERVICE_ALLOWED_ROUTES` (`server/src/middleware/service-auth.ts`)
   permits a service principal exactly four calls, all POSTs for ingest. **No GET is allowed at
   all**, and the review routes are person-only by design.
3. **Scope's own UI is unreachable.** `scope-api` serves the client and `/walkthroughs/:id/review`
   exists, but every review route 401s without a session and the Scope database has **zero users**.

## Decisions

| Decision | Choice | Why |
|---|---|---|
| What the estimator can do | **Read only in the CRM** | Scope keeps `status`, `row_version`, `supersedes` and a review flow. Two half-built review UIs over one dataset is worse than one. |
| How data arrives | **Live read via the CRM server** | Scope is the system of record and items get corrected there; a snapshot goes stale the moment someone reviews. No schema for the items, no sync path. |
| Where it appears | **Inside the existing Scoping tab** | `DealScopingWorkspace` is where an estimator builds the scope by hand. The AI walk is an input to that job; a separate tab makes them flip back and forth. |

## Architecture

```
browser → CRM API ──┬─→ office_<slug>.glasses_walkthroughs   (which walks, and their Scope ids)
                    └─→ TROCK Scope API (service token, GET)  (the scope itself)
```

The browser never talks to Scope and never sees the service token.

### 1. Scope: open reads to service principals

Add to `SERVICE_ALLOWED_ROUTES`:

- `GET /walkthroughs/:id`
- `GET /walkthroughs/:id/scope-items`
- `GET /walkthroughs/:id/scope-items/:itemId/evidence`

Every **write** stays person-only. The existing rule — the review surface is something only a person
may touch — is unchanged; this adds reads and nothing else.

**Reads are scoped to the caller's own namespace.** Without that, the token can read any walkthrough
by id, including one captured through some future non-CRM path. A service principal may read a
walkthrough only when its `external_ref` begins with `trockcrm:glasses-walkthrough:`. The CRM can
read what the CRM created.

### 2. CRM: persist the link

A new per-office table, `glasses_walkthroughs`:

| Column | Notes |
|---|---|
| `id` | CRM-side identity |
| `deal_id` | what the panel queries by |
| `walk_id` | the mobile client's id, already in the forward payload |
| `scope_walkthrough_id` | nullable until Scope confirms the create |
| `captured_at`, `captured_by_user_id` | shown in the panel header |
| `created_at`, `updated_at` | |

Written by the ingest path, which already has every field. `scope_walkthrough_id` is stamped by the
forward job, which already checkpoints exactly that value.

A table rather than a column on `files` because a walk is one thing with many artifacts, and the
forward already treats walk-as-entity.

### 3. CRM: a proxy endpoint

`GET /api/deals/:dealId/glasses-walkthroughs` — reads the rows for the deal, then fetches detail and
scope items from Scope for each, and returns them merged. Server-side only.

## Behaviour under failure

The panel sits on a page estimators use constantly, so no Scope failure may degrade the deal page
itself.

| Condition | Result |
|---|---|
| Scope unreachable or 5xx | The walk renders with an explicit "scope unavailable" state and a retry. Never an empty tab, never a page error. |
| Scope 404 | The walk renders as "no longer in TROCK Scope". |
| Scope slow | Bounded timeout (5s). A slow Scope must not hang the deal page. |
| `scope_walkthrough_id` still null | The walk renders as "processing" — the forward has not confirmed yet. |
| No walks for the deal | The panel is absent, not an empty box. |

## Testing

**Scope:** allowlist tests proving the three GETs pass for a service principal **and** that every
write still 403s for one — the second half is what stops this quietly becoming a write path. A test
that a service principal cannot read a walkthrough outside the `trockcrm:` namespace.

**CRM:** the `glasses_walkthroughs` write in the existing ingest runtime test; the proxy endpoint
against a stubbed Scope for success, 5xx, 404, timeout and null-scope-id; the panel rendering each
state.

## Out of scope

- **Editing or approving scope in the CRM.** Scope owns review.
- **Walk media in the Photos tab.** The video is currently category `other`, and the 44 extracted
  frames live in Scope's R2, not the CRM's.
- **The cited PDF report.** Scope generates no PDF today; the CRM has a PDF engine
  (`server/src/modules/field/pdf-layout.ts`) that is the likely home.

## Known gap this does not close

Read-only in the CRM makes the scope **visible**. It does not make it **correctable**: "the
estimator disagrees with 700 SF" still has no answer, because correcting an item requires the Scope
review screen and Scope has no users. Creating one is small and independent of this work, and until
it exists this piece is informative rather than actionable.

Related: three of the five items above grounded to no work type at all, because the seeded catalog is
`interior_finish_out` only — 23 work types, with no flooring or fan replacement. Scope quality is
currently bounded by the catalog, not by the model.
