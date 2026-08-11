# Scorecard corrective-action follow-ups — design

Date: 2026-07-27
Base: `origin/main` @ `6b7e19df`
Branch: `feat/scorecard-corrective-action-followups`

Three field-reported defects/gaps in the QC scorecard + corrective-action workflow shipped by #947:

1. Handwritten signatures render as a raw `data:` URL string in the web CRM.
2. A downloaded scorecard PDF never reflects the corrective action that was documented against it.
3. Nobody in oversight is told when a corrective action opens or completes.

Parts 1 and 2 are bugs. Part 3 is a new notification.

---

## Part 1 — Signature renders as raw base64

### Observed

The deal Scorecards tab shows:

```
SIGNATURES
Superintendent: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA…
Project manager: data:image/png;base64,iVBORw0KGgoAAAANSUhEUgA…
```

### Cause

`client/src/pages/deals/deal-scorecards-tab.tsx:472-473` renders the signature value as a text node:

```tsx
<p>Superintendent: {detail.superintendentSignature || "—"}</p>
<p>Project manager: {detail.pmSignature || "—"}</p>
```

`superintendentSignature` / `pmSignature` hold a `data:image/png;base64,…` capture from the T-Rock Cam
signature pad.

The PDF is **not** affected: `scorecard-pdf.ts:519 drawSignature` already decodes the data URL via
`signatureDataUrlToBuffer` and draws it with `doc.image`. Confirmed against the reported download
(`field-scorecard-ae020562-….pdf`) — its `SIGNATURES` section extracts no text after the labels because
both signatures are drawn as images.

### Fix

A `SignatureBlock` component reproducing the PDF's three cases exactly:

| Value | Render |
| --- | --- |
| `data:image/(png\|jpeg\|jpg);base64,…` | `<img>` with `alt="{label} signature"`, bounded height, `object-contain` |
| Non-empty, does not start with `data:` (legacy typed name) | the text, muted — mirrors `typedSignatureFallback` |
| Empty / null / any other `data:` payload | `—` |

The last row matters: a `data:` value that is not an allowed image type must fall to `—`, not be passed
through to `src`, so the web never claims to show a signature the PDF renders as `—`.

### Shared predicate

To stop the two surfaces drifting, the classification moves to `shared/`:

```ts
// shared/src/types/field-scorecard-signature.ts
export function isRenderableSignatureDataUrl(value: string | null | undefined): boolean
export function typedSignatureFallback(value: string | null | undefined): string | null
```

Both `scorecard-pdf.ts` (`signatureDataUrlToBuffer` keeps its Buffer decode but gates on the shared
predicate) and the web tab consume it. This follows the reconciliation-consistency rule: a predicate that
governs more than one surface lives in one place, or the surfaces drift.

### Scope sweep

Grep every surface that renders `superintendentSignature` / `pmSignature` and apply the same treatment:
web deal tab, the tokenized corrective-action responder page, `client-field`, and both mobile source
roots (`mobile/app` **and** `mobile/src` — the two-source-roots rule). Any surface not rendering
signatures needs no change; the sweep is to confirm, not to add.

---

## Part 2 — Corrective actions absent from the downloaded PDF

### Observed

After documenting a corrective action, downloading the scorecard returns the same PDF as before — no
record of the corrective action.

### Cause — two independent gaps

**2a. The renderer has no corrective-action content.** `server/src/modules/field/scorecard-pdf.ts`
contains exactly one corrective-action reference: an unused `corrective_action: BRAND_RED` rating colour.
`buildScorecardPdfData` is never passed corrective-action rows, and
`renderAndStoreFieldScorecardArtifacts` never reads them. A freshly rendered PDF would still omit them.

**2b. Staleness detection never notices a corrective-action write.**
`scorecard-pdf-artifact.ts:23 needsScorecardPdfRegeneration` decides solely on `pdfR2Key` +
`pdfRenderVersion`:

```ts
if (!key) return true;
if (state.pdfRenderVersion < CURRENT_SCORECARD_PDF_RENDER_VERSION) return true;
if (state.pdfRenderVersion > CURRENT_SCORECARD_PDF_RENDER_VERSION) return false;
return !isContentAddressedScorecardPdfKey(key, CURRENT_SCORECARD_PDF_RENDER_VERSION);
```

