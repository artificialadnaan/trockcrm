# TROCK Scope → CRM estimating exporter

**Status:** design, not approved. Nothing below is built.
**Date:** 2026-08-04

## The gap in one sentence

`POST /api/deals/:id/estimating/walkthrough-extractions` is finished, tested and deployed on the CRM
side, and **nothing anywhere calls it** — TROCK Scope has no CRM client, no CRM base URL, and no code
that mentions the endpoint. The receiving door was built anticipating Scope as the sender
(`encodeWalkthroughIdKeySegment` says so outright: *"trock-scope computes the same path and uploads to
it before it posts"*), and the sender was never written. Scope extracts the line items and they stay in
Scope.

This spec covers only the sender. The CRM side needs no changes.

## What the receiver already guarantees

Worth stating, because it removes most of the hard problems from this design:

- **Idempotent on `walkthroughId`.** A retry after a lost response replays the ids of the chain the
  first call committed rather than building a second one. The sender does not need its own dedup.
- **One transaction.** The `files → estimate_source_documents → estimate_document_parse_runs →
  estimate_extractions` chain either all lands or none of it does.
- **Status codes are already meaningful** and the sender must distinguish them: `400` = "your upload
  is not at the derived key, fix it", NOT retryable. `503` = "we could not reach object storage",
  retryable. `409` = the stored object no longer matches what the `files` row recorded.

## The three things that make this non-trivial

### 1. The contact sheet must exist, at a key Scope does not choose

The receiver **derives** the R2 key server-side and refuses to accept one on the wire — a
caller-supplied key is a confused-deputy read primitive, since `files.r2_key` is presigned on the row's
deal association rather than on the key. So the sender must compute the identical path and upload there
*before* posting:

```
walkthroughs/{dealId}/{projectId ?? "_none"}/{encodeURIComponent(walkthroughId)}/contact-sheet{.jpg|.pdf}
```

Consequences the sender must honour:

- `dealId` / `projectId` are **canonical lowercase UUIDs**; `walkthroughId` is **not** case-folded (it
  is opaque, and folding it merged distinct walkthroughs onto one key).
- `_none` is the sentinel for a deal-level walkthrough. Not an empty segment.
- Percent-encoding is `encodeURIComponent`, reproducible on the sender in one call.
- **A retry must not re-upload.** The key is derived from walkthrough identity, so every attempt targets
  the same object; re-uploading overwrites evidence the deal has already committed. A true retry has
  nothing to upload.

Scope must therefore **write into the CRM's R2 bucket**, which it does not do today and has no
credentials for. That is a new trust edge and the single biggest piece of this work — see Open
decision 1.

Nothing in Scope currently composes a contact sheet. It has evidence frames per clip; turning them into
one `image/jpeg` is new work (sharp is already a CRM dependency; Scope would need its own).

### 2. A null quantity is refused, so a human must review first

`WalkthroughScopeRow.quantity` is nullable — *"only ever set when the quantity was spoken and
human-confirmed"* — but `validateWalkthroughIngressPayload` **refuses** a null one, because downstream a
null quantity is priced as one unit.

This is the important workflow consequence and it is not a detail: **there is no fully automatic
walk → estimating path.** An extraction straight off the glasses will have unconfirmed quantities on
most rows. Somebody has to confirm them in Scope's review UI before an export can be accepted.

That in turn means the demo depends on Scope's review UI being reachable, which needs a login, and the
Scope database had **zero users** when last checked. Creating that user is a prerequisite, not a
follow-up.

The alternative — dropping unconfirmed rows from the export — is worse: it silently ships a partial
scope, and the estimator has no way to see what was withheld.

### 3. Scope does not know the CRM's `projectId`

The payload needs `dealId`, `projectId` and `userId`. Scope's `walkthroughs` row carries `dealUuid`,
`officeSlug`, `siteId` and `capturedByExternalId`.

- `userId` — `capturedByExternalId` already holds the CRM user id. Fine.
- `dealId` — `dealUuid`. Fine.
- `projectId` — **not held.** `siteId` is Scope's own notion. Either the forward starts carrying the
  CRM project id (a change on the CRM's forward job, small), or every export goes in deal-level with
  `_none`. Deal-level is the honest default until someone needs otherwise; note that the receiver
  treats the same walkthrough on two projects as two legitimate documents, so this is a real choice and
  not a formality.

## Proposed shape

A new `worker/src/jobs/estimating-export.ts` in **trock-scope**, triggered by an explicit
**"Send to estimating"** action in the review UI — not automatically on `status = ready`.

Explicit rather than automatic for the reason in §2: the export is only valid once quantities are
confirmed, and "confirmed" is a human judgement. An automatic export would either fire too early and
400, or force us to drop rows.

Sequence:

1. Read the walkthrough's confirmed scope items; refuse early (with a UI message) if any selected row
   has a null quantity, so the operator learns it here rather than as an opaque 400.
2. Compose the contact sheet from evidence frames → one `image/jpeg`.
3. `HEAD` the derived key. If absent, `PUT` it. If present, **do not re-upload** — this is a retry.
4. `POST` the payload with the service token.
5. On `503`, retry with backoff. On `400` / `409`, dead-letter with the response body — these are not
   retryable and a silent retry loop would bury the reason.
6. Record the returned `documentId` / `parseRunId` on the Scope walkthrough so the review UI can say
   "exported" and link back.

## Decisions taken (2026-08-04)

1. **Direct bucket write.** Scope gets write credentials to the CRM bucket and uploads the contact
   sheet to the derived key itself. This is the shape the receiver's key derivation already assumes.
2. **Deal-level.** Every export goes in with the `_none` project sentinel. Nothing new needed on the
   CRM forward.
3. **The CRM will accept rows with no quantity** — rather than blocking the export or silently
   dropping those rows. See below, because the order of work matters.

### Accepting a null quantity: what has to happen first

The ingress refusal is not protecting the database. `estimate_extractions.quantity` is already
nullable and the ingress **already writes SQL NULL** for a row that names no quantity
(`walkthrough-ingress-service.ts:1111` — *"no quantity was spoken" must not collapse into "zero of
it"*). The refusal at the door exists solely to guard a defect one layer further out:

> `Number(extraction.quantity ?? 1)` — **three sites** in `worker/src/jobs/estimate-generation.ts`

That coercion turns "nobody said how much" into "one of them", and prices it. There is a dedicated
characterization test (`walkthrough-ingress-characterization.runtime.test.ts`) pinning this hazard,
so it was found and deliberately fenced off rather than fixed.

So relaxing the ingress guard **on its own would be a regression, not a feature**: today an
unpriceable row is refused loudly at the door; afterwards it would be accepted silently and billed as
one unit. The estimator would have no signal at all.

Order of work, therefore:

1. Fix the three `?? 1` sites so a null quantity is carried as *unknown* — excluded from the priced
   total and surfaced as a row needing input, not defaulted.
2. Give the estimating UI a visible "needs quantity" state for those rows.
3. Only then relax `validateWalkthroughIngressPayload` to accept null, and delete the refusal's
   now-obsolete error path.
4. The exporter can then send every row, confirmed or not.

Done in that order this is strictly better than the original design: the walk's full scope reaches the
estimator, unconfirmed lines are visibly unconfirmed, and nothing is priced off a guess. Done in the
other order it ships a silent mispricing.

## Remaining open decisions

1. **Who creates the first Scope user.** The review UI needs a login and the Scope database had zero
   users. This is a prerequisite for anyone confirming quantities there, and it does not depend on any
   of the work above.

2. **Whether the exporter is triggered by a review-UI button or automatically once extraction
   finishes.** With null quantities accepted, automatic becomes viable for the first time — the export
   no longer has to wait on human confirmation. Still worth a deliberate choice: automatic means an
   estimator sees rows appear without asking.

## What this does not cover

The PDF report cited with images — the third piece of the original ask — is not in this spec. It
depends on the extraction being in estimating first, so it follows this rather than accompanying it.
