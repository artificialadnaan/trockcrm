# Scorecard Corrective Actions — Plan 2: Recipients, Email, Tokens, API

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development or superpowers:executing-plans. Steps use `- [ ]`. Follow TDD; commit per task; do NOT push.

**Goal:** On a below-band submit, notify the deal's superintendent + PM (CRM users → app deep link; email-only → recipient-bound web token), and expose the server API for reading a scorecard's corrective-action items and submitting a per-item response (session **or** token auth) that resolves items via Plan 1's `resolveCorrectiveActionItem`.

**Architecture:** Builds on Plan 1 (branch `feat/scorecard-corrective-actions`). Extends `deal_team_members` to hold email-only members (nullable `user_id` + `member_name`/`member_email`) so one team surface + one resolution path covers both hybrid cases. Adds a per-tenant recipient-bound token table, a durable `scorecard_corrective_action_email` outbox job (enqueued in the same submit transaction as Plan 1's open+seed), and REST endpoints under the existing `field` module. Reuses the `field_scorecard_email` job pattern, the `sendSystemEmailWithMetadata` sender, the `public_photo_tokens` token shape, and Plan 1's `resolveCorrectiveActionItem`.

**Tech Stack:** TypeScript, Drizzle, Postgres (tenant schemas), Express (field routes), Resend (via worker sender), PGlite runtime tests, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-22-scorecard-corrective-actions-design.md` §4.4, §4.5, §5, §6, §7.3.

**Reference reading (verify against these — the plan was written from exploration, adapt to reality):**
- `shared/src/schema/tenant/deal-team-members.ts` + `server/src/modules/deals/team-service.ts` — the team model (roles enum incl. `superintendent`/`project_manager`, join to `public.users` for email) + existing constraints on `user_id` (unique? not-null?).
- `worker/src/jobs/field-scorecard-email.ts` + `worker/src/jobs/index.ts` (handler registration) + `worker/src/lib/system-email.ts` (`sendSystemEmailWithMetadata`: cc/attachments/idempotencyKey).
- `server/src/modules/field/scorecards-service.ts` — Plan 1's trigger (where the open+seed happens) is where the email job enqueues too.
- `server/src/modules/field/routes.ts` — how field endpoints authenticate (`requireFieldContractor`, `runFieldDealWrite`); find the existing public-token endpoint(s) (photo share) for the token-auth pattern.
- The `public_photo_tokens` table + its service — copy the recipient-bound token shape (hash at rest, expiry).
- Plan 1 files: `server/src/modules/field/corrective-actions-service.ts` (`resolveCorrectiveActionItem`), `shared/src/schema/tenant/scorecard-corrective-actions.ts`, `shared/src/types/field-scorecard.ts` (`enumerateFlaggedItems`).

---

### Task 1: Schema — email-only team members + token table

**Files:**
- Create: `migrations/0192_corrective_action_recipients.sql` (verify next free number; Plan 1 used 0190/0191)
- Modify: `shared/src/schema/tenant/deal-team-members.ts`; create `shared/src/schema/tenant/scorecard-corrective-action-tokens.ts`; export from the tenant schema index.
- Test: `shared/src/schema/tenant/__tests__/corrective-action-recipients.test.ts`

- [ ] **Step 1: Confirm the next migration number + inspect deal_team_members constraints**

Run: `ls migrations/ | grep -oE '^0[0-9]{3}' | sort -u | tail -3` and read the CREATE for `deal_team_members` (grep the migrations) — note whether `user_id` is `NOT NULL` and whether any UNIQUE includes it. The migration must relax `user_id` to nullable and add `member_name text`, `member_email text`, and a `CHECK (user_id IS NOT NULL OR member_email IS NOT NULL)`. Both a `DO`-loop over existing `office_*` schemas AND a `-- TENANT_SCHEMA_START/END` block (literal `office_dallas.` token — the convention Plan 1 verified via `office/service.ts`).

- [ ] **Step 2: Write the migration** (`0192_corrective_action_recipients.sql`)

Per-tenant, for each `office_*` (DO-loop, `to_regclass`-guarded like Plan 1) and in a TENANT_SCHEMA block:
```sql
ALTER TABLE %I.deal_team_members ALTER COLUMN user_id DROP NOT NULL;
ALTER TABLE %I.deal_team_members ADD COLUMN IF NOT EXISTS member_name text;
ALTER TABLE %I.deal_team_members ADD COLUMN IF NOT EXISTS member_email text;
-- name the check so it's idempotent-safe; add only if missing
DO $c$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conname = 'deal_team_members_user_or_email_chk') THEN
    ALTER TABLE %I.deal_team_members
      ADD CONSTRAINT deal_team_members_user_or_email_chk CHECK (user_id IS NOT NULL OR member_email IS NOT NULL);
  END IF;