Once a valid v2 content-addressed key exists the artifact is considered current forever. The download
route (`deals/routes.ts` `GET /:id/scorecards/:scorecardId/download`) therefore presigns the submit-time
object. `linkedPhotoCount` is carried on `ScorecardPdfArtifactState` but consulted by nothing.

Today, scorecard **edits** avoid this only because the edit routes fire a background
`void finalizeFieldScorecardArtifacts(...)`. That is a latency optimisation standing in for correctness:
if it fails (it is fire-and-forget with a `.catch` that only logs), the stale artifact is served
indefinitely with no path to repair.

### Fix

**2a. Render the corrective-action record.**

A `CORRECTIVE ACTIONS` section, emitted only when the scorecard has corrective-action rows, placed after
`SIGNATURES` and before the original-evidence pages. Placing it there keeps page 1 the familiar scorecard
and lets each item render self-contained — its text and its response photos adjacent, rather than the
comment on page 1 and the photos four pages later.

Contents:

- A roll-up line: `2 of 3 resolved`, or `All items resolved — closed Jul 27, 2026`.
- Per item, in **numeric** `item_ref` order (the lpad guard from #947 — lexical ordering breaks past 10
  items, and this must match the deal-thread order):
  - the item label, with an `Open` / `Resolved` status chip;
  - when resolved: responder name, responded-at timestamp, and the response comment (height-bounded with
    `ellipsis`, matching how `Project Summary` bounds free text);
  - the item's response photos, embedded.

Photos reuse `resolveScorecardEvidenceImage` (thumbnail-first, transcoded-original fallback) and inherit
its established semantics unchanged: a retryable storage failure throws
`SCORECARD_EVIDENCE_UNAVAILABLE` (503, retry the download); a permanent failure renders the explicit
placeholder so one bad object cannot make the report permanently unexportable. A separate
`MAX_CORRECTIVE_ACTION_PHOTOS` cap applies so a heavily-documented response cannot balloon the PDF;
omitted photos are reported with a count line, never dropped silently.

`renderAndStoreFieldScorecardArtifacts` gains a corrective-action read. Note its existing evidence query
filters `isNull(fieldScorecardPhotos.correctiveActionId)` — response photos are deliberately excluded
from the *original evidence* set, and must stay excluded there. They are loaded separately, keyed by
`corrective_action_id`. The publish-time recheck fingerprint carries the same filter and must keep it
(a comment in `scorecards-service.ts` already records why: an asymmetry between the two reads produces a
spurious `SCORECARD_EVIDENCE_CHANGED` on every regeneration).

**2b. Make staleness generation-aware.**

- Bump `CURRENT_SCORECARD_PDF_RENDER_VERSION` `2 → 3`. Every existing artifact — including the reported
  one — is then stale and is repaired on its next download. This alone fixes the reported symptom for
  already-documented corrective actions.
- v3 alone is not sufficient going forward: once a v3 artifact exists, resolving item 2 of 3 would not
  invalidate it. So persist the generation the artifact was rendered from and compare it to the live one:
  - new nullable column `field_scorecards.pdf_content_generation timestamptz`, written in the same guarded
    CAS `UPDATE` that already writes `pdf_r2_key` / `pdf_render_version`, set to the `updated_at` the
    render was based on;
  - `ScorecardPdfArtifactState` gains `contentGeneration` + `currentGeneration`;
    `needsScorecardPdfRegeneration` returns true when they differ. Compare at millisecond precision — the
    existing CAS already notes that node-postgres Dates are millisecond-truncated while Postgres retains
    microseconds;
  - a NULL `pdf_content_generation` (every pre-migration row) counts as stale, which is consistent with
    the v3 bump already marking those rows stale.
  - Both readers must supply it: `deals/scorecards-service.ts getDealScorecardPdfArtifactState` and
    `field/scorecards-service.ts getFieldScorecardPdfArtifactState`. Updating one and not the other
    reintroduces the bug on the other surface.
- `resolveCorrectiveActionItemTx` currently bumps `field_scorecards.updated_at` **only** on auto-close
  (`corrective-actions-service.ts:128`). It must bump on **every** resolve, so resolving item 1 of 3 moves
  the generation token. Without this, the generation comparison cannot see intermediate responses, and the
  single-flight key in `finalizeFieldScorecardArtifacts` (which is `updated_at`) would coalesce a new
  render onto a stale in-flight one.
