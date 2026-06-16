# Admin User Provisioning — Design

**Date:** 2026-06-16
**Status:** Approved-in-principle (4 forks decided) → spec review.
**Gate:** standard premerge; Adnaan merges; no self-merge. Auth/permission surface → real-types tests on the create flow, the session-kill paths, and the permission/guard boundaries.

## Goal

Replace database-seeding for user onboarding with an in-app admin flow on the Users tab: **add** a CRM user (create + invite), **deactivate/reactivate** a user with **immediate session invalidation**, and **change a user's role** — with safety guards. Extends the system that already exists; does not rebuild it.

## Background — what already exists (verified)

This is ~70% built; the work is the missing create flow, fuller role coverage, the session-kill bundle, and guards.

- **Schema:** `users` (`role` enum = `admin | director | rep | construction | field_contractor`; `office_id`, `is_active`, `reports_to`, `created_by_user_id`) — `shared/src/schema/public/users.ts`. Credentials live in **`user_local_auth`** (scrypt `password_hash`, `must_change_password`, `invite_sent_at/expires_at`, `revoked_at/revoked_by_user_id`, `is_enabled`, lockout) — `shared/src/schema/public/user-local-auth.ts`. Plus `user_local_auth_events` (audit) and `user_office_access` (cross-office + per-office `role_override`). *(Note: "estimator" is a Bid Board deal field, NOT a user role — the role set is the five above.)*
- **Auth:** stateless JWT (24h CRM / 30d field), scrypt password login, no magic-link/SSO (Azure is a TODO). Invite = admin sends a temp-password email; user must change on first login. `authMiddleware` (`server/src/middleware/auth.ts`) and `requireFieldContractor` (`server/src/middleware/field-auth.ts`) both call the **uncached** `getUserById` (`server/src/modules/auth/service.ts:32`) every request and use the live `user.role`/`user.isActive` — *not* JWT claims — so deactivation/role changes already take effect on the next request.
- **Admin API** (all `requireAdmin`, which is `role === "admin"`, **global** — `server/src/middleware/rbac.ts:22`): `GET /admin/users` (stats), `GET/PATCH /admin/users/:id`, `send/preview/revoke-invite`, `local-auth-events`, `office-access` grant/revoke — `server/src/modules/admin/routes.ts`. Service: `server/src/modules/admin/users-service.ts` (`updateUser` supports role/office/isActive/reportsTo/commission, but the role type is only `admin|director|rep`).
- **Admin UI:** `client/src/pages/admin/users-page.tsx` (805 lines) — list, filters, bulk activate + role/office, per-user role + active toggle, invite send/preview/revoke.
- **Field contractors** already have their own create+invite lifecycle (`createFieldUser`/`acceptFieldInvite`, `server/src/modules/field-users/service.ts`).
- **SSE:** `GET /api/notifications/stream` (`server/src/modules/notifications/routes.ts`) authenticates once at connect; `sse-manager.ts` keeps a per-user registry `connections: Map<userId, Set<SseConnection>>`. This is the one long-lived path the per-request re-check doesn't cover.

## Decisions (the four forks)

1. **Session invalidation:** full bundle — SSE teardown + `user_local_auth.revoked_at` on deactivate + a `users.tokens_valid_after` epoch column checked in middleware (one migration).
2. **Admin scope:** **global** admin (unchanged). "Per-office" means the Add-User form assigns each new user a home office. Last-active-admin guard is therefore **global**.
3. **Add-User roles:** create **CRM roles** (`admin | director | rep | construction`) + reuse the existing local-auth invite. `field_contractor` stays in its own field-user flow — not duplicated.
4. **Guards:** all four — no self-deactivate/self-demote; protect the last active admin; guard `field_contractor` transitions; deactivation is a confirm action in the UI.

## Architecture

Five well-bounded units. The session-kill primitive is the load-bearing one.

### 1. Migration (one) — the epoch column

`migrations/NNNN_user_session_invalidation.sql`:
```sql
ALTER TABLE public.users ADD COLUMN IF NOT EXISTS tokens_valid_after timestamptz;
```
Nullable; `NULL` ⇒ no epoch (every existing token stays valid). Mirror in `shared/src/schema/public/users.ts` (`tokensValidAfter: timestamp("tokens_valid_after", { withTimezone: true })`). Migrations auto-run on deploy (per `[[migrations-auto-run-on-deploy]]`).

### 2. Session-kill primitive — `server/src/modules/auth/session-invalidation.ts` (new)

The single place that "invalidates a user's sessions." Pure-ish, composable, called from `updateUser`.

