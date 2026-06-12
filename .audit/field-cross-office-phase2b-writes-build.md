# Phase 2b — cross-office field WRITES (BUILD — gated, dry-run gated)

Implements the approved plan in `field-cross-office-phase2b-writes-plan.md`. **All cross-office write
behavior is behind a flag, OFF by default** (`FIELD_CROSS_OFFICE_WRITES_ENABLED`). With the flag off the
field write path is byte-for-byte today's single-office behavior. Branch `feat/field-cross-office-writes`
off `main` (reads PR #680 merged). Adnaan merges; Adnaan flips the flag after the gated test.

## The danger this closes
A cross-office field write today silently **orphans**: the photo INSERT lands in the uploader's active
schema, the R2 key is prefixed with the uploader's office, and the async `job_queue` row carries the
uploader's office — none of which is the *deal's* office. `files.deal_id` has **no FK**, so Postgres does
not reject the mismatched row. This phase makes that impossible: every write resolves the *deal's* office
from the DB and binds all three office-derived values to it, plus a structural FK backstop.

## 1. Feature flag (default OFF)
`isFieldCrossOfficeWritesEnabled()` → `process.env.FIELD_CROSS_OFFICE_WRITES_ENABLED === "true"`
(mirrors `PROPOSAL_DRAFTING_ENABLED`). Off ⇒ the write office is always the uploader's active office
(today's behavior). On ⇒ the write office is resolved from the target.

## 2. Unified write path (replaces tenantMiddleware on write routes)
The write routes drop `tenantMiddleware` and route through one helper so flag-off and flag-on share a
single, audited code path:

- `resolveFieldWriteOffice(req, target)` — picks the office:
  - flag ON **and** a capture target id is present → `resolveWriteOffice("deal"|"lead", id)` (the deal's
    office; `opportunityId` resolves as a deal). **404** if no active office owns it (write nothing);
    **503** if a schema was unavailable during resolution (never a misleading 404). Never client-trusted —
    the client's `x-office-id` / echoed `officeId` is ignored for correctness.
  - flag OFF **or** no target (unassigned upload) → the uploader's active office (`getFieldOfficeById(
    req.fieldUser.tenantId)`).
- `runInOfficeTransaction(office, userId, run)` — faithfully replicates `tenantMiddleware`'s transaction
  envelope on a fresh pooled connection: `BEGIN` → `SET LOCAL statement_timeout='30s'` →
  `set_config('search_path','office_<slug>,public', true)` → `set_config('app.current_user_id', userId,
  true)` → `run(officeDb)` → `COMMIT`; `ROLLBACK` on throw; `release()` in `finally`. (a) search_path
  hazard closed here.

Result: with the flag off, `resolveFieldWriteOffice` returns the uploader's office and
`runInOfficeTransaction` is behaviorally identical to today's `tenantMiddleware` — zero behavior change.

## 3. Re-bind all three hazards to the resolved office
| Hazard | Bound to the resolved (deal's) office by |
|---|---|
| (a) search_path | `runInOfficeTransaction(resolvedOffice, …)` wraps the INSERT/UPDATE |
| (b) R2 key `officeSlug` | `requestFieldPhotoUploadUrl({ officeSlug: resolvedOffice.slug })` → `buildR2Key` + the deal-number lookup both run in the resolved schema |
| (c) `job_queue.office_id` | `confirmFieldPhotoUpload({ officeId: resolvedOffice.id })` → `recordUploadedFileSideEffects` enqueues the resolved office |

**Two-step integrity (upload-url → confirm-upload):** the pending upload token already embeds the office
in its `r2Key` (`office_<slug>/…`). At confirm, after re-resolving the deal's office, we assert
`pending.r2Key` is prefixed `office_<resolvedSlug>/` — a defense-in-depth check that the confirm resolves
to the same office the upload-url token was minted under (guards a token replayed under a different active
office). Field-only: derived from the existing `r2Key`, no shared `PendingUpload` schema change.

## 4. assign-target — the one cross-schema wrinkle (DECISION FOR SIGN-OFF)
Unassigned (burst-captured) photos are parked in the **uploader's** office at confirm time (no target to
resolve). `/photos/:id/assign-target` later binds them to a chosen deal. If that deal is in a **different**
office, the photo row physically lives in office_P while the deal lives in office_B — a true cross-schema
move, which `files SET deal_id=<deal in B>` cannot do in-place.

**Built (recommended): reject cleanly, no relocation.** assign-target resolves both the photo's office
(`resolveOfficeForId("file", photoId)`) and the deal's office. Same office → today's in-schema UPDATE (run
in that office). Different office → **409** "This photo was captured under <office_P> and can't be
reassigned to a project in <office_B>." The new FK is the structural backstop: even if the guard were
bypassed, the cross-schema UPDATE is rejected by Postgres (23503), never an orphan. Direct capture (select
a cross-office project, then shoot — the 95% flow) is fully cross-office because the row is *born* in the
deal's office via upload-url+confirm; only burst-then-assign-across-offices is rejected.

**Alternative (richer, if you want it): relocate.** INSERT the row into office_B (same id, same r2Key),
soft-delete the office_P row, idempotent on replay, logged. More moving parts and a non-atomic
cross-connection op (worst case: a leftover pending row in P, recoverable — never data loss). Deferred
unless you choose it at sign-off.

→ **Sign-off question:** ship reject-for-now (recommended) or build relocation now?

## 5. App guard + FK backstop (both)
- **App guard:** the resolver itself proves the deal exists in the resolved office (that's how it
  resolved); the write runs in that office. A clean 404/409 instead of a silent orphan.
- **FK (migration 0158):** `files.deal_id → deals.id` per office schema, `ON DELETE SET NULL` (deleting a
  deal unassigns its photos rather than blocking the delete or orphaning), idempotent `pg_constraint`
  guard, DO-loop over `office\_%` + the `TENANT_SCHEMA` clone block (mirrors 0156). Orphan audit already
  clean (zero `files.deal_id` rows without a matching deal across all schemas), so it lands without
  cleanup. Structural guarantee that no future code path can orphan a deal-photo.

## 6. Picker (search/validate) cross-office — gated on the same flag
`/photo-targets/search` fans out across active offices when the flag is on, applies a **global** limit
(not per-office) with a stable cross-office ordering, and stamps each target with its office (finding #3).
`/photo-targets/validate` resolves the target's office and validates there. Gated on the write flag so the
picker never surfaces a cross-office target the (flag-off) upload can't write to.

## 7. Verification
- **Unit:** flag helper; `resolveFieldWriteOffice` (flag off → uploader; flag on + target → resolved; no
  office → 404; degraded → 503); confirm r2Key-prefix assertion; assign-target same-vs-cross office
  decision. No-DB SQL-assertion where a builder is involved.
- **CHECKPOINT 1 — dry-run (write nothing):** a harness that, for a set of cross-office cases, resolves and
  logs the would-be schema / R2 key prefix / job office and diffs against expectations. **STOP for
  Adnaan's sign-off before any real write.**
- **CHECKPOINT 2 — gated real-write test (after sign-off):** flag-on cross-office write to a known deal in
  office B by a user active in office A → assert the `files` row lands in office_B, `r2_key` starts
  `office_B/deals/<dealNumber>/…`, `job_queue.office_id = office_B`; negatives (unknown id → 404, transient
  → 503, forced wrong-schema INSERT rejected by the FK). photos-only-on-terminal + rep-ownership preserved
  per resolved office.
</content>
</invoke>