- Add a post-commit `void finalizeFieldScorecardArtifacts(...)` at the resolve funnel
  (`corrective-action-api.ts:369`, which serves both the mobile/CRM route and the tokenized web route), so
  the refreshed PDF is normally ready before anyone clicks download. This is latency only — the generation
  check is what makes it correct, and it self-heals a failed background render.

Migration `0200_field_scorecards_pdf_content_generation.sql` (main is at `0199_field_scorecards_responder_link.sql`).
If another branch lands 0200 first, the #947 precedent applies: the runner discovers by alphabetical
filename and tracks by name, and none of these use `CONCURRENTLY`, so the collision is resolved with a
`git mv` and nothing else. The column addition needs **both** the tenant `DO`-loop and the
`TENANT_SCHEMA_START/END` block — the per-office schema rule from the property-cover-image work.

---

## Part 3 — Notify oversight on open and on completion

### Gap

`handleScorecardCorrectiveActionEmail` notifies only the **responders** — the scorecard's picked field
responder, or the deal's assigned superintendent + project manager. Nobody in oversight learns that a
corrective action opened, and nothing at all is sent when one completes.
`FIELD_SCORECARD_EMAIL_RECIPIENTS` receives every submitted scorecard but nothing on either transition.

### Recipients

`resolveFieldScorecardRecipients(env)` — the existing `FIELD_SCORECARD_EMAIL_RECIPIENTS` list.

**A separate email, never a CC on the responder email.** The responder email embeds a per-recipient
tokenized URL that *authorizes answering* the corrective action. CC'ing an oversight watcher onto it would
hand them a live credential bound to someone else's identity. The oversight email carries no token and
links to the deal's Scorecards tab in the CRM (`resolveFrontendUrl`).

Oversight recipients are deduped against the cycle's resolved responder emails, so a superintendent who is
also on the env list receives "please fix this" and not additionally "someone needs to fix this" for the
same card.

### Triggers — exactly two per cycle

1. **Opened** — enqueued at the existing cycle-start site in `reconcileScorecardCorrectiveActions`, inside
   the same transaction and carrying the same `cycleNonce` minted there.
   Contents: project name, project number, week of, score + rating, the flagged items, the names of who
   was asked to respond (names only, no links), CRM link.
2. **Completed** — enqueued in `resolveCorrectiveActionItemTx` in the same transaction as the auto-close
   flip, on the `stillOpen.length === 0` branch.
   Contents: the same header, plus per item what was done (responder, timestamp, comment, photo count),
   **with the regenerated v3 PDF attached** — which Part 2 is what makes truthful.

Deliberately **not** notified: the reconcile path that walks a card back to `submitted` and deletes its
items when an edit lifts it above band. That is a cancellation, not a correction — nothing was fixed, so
there is nothing to report.

The completed email fetches the stored PDF by `pdf_r2_key`, exactly as `handleFieldScorecardEmail` does,
and degrades to a no-attachment send if the object is not yet available rather than blocking. The
post-commit finalize from Part 2 is what normally makes it available in time.

### Job, stamps, idempotency

A new job type `scorecard_corrective_action_oversight_email` with `phase: "opened" | "closed"` on the
payload, alongside `tenantSchema`, `scorecardId`, `dealId`, `officeId`, `cycleNonce`.

New columns on `field_scorecards` via migration
`0201_field_scorecards_corrective_action_oversight_stamps.sql`:
`corrective_action_oversight_opened_at`,
`corrective_action_oversight_closed_at` (both nullable timestamptz), cleared wherever a genuinely new
business cycle starts — i.e. every site that resets `corrective_action_email_sent_at` to NULL. There are
exactly two, both in `corrective-actions-service.ts`: the reconcile enqueue (`:521`) and the shared
restart helper behind `restartCorrectiveActionNotificationCycleForDeal` /
`…ForResponder` (`:660`). Clearing at one and not the other means a reopen re-notifies responders but not
oversight.

Separate stamps are deliberate. Piggybacking on `corrective_action_email_sent_at` would let an
oversight-send failure corrupt the responder notification state machine — that stamp is what suppresses
duplicate responder sends and gates the server-side reconcile's re-enqueue decision.

**The oversight job must NOT apply the responder job's nonce-supersession check.** The worker has a
self-repair path (`scorecard-corrective-action-email.ts:854`) that rewrites
`field_scorecards.corrective_action_cycle_nonce` to a fresh nonce and re-enqueues *itself* when recipients
could not be resolved or new open work appeared. A pending oversight job minted with the older nonce would
then find payload ≠ stored, return early, and the "opened" email would never be sent. So:

