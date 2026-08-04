# TROCK Scope → CRM estimating exporter

**Status:** design, not approved. Nothing below is built, and one prerequisite is BLOCKED — see the
authentication blocker below.
**Date:** 2026-08-04

## The gap in one sentence

`POST /api/deals/:id/estimating/walkthrough-extractions` is finished, tested and deployed on the CRM
side, and **nothing anywhere calls it** — TROCK Scope has no CRM client, no CRM base URL, and no code
that mentions the endpoint. The receiving door was built anticipating Scope as the sender
(`encodeWalkthroughIdKeySegment` says so outright: *"trock-scope computes the same path and uploads to
it before it posts"*), and the sender was never written. Scope extracts the line items and they stay in
Scope.

This spec covers the sender, plus the one CRM-side change the quantity decision requires.

## What the receiver already guarantees

Worth stating, because it removes most of the hard problems from this design:

- **Idempotent on `(dealId, projectId, contentHash)`**, where `contentHash` is the namespaced
  walkthrough id — NOT on `walkthroughId` alone. A retry after a lost response replays the ids of the
  chain the first call committed rather than building a second one, so the sender needs no dedup of its
  own. The distinction is load-bearing: the same walkthrough ingested onto two deals, or onto two
  projects within one deal, is deliberately **two documents**. For the deal-level flow decided below,
  `projectId` is always `null`, so the tuple degenerates to (deal, walkthrough) — but the sender must
  not assume the walkthrough id alone identifies anything.
- **One transaction.** The `files → estimate_source_documents → estimate_document_parse_runs →
  estimate_extractions` chain either all lands or none of it does.
- **Status codes are already meaningful** and the sender must distinguish them: `400` = "your upload
  is not at the derived key, fix it", NOT retryable. `503` = "we could not reach object storage",
  retryable. `409` = the stored object no longer matches what the `files` row recorded.

## BLOCKER: there is no way for a machine to call this endpoint

**This spec originally said "POST the payload with the service token". That was wrong, and it is the
single biggest correction here.** There is no service token for this route, and nothing in the CRM
issues one.

`POST /api/deals/:id/estimating/walkthrough-extractions` is mounted on the CRM's `tenantRouter`
(`app.ts`, `CRM_ONLY_TENANT_ROUTE_MOUNTS[0]`), which means it sits behind `authMiddleware`, per-user
rate limiting, CSRF on unsafe methods, and tenant/office resolution from an authenticated user. Every
one of those assumes a logged-in human.

The CRM's only existing machine path is `field-login`, which serves the FIELD routes — TrockCam is its
only caller — and it does not reach `/api/deals`. Searching the auth middleware for a service-token
mechanism returns nothing.

So the exporter is **not** Scope-side work plus configuration. It needs a CRM-side authentication path
that does not exist. Two ways, and this is a decision before any code:

1. **A service principal for this route**, mirroring what TROCK Scope already built for its own
   inbound service token: a bearer credential, an allow-list of exactly the routes it may reach, and a
   provenance column so a machine-filed extraction is distinguishable from a human's. This is the
   honest shape and the one that matches how the two systems already talk in the other direction.
2. **Scope holds a CRM user's credentials** and logs in. Rejected here: it puts a human's session in a
   machine, inherits CSRF and rate-limiting designed for a browser, and makes every row that machine
   files indistinguishable from one that person typed.

Recommended: (1). Note it also decides what `userId` on the payload means — today the spec passes
`capturedByExternalId`, which is the CRM user who captured the walk, and that stays correct as the
*actor* even when the *caller* is a service.

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
credentials for. That is a new trust edge and the single biggest piece of this work.

**The credential must be scoped, or "direct write" becomes "Scope can read the CRM's files".** The
requirement is: write-only (no `list`, no `delete`, no `get`), confined to the `walkthroughs/` key
prefix, with an object-size ceiling and the two accepted content types enforced at the boundary rather
than trusted from the sender. Rotation on a fixed schedule, and the credential never reachable from
Scope's request path — only its export worker. **If R2's token model cannot express prefix-scoped
write-only access, this decision inverts** and the fallback is CRM-issued presigned upload URLs (or the
upload-proxy endpoint), because an unscoped bucket credential held by a second service is a worse trade
than the extra hop it was chosen to avoid.

Nothing in Scope currently composes a contact sheet, and it has **no image library at all** — no sharp,
no jimp, no canvas in any workspace. It has evidence frames (`frames`, `moment_frames`), so the inputs
exist, but turning them into one `image/jpeg` means adding an image dependency to Scope, not just
writing new code against an existing one.

### 2. A null quantity is refused today, and that refusal is being removed

`WalkthroughScopeRow.quantity` is nullable — *"only ever set when the quantity was spoken and
human-confirmed"* — but `validateWalkthroughIngressPayload` currently **refuses** a null one, because
downstream a null quantity is priced as one unit.

Left as-is this would mean **no fully automatic walk → estimating path**: an extraction straight off the
glasses has unconfirmed quantities on most rows, so somebody would have to confirm every one in Scope's
review UI before any export could be accepted.

That is why the refusal is being lifted instead — see *Accepting a null quantity* below, which is the
decision taken and the one piece of CRM-side work this project requires. Dropping unconfirmed rows from
the export was rejected as the third option: it silently ships a partial scope, and the estimator has no
way to see what was withheld.

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

A new `worker/src/jobs/estimating-export.ts` in **trock-scope**. Trigger is still open (see Remaining
open decisions) — with null quantities accepted, firing automatically once extraction finishes becomes
viable for the first time, because the export no longer waits on a human.

Sequence:

1. Read the walkthrough's scope items — ALL of them, confirmed quantity or not. Rows with no quantity
   travel as null and arrive as rows needing input, which is the whole point of the CRM-side change.
2. Compose the contact sheet from evidence frames → one `image/jpeg`.
3. Upload the sheet with an **atomic create-if-absent** write (`If-None-Match: *`), not a HEAD followed
   by a PUT. HEAD-then-PUT is a TOCTOU: two deliveries of the same walkthrough can both observe "absent"
   and both write, and the loser overwrites evidence the deal has already committed — the exact damage
   the no-re-upload rule exists to prevent. The conditional write makes "only if nobody got here first"
   a property of the operation rather than of the gap between two operations.
   On the precondition failure (`412`) the object already exists, which is the ordinary retry path: fetch
   its size and checksum and compare them to what this attempt would have written. **Equal ⇒ reuse it**,
   this is a true retry and there is nothing to do. **Unequal ⇒ abort the export and dead-letter** — the
   key holds something this walkthrough did not produce, and posting would attach the deal's estimating
   chain to a foreign object.
4. `POST` the payload — **see the authentication blocker below, which this step cannot be written against yet.**
5. Retry policy, per operation rather than one rule for all three:
   - **Timeouts**: HEAD 5s, PUT 60s (it carries the sheet), POST 30s. Bounded attempts — 5 for HEAD/PUT,
     5 for POST — with exponential backoff and full jitter, so a Scope-wide retry storm cannot
     synchronise against the CRM.
   - **Retryable**: connection errors, timeouts, `408`, `429` (honour `Retry-After` when present), and
     `500`/`502`/`503`/`504`.
   - **Never retryable**: `400`, `409`, and any `401`/`403`. Auth failures dead-letter immediately —
     retrying a refused credential cannot succeed and only advances a lockout.
   - **Never infer "absent" from a failed read.** The conditional write above removes the original form
     of this hazard, but it survives on the `412` path: a `403` when fetching the existing object's
     metadata is not "no object" and must not be treated as a mismatch OR as a match. Only an explicit
     `404` means absent, and only a successful metadata read can justify reuse. Anything else aborts the
     export and dead-letters.
   - Every dead-letter carries the operation, the derived key, and the response body.
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
   total and surfaced as a row needing input, not defaulted. **These sites are shared**: they serve
   OCR-parsed document extractions as well as walkthrough ones, so the change alters behaviour for a
   path this project does not otherwise touch. Regression coverage is required for BOTH inputs, not
   only the walkthrough one, or the parsed-document path silently inherits a pricing change nobody
   reviewed.
2. Give the estimating UI a visible "needs quantity" state for those rows.
3. Only then relax `validateWalkthroughIngressPayload` to accept null, and delete the refusal's
   now-obsolete error path.
4. The exporter can then send every row, confirmed or not.

### Re-export after the source changes

The receiver is idempotent, so a SECOND export of a walkthrough whose scope was edited afterwards is
deduplicated and the CRM keeps the FIRST export's rows. The edit silently does not arrive. Three ways
to answer this, and the spec should not leave it undecided:

- **Freeze the walkthrough on export** — simplest, and honest: the CRM document is a snapshot, and
  Scope says so. Later corrections happen in estimating, which is where an estimator already works.
- **Version the export** so a re-export lands as a new document rather than a duplicate. More faithful,
  and it makes the deal accumulate documents the estimator must reconcile.
- **Leave it** — the current implicit behaviour, and the one to avoid, because "your correction was
  accepted and discarded" is indistinguishable from success at the sender.

Recommended: **freeze on export**, with the review UI showing an exported walkthrough as read-only and
naming where to make further changes.

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