END $c$;

CREATE TABLE IF NOT EXISTS %I.scorecard_corrective_action_tokens (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  scorecard_id uuid NOT NULL REFERENCES %I.field_scorecards(id) ON DELETE CASCADE,
  token_hash text NOT NULL,
  recipient_email text NOT NULL,
  role text NOT NULL, -- 'superintendent' | 'project_manager'
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (token_hash)
);
CREATE INDEX IF NOT EXISTS scorecard_corrective_action_tokens_scorecard_idx
  ON %I.scorecard_corrective_action_tokens (scorecard_id);
```
(Adapt the `ALTER COLUMN ... DROP NOT NULL` — if `user_id` is already nullable, skip; guard with a catalog check or just run it, it's idempotent-safe.)

- [ ] **Step 3: Drizzle** — add `memberName`/`memberEmail` + make `userId` nullable in `deal-team-members.ts`; create the tokens drizzle table (bare `pgTable`, snake_case, matching Plan 1's `scorecard-corrective-actions.ts` idiom); export both from the tenant index. Run `npm run build --workspace shared`.

- [ ] **Step 4: Shape test** — assert the new columns/table exist in the Drizzle models. Run it; expect pass.

- [ ] **Step 5: Commit** — `feat(scorecards): email-only team members + corrective-action token schema (migration 0192)`

---

### Task 2: Recipient resolution service

**Files:**
- Create: `server/src/modules/field/corrective-action-recipients.ts`
- Test: `server/tests/modules/field/corrective-action-recipients.runtime.test.ts`

- [ ] **Step 1: Failing runtime test (PGlite).** Set up `deal_team_members` + `public.users`. Seed: a superintendent that IS a user (email from users), a PM that is email-only (`user_id` null, `member_name`/`member_email`), an inactive member (ignored), and a member with neither role (ignored). Assert `resolveCorrectiveActionRecipients(db, dealId)` returns exactly the super + PM with `{ role, name, email, userId }` — user email from `public.users`, email-only email from `member_email`.

- [ ] **Step 2: Implement.**
```ts
export interface CorrectiveRecipient {
  role: "superintendent" | "project_manager";
  name: string;
  email: string;
  userId: string | null; // set => a CRM user (app deep link); null => email-only (web token)
}
export async function resolveCorrectiveActionRecipients(db: TenantDb, dealId: string): Promise<CorrectiveRecipient[]>;
```
Query `deal_team_members` where `deal_id = dealId AND is_active AND role IN ('superintendent','project_manager')`, LEFT JOIN `public.users`. For each: `email = user?.email ?? member_email`, `name = user?.displayName ?? member_name`, `userId = user_id`. Drop rows with no resolvable email (log/skip). Match the join idiom in `team-service.ts`.

- [ ] **Step 3: Run → pass. Typecheck. Commit** — `feat(scorecards): resolve corrective-action recipients (users + email-only)`

---

### Task 3: Recipient-bound token service

**Files:**
- Create: `server/src/modules/field/corrective-action-tokens.ts`
- Test: `server/tests/modules/field/corrective-action-tokens.runtime.test.ts`

- [ ] **Step 1: Failing runtime test.** `mintCorrectiveActionToken(db, { scorecardId, recipientEmail, role, ttlDays })` returns a raw token; the DB row stores only its `sha256` hash + expiry. `verifyCorrectiveActionToken(db, rawToken)` returns `{ scorecardId, recipientEmail, role }` for a valid unexpired token, and `null` for an unknown/expired token. Assert: mint→verify roundtrip; a tampered token → null; an expired token → null.

- [ ] **Step 2: Implement** — mirror `public_photo_tokens`: generate a random token (`crypto.randomBytes(32).toString("base64url")`), store `sha256(raw)` hex in `token_hash`, `expires_at = now + ttl`. `verify` hashes the input, looks up by hash, checks expiry. (Consumption is optional; the flow allows multiple submissions until close, so do NOT single-use — but expose `expires_at`.)

- [ ] **Step 3: Run → pass. Typecheck. Commit** — `feat(scorecards): recipient-bound corrective-action web tokens`

---

### Task 4: Notification email (enqueue in submit txn + worker handler)

**Files:**
- Modify: `server/src/modules/field/scorecards-service.ts` (enqueue the job in Plan 1's below-band branch, same transaction)
- Create: `worker/src/jobs/scorecard-corrective-action-email.ts`; register in `worker/src/jobs/index.ts`
- Shared: add the job-type constant next to the existing `field_scorecard_email` constant
- Test: `worker/tests/jobs/scorecard-corrective-action-email.test.ts` (+ extend the scorecards-service runtime test to assert the job is enqueued)

- [ ] **Step 1: Failing test — enqueue.** Extend Plan 1's `scorecard-corrective-actions.runtime.test.ts`: a below-band submit enqueues ONE `scorecard_corrective_action_email` job in `job_queue` with `{ scorecardId, dealId, officeId, tenantSchema }`, `runAfter` a short delay (match the existing email job), `maxAttempts` 6. A passing submit enqueues none.

- [ ] **Step 2: Implement enqueue** in `createFieldScorecard` (inside the `if (isCorrectiveActionBand(rating) && flagged.length > 0)` block from Plan 1), mirroring the existing `field_scorecard_email` enqueue exactly (same table, durable outbox).

- [ ] **Step 3: Failing test — worker handler.** Model on `worker/tests/jobs/field-scorecard-email.test.ts` (injected deps for db + send). The handler: resolves recipients (Task 2), for each email-only recipient mints a token (Task 3) and builds the web URL `${APP_BASE_URL}/scorecards/:id/corrective-action?token=<raw>`; for each user recipient builds the app deep link; sends ONE email per recipient with the flagged items + the correct link; idempotent per (scorecard, recipient) via a stamp (add a `corrective_action_email_sent_at` on the scorecard, OR a per-recipient guard — choose the scorecard-level stamp for v1 like `field_scorecards.email_sent_at`, sending all recipients in one handler run and stamping once). Assert: correct recipients, correct link type per recipient, idempotent re-run sends nothing.

- [ ] **Step 4: Implement handler + register.** Reuse `sendSystemEmailWithMetadata` (idempotencyKey `corrective-action-${tenantSchema}-${scorecardId}-${email}`). Recipients with no email are skipped (logged). Fail-loud if recipients env/config expectations aren't met, matching the existing job's posture.

- [ ] **Step 5: Run all → pass. Typecheck shared+server+worker. Commit** — `feat(scorecards): below-band corrective-action notification email (super + PM, hybrid link)`

---

### Task 5: API — read items + submit a per-item response (session OR token auth)

**Files:**
- Create: `server/src/modules/field/corrective-action-routes.ts` (or add to `routes.ts` if that's the module convention)
- Modify: `server/src/modules/field/routes.ts` to mount them
- Test: `server/tests/modules/field/corrective-action-routes.test.ts`

- [ ] **Step 1: Failing test.** Cover: (a) `GET /field/scorecards/:id/corrective-actions` returns the items + their responses for a session user assigned to the deal; (b) the same GET works with `?token=<raw>` for an email-only recipient (no session); (c) `POST /field/scorecards/:id/corrective-actions/:itemId` with `{ comment, photoFileIds? }` marks the item resolved (via `resolveCorrectiveActionItem`) stamping the responder (user id for session, `recipient_email`/name for token), and closing the scorecard when it's the last; (d) an invalid/expired token → 401/403; (e) a session user NOT on the deal's team and not an authorized role → 403; (f) a token for scorecard A cannot touch scorecard B.

- [ ] **Step 2: Implement.** An auth resolver that accepts EITHER the field session (`requireFieldContractor` + assigned-to-deal or an authorized role) OR a valid `?token` (via `verifyCorrectiveActionToken`, and the token's `scorecardId` must equal the route param). The POST links any `photoFileIds` (already-uploaded files) to the item by setting `field_scorecard_photos.corrective_action_id`, then calls `resolveCorrectiveActionItem` with the responder identity. All writes in the deal's office schema; strict scorecard-belongs-to-deal checks. (Photo UPLOAD for the token path can reuse the existing field upload endpoint if it accepts a token, or add a token-scoped upload — if that's large, stub the upload endpoint's auth to accept the token and note it; the itemized response linking is the core.)

- [ ] **Step 3: Run → pass. Typecheck. Commit** — `feat(scorecards): corrective-action read + itemized response API (session or token auth)`

---

## Self-review (authoring)
- **Spec coverage:** §4.4 email-only members → Task 1/2; §4.5 tokens → Task 1/3; §5 email enqueue → Task 4; §6 hybrid recipients → Task 2/4; §7.3 API (session+token) → Task 5; closure reuse → Task 5 calls Plan 1's `resolveCorrectiveActionItem`.
- **Type consistency:** `CorrectiveRecipient`, `resolveCorrectiveActionRecipients`, `mintCorrectiveActionToken`/`verifyCorrectiveActionToken`, the `scorecard_corrective_action_email` job constant, and the `corrective_action` item/status strings from Plan 1 are used consistently.
- **Deferred (Plan 4):** the Team-tab UI to ADD email-only members, the inline thread rendering, the dashboard status, and the mobile + web responder screens. Plan 2 is server-only + must have runtime tests proving each seam.

## Next plans
- **Plan 3:** TRock Cam itemized response screen (mobile).
- **Plan 4:** Team-tab email-only config UI, inline thread (web + mobile), QC dashboard status, tokenized web responder page.