- **Dedup is the stamp alone** (`corrective_action_oversight_opened_at IS NULL`), which is what actually
  encodes "oversight has not yet been told about this cycle".
- **The nonce is used only as the Resend idempotency-key dimension**, read from the immutable
  `payload.cycleNonce` and never compared against the stored value:

  ```
  corrective-action-oversight-{tenantSchema}-{scorecardId}-{phase}-cycle-{cycleNonce}
  ```

  Retry-stable (immutable across a job's retries) and cycle-distinct (a genuine reopen clears the stamp and
  mints a fresh nonce, so it sends again). This preserves the #947 round-5 finding the key exists for: a
  key omitting the per-cycle dimension false-dedups a reopen, and Resend's `invalid_idempotent_request`
  then reads as delivered, stranding the notification.

The worker's nonce-rotation path enqueues only the responder job and is left untouched — oversight has
already been told the card opened, and re-notifying there is precisely the inbox noise this feature is
meant to avoid.

### Failure mode

If `FIELD_SCORECARD_EMAIL_RECIPIENTS` is unset, or the recipient set is empty after subtracting
responders, the oversight job **logs and returns** rather than throwing. This differs from
`handleFieldScorecardEmail`, which throws on an empty union, and the difference is intentional: there, an
empty union means the scorecard reaches nobody at all; here, the responders have already been notified by
their own job, so oversight is supplementary and a dead-letter would be noise.

---

## Testing

Following the project's established harnesses:

- **Signature (unit, client + shared):** the shared predicate over the case table above — data URL, legacy
  typed name, empty, and a non-image `data:` payload. Component tests asserting the deal tab renders an
  `<img>` for a data URL and no raw `data:` text ever reaches the DOM.
- **PDF renderer (unit):** `scorecard-pdf.test.ts` extends to assert the corrective-action section appears
  with items in numeric order past 10 items, the roll-up line for partial vs complete, the photo cap
  omission count, and that a card with no corrective actions renders byte-identically to before.
- **Artifact staleness (unit):** `needsScorecardPdfRegeneration` across v2→v3, matching generation,
  differing generation, NULL generation, and millisecond-precision equality.
- **Regeneration (runtime/PGlite):** resolve item 1 of 3 → `updated_at` advances → the download path
  reports `needsRegeneration` → the re-rendered PDF contains the response. This is the regression test for
  the reported bug and must fail before the fix.
- **Oversight email (worker unit):** both phases; recipients deduped against responders; empty list logs
  and returns without throwing; superseded nonce sends nothing and stamps nothing; a retry does not
  double-send; a reopen does.
- **Token safety (regression):** assert the oversight email body contains no corrective-action token —
  the invariant that keeps a credential out of an oversight inbox.

Runtime tests use the no-DB capture-WHERE / PGlite patterns already established under `server/tests/**`.
Run with `TZ=UTC`, matching the CI gate.

**Known baseline flake to account for:** `server/tests/modules/field/scorecard-pdf.runtime.test.ts >
renders a large multi-photo report` takes ~4.7s against vitest's 5s default and times out under
full-suite parallel load (it passes in isolation). Part 2a adds rendering work to exactly this path, so
that test needs an explicit raised `testTimeout` as part of this change rather than being left to flake
harder.

## Sequencing

Three parts, one dependency between them:

1. **Part 1 (signatures)** — independent, small, no migration. Can land first or alone.
2. **Part 2 (PDF + regeneration)** — migration 0200. Must precede Part 3, because Part 3's completion
   email attaches the corrective-action-bearing PDF that Part 2 produces.
3. **Part 3 (oversight email)** — migration 0201.

Suitable as one PR or as a stack of two (1+2, then 3). Given the review load this area attracts, a stack
is the safer default; the ordering constraint above is what must not be violated either way.

## Out of scope

- Splitting oversight recipients into their own env var. Reusing `FIELD_SCORECARD_EMAIL_RECIPIENTS` was
  chosen deliberately; the consequence is that an oversight watcher also receives every routine submitted
  scorecard. Trivial to split later if that proves noisy.
- Any change to who *responds* to a corrective action, the band that triggers one, or the auto-close rule.
- Registering the scorecard PDF into the deal Documents tab (a separate pending item).