- `bumpTokensValidAfter(tx, userId, at: Date)` — `UPDATE users SET tokens_valid_after = at WHERE id = userId`. The durable "kill all sessions issued before now" primitive (future-proofs Azure SSO / any cached-auth path).
- `revokeLocalAuthOnDeactivate(tx, userId, actorUserId, at)` — set `user_local_auth.revoked_at = at, revoked_by_user_id = actorUserId` so re-login is blocked (middleware already checks `revokedAt`); append a `user_local_auth_events` row (`event_type` e.g. `deactivated`).
- `clearLocalAuthRevocation(tx, userId, at)` — on reactivate, clear `revoked_at/revoked_by_user_id` so the user can log in again (a fresh login mints a token with `iat > tokens_valid_after`, so it passes).
- `closeUserSseConnections(userId): number` — added to `sse-manager.ts`: iterate `connections.get(userId)`, write a terminal `event: session_invalidated` then `res.end()` each, delete the user's set; returns count. **Runs after the DB commit, not inside the tx** (it's in-memory). Single-instance/in-process assumption matches the existing SSE + eventBus design; on multi-instance it's best-effort per-instance, with the epoch + `is_active` re-check bounding exposure on other instances. Documented as such.

### 3. Middleware epoch check — pure predicate + two call sites

- Pure helper in `session-invalidation.ts`: `isTokenStaleByEpoch(iatSeconds: number | undefined, tokensValidAfter: Date | null): boolean` → `tokensValidAfter != null && iatSeconds != null && iatSeconds * 1000 < tokensValidAfter.getTime()`. (Strict `<`; second-granularity `iat` from `jsonwebtoken` is set automatically. Extend `verifyJwt`'s return to surface `iat`: `JwtClaims & { iat?: number; exp?: number }`.)
- `authMiddleware` (`auth.ts`) and `requireFieldContractor` (`field-auth.ts`): after fetching `user`, `if (isTokenStaleByEpoch(claims.iat, user.tokensValidAfter)) throw new AppError(401, "Session expired, please sign in again")`. Placed right after the existing `!user.isActive` check.

### 4. Add-User create flow

- `createCrmUser(input, actorUserId)` in `users-service.ts`:
  - Input: `{ email, displayName, firstName?, lastName?, role, officeId, reportsTo? }`.
  - **Role guard:** `role` ∈ `CRM_ASSIGNABLE_ROLES = ["admin","director","rep","construction"]` (a new exported const). `field_contractor` ⇒ `AppError(400, "Field contractors are created in the field-user flow")`.
  - Normalize/validate email; reject duplicate with `AppError(409, "A user with this email already exists")` (catch the unique violation or pre-check).
  - Validate `officeId` exists + active.
  - Insert `users` with `createdByUserId = actorUserId`, `isActive = true`. Returns the new user.
- `POST /admin/users` (`requireAdmin`) in `admin/routes.ts`: `createCrmUser(req.body, req.user!.id)`, then — when `sendInvite !== false` (default true) — call the existing `sendUserInvite({ userId, sentByUserId: req.user!.id })`. If the invite email fails, the user is still created; respond `201 { user, invite: { sent: false, error } }` so the UI can surface "created, invite failed — resend." Reuses the invite path entirely.

### 5. Guards in `updateUser` (extend signature with `actorUserId`)

`updateUser(id, input, actorUserId)` — route passes `req.user!.id`. Inside the existing transaction, before applying the base-user patch:
- **Self-protect:** if `id === actorUserId` and (`input.isActive === false` or `input.role` changes the actor's role) ⇒ `AppError(403, "You can't deactivate or change your own role")`.
- **field_contractor transitions:** if `input.role === "field_contractor"` ⇒ `403` ("managed in the field-user flow"); if `existingUser.role === "field_contractor"` and `input.role` is a CRM role ⇒ `403` (same). Keeps the two lifecycles separate.
- **Last active admin:** if the change removes admin-ness from an admin — `existingUser.role === "admin"` and (`input.isActive === false` or (`input.role` set and `!== "admin"`)) — count `users` where `role = "admin" AND is_active = true AND id <> :id`; if `0` ⇒ `AppError(409, "Cannot remove the last active admin")`. Global (matches the global-admin decision).
- **Session-kill wiring** (inside the same tx where possible, SSE after commit):
  - `input.isActive` true→false (deactivate): `bumpTokensValidAfter(now)` + `revokeLocalAuthOnDeactivate(actor, now)`; after commit, `closeUserSseConnections(id)`.
  - `input.isActive` false→true (reactivate): `clearLocalAuthRevocation(now)` (leave `tokens_valid_after` as-is — old tokens stay dead; fresh login works).
  - `input.role` changed (any value): `bumpTokensValidAfter(now)` — forces a clean re-auth so the new role is reflected everywhere (acceptable for an infrequent admin action; SSE not torn down since notification content isn't role-gated).
- Role type widened to `CRM_ASSIGNABLE_ROLES` (adds `construction`; still excludes `field_contractor`, which is guarded above).

### 6. UI — `users-page.tsx` + a small Add-User dialog

- New **"Add User"** button → dialog (`add-user-dialog.tsx`): email, display name, first/last (optional), role select (`admin|director|rep|construction`), office select, "Send invite now" checkbox (default on). Submits `POST /admin/users`; on success refetch + toast (incl. the "created, invite failed — resend" case). Base UI `<Select>` needs `items` (per `[[base-ui-select-items-label]]`).
- **Role select** in the existing edit row gains `construction`.
- **Deactivate** becomes a **confirm dialog** ("This signs the user out of all sessions immediately"), replacing the silent `handleToggleActive` for the false direction. Reactivate stays a direct toggle.
- API client hooks (`use-admin`/wherever `updateUser`/`sendInvite` live): add `createUser`.

## Data flow

- **Add:** dialog → `POST /admin/users` → `createCrmUser` (insert, created_by) → `sendUserInvite` (temp password email, `must_change_password`) → list refetch. New user logs in → forced password change → active.
- **Deactivate:** confirm → `PATCH {isActive:false}` → guards → tx: `is_active=false`, `tokens_valid_after=now`, `user_local_auth.revoked_at=now` → commit → `closeUserSseConnections` → user's very next request (and any reconnect) → 401; re-login blocked by `revoked_at`.
- **Role change:** `PATCH {role}` → guards → tx: `role=…`, `tokens_valid_after=now` → user re-authenticates; new role live.
- **Reactivate:** `PATCH {isActive:true}` → tx: `is_active=true`, clear `revoked_at` → user can log in again.

## Error handling

- Duplicate email `409`; invalid/`field_contractor` role `400`; missing/invalid office `400`; self-protect `403`; field_contractor transition `403`; last-active-admin `409`; not found `404`. Invite-email failure does **not** roll back the create (surface `invite.sent=false`).

## Testing (real types; no invented shapes)

CI runs only client `*.runtime.test.*` (`[[client-test-and-ci-gate]]`); server vitest lives in `server/tests/**` and the gate compiles but does not execute it (`[[server-test-harness]]`). So: put the **pure, high-value logic behind exported pure helpers** and test those; DB-touching services get server vitest (capture-WHERE / PGlite per the harness) runnable locally; the UI dialog gets a client `*.runtime.test.*` so at least one slice executes in CI.

- **Pure helpers (server vitest, fast):** `isTokenStaleByEpoch` (null epoch ⇒ never stale; `iat` before/after/equal boundary); `CRM_ASSIGNABLE_ROLES` membership / `assertAssignableCrmRole`; the guard predicates extracted as pure functions (`wouldRemoveLastAdmin(count, change)`, `isProhibitedSelfChange(...)`, `isFieldContractorTransition(from,to)`), tested against the real `UserRole` type.
- **Service (server vitest):** `createCrmUser` sets `createdByUserId`/`isActive`, rejects `field_contractor` (400) and duplicate email (409); `updateUser` deactivate path sets `tokens_valid_after` + `revoked_at` and calls `closeUserSseConnections`; reactivate clears `revoked_at`; role change bumps epoch; each guard returns the right status.
- **SSE (server vitest):** `closeUserSseConnections` ends every registered `res` for the user and empties the registry; returns the count; no-op for an unknown user.
- **UI (client `*.runtime.test.tsx`):** the Add-User dialog renders the role options (`admin/director/rep/construction`, no `field_contractor`) + the office select + the invite checkbox; the deactivate confirm dialog renders its warning copy. Real types from `@trock-crm/shared/types` (`UserRole`).

## Out of scope (explicit)

- Magic-link / Azure SSO (still a TODO; the epoch column future-proofs it).
- Office-scoped admin (decided: admin stays global).
- A unified field_contractor create UI (kept in the existing field-user flow).
- Multi-instance SSE fan-out teardown (best-effort per-instance; epoch + `is_active` re-check bound exposure; documented).
- Bulk import changes (HubSpot/Procore import path unchanged).
