# Phase C Diagnosis — Notification Recipients Bug + Missing DD Email

## Step 1 — Repro of Bug 1 (HTTP)

- **Endpoint:** `GET https://trockcrm.com/api/admin/notification-recipient-groups/lead_due_diligence`
- **Auth:** `test-admin@trock.test` / `<redacted>` (role=admin, officeId=802f4260-…-0703) via `POST /api/auth/local/login` → 200 OK; `token` cookie set on `.trockcrm.com`.
- **Status code:** **HTTP 404**, NOT 5xx.
- **Body:** `{"error":{"message":"Notification recipient group not found"}}`
- **Headers of note:** `content-type: application/json`, `x-railway-request-id: t8T5N89_R4-nC6d-jVra_w`, `cf-ray: 9fa5a3e0...`
- **Discovery hypothesis (missing `tenantMiddleware` → 5xx from raw pool fallback) is REFUTED.** The route returns a clean, JSON-formatted application 404 produced by `getNotificationRecipientGroup()` (`server/src/modules/leads/due-diligence-service.ts:810-812` — `throw new AppError(404, "Notification recipient group not found")`). The raw-pool fallback worked fine for the simple key lookup against `public.notification_recipient_groups`.

## Step 2 — Railway logs

Service: `API` (not `api`; the `api` service in Railway is `trock-onboarding-cleanup`, a different worker). Log tail shows clean startup: `[API] T Rock CRM server running on port 3001`, all migrations marked “already executed” including:

```
Skipping 0079_notification_recipient_groups.sql (already executed)
Skipping 0080_lead_due_diligence_approvals.sql (already executed)
Skipping 0081_lead_dd_recipient_seed_correction.sql (already executed)
```

No stack traces, no SQL errors, no `[lead-dd]` entries. The 404 is silent at the log level (handled by the express error middleware without logging).

## Step 3 — Production DB state (via `DATABASE_PUBLIC_URL`)

NOTE: `/Users/adnaaniqbal/projects/trockcrm/.env` `DATABASE_PUBLIC_URL` is stale/placeholder (`postgres:postgres@…`); used `railway variables --service Postgres` to pull the real URL: `postgresql://postgres:<redacted>@<redacted>:5432/railway`.

### notification_recipient_groups (public)
```
 id | key | name | description | created_at
----+-----+------+-------------+------------
(0 rows)
```
**Zero rows.** The `lead_due_diligence` group row does NOT exist.

### notification_recipient_assignments (public)
```
 count
-------
     0
```
**Zero rows.**

### Migration ledger anomaly
```
 0079_notification_recipient_groups.sql     | 2026-05-05 18:16:31.485519+00
 0080_lead_due_diligence_approvals.sql      | 2026-05-05 18:16:31.511560+00
 0081_lead_dd_recipient_seed_correction.sql | 2026-05-05 18:16:31.524393+00
```
0079 was recorded as executed on 2026-05-05 — yet the table created by that same migration is empty, including the `INSERT INTO public.notification_recipient_groups VALUES ('lead_due_diligence', …) ON CONFLICT (key) DO UPDATE` which is unconditional. **The CREATE TABLE clearly ran (the table exists with the expected schema), but the INSERT did not persist.** Most plausible cause: the ledger row was written without the migration body fully executing (e.g., a prior run hit a transient error that left the table created but the INSERT rolled back, while a downstream pass marked it applied). A manual TRUNCATE post-migration is also possible but there is no evidence for it. Either way, the seed never landed.

### Timeline (also explains why even a re-run of 0081 today would be a no-op)
```
migration 0079              2026-05-05 18:16:31
migration 0081              2026-05-05 18:16:31
user tyamashita created     2026-05-07 21:59:05   ← AFTER migrations
user adnaan.iqbal created   2026-05-08 05:38:03   ← AFTER migrations
pending DD approval created 2026-05-10 18:50:32   ← AFTER everything
```

Migration 0081's seed selects users by `lower(email) IN ('tyamashita@trockgc.com','adnaan.iqbal@gmail.com')`. Even if the INSERT had executed, those rows didn't exist yet on 2026-05-05 → 0 assignments inserted. The migration runner skips already-applied migrations on subsequent boots, so the corrective seed never re-fires once the users are created. Both 0079 and 0081 are effectively dead.

### Most recent DD approvals (office_dallas.lead_due_diligence_approvals)
```
id                                   | status   | requested_at               | email_sent_at | email_message_id | decided_at
be4252fc-55e7-4e70-ac22-8a62ad5b0115 | approved | 2026-05-11 15:28:36.644+00 | NULL          | NULL             | 2026-05-11 16:11:29.504
ae6fb49f-60df-4594-b95f-db79c58a80cd | pending  | 2026-05-10 18:50:32.008+00 | NULL          | NULL             | NULL
```
Both rows: `email_sent_at = NULL`, `email_message_id = NULL`. Approval was created, email never marked sent. The newer one was even approved (decided) without ever sending the request email.

### Fallback recipient query (post-c509f86)
```
SELECT id, email, role FROM public.users WHERE is_active = true AND role IN ('admin','director')
→ 7 rows: 6 admins + 1 director
   - admin@trockgc.com, test-admin@trock.test, tyamashita@trockgc.com,
     adnaan.iqbal@gmail.com, jhelms@trockgc.com, ashaw@trockgc.com,
     test-director@trock.test
```
The c509f86 fallback in `getLeadDueDiligenceRecipients()` (`due-diligence-service.ts:101-113`) WOULD have returned 7 active recipients. So why did the DD approval row still end up with `email_sent_at = NULL`?

### Why c509f86 fallback didn't fire for the existing DD rows

The fallback was committed on **2026-05-11 11:36:54 -0500** (i.e., 2026-05-11 16:36 UTC). The two affected DD rows were created at:
- 2026-05-10 18:50:32 UTC (pending) — created **~22 hours BEFORE** the fix existed.
- 2026-05-11 15:28:36 UTC (approved) — created **~68 minutes BEFORE** the fix was committed (and longer than that before it was deployed; latest API deploy in logs has no DD-related entries since then).

Both pre-date the fallback being available in production. They are stuck with `email_sent_at = NULL` and there is no resend/retry path yet (TODO comment at `due-diligence-service.ts:332-333` explicitly calls this out).

Resend env is configured correctly (`RESEND_API_KEY`, `RESEND_FROM_ADDRESS=noreply@trockcrm.com`, `TEST_EMAIL_OVERRIDE=adnaan.iqbal@gmail.com`). No email infra blocker.

## Step 4 — Root cause

**Bug 1 (404 on recipients page):** The `public.notification_recipient_groups` table is empty in production. Migration 0079's seed INSERT was recorded as applied in `_migrations` but never persisted (the table exists with correct schema and 0 rows), so `GET /admin/notification-recipient-groups/lead_due_diligence` correctly returns 404 from `getNotificationRecipientGroup` when it cannot find the group row. The leading discovery hypothesis (missing `tenantMiddleware` → raw-pool 5xx) is **wrong**; the raw `drizzle(pool)` fallback is fine for this public-schema query.

**Bug 2 (DD email never sent):** Two compounding issues:
1. Same root cause as Bug 1 — no group row, no assignments, so `getLeadDueDiligenceRecipients()` got 0 explicit recipients.
2. The c509f86 fallback to active admins/directors was deployed AFTER both affected approval rows were created, so they never benefited from it. There is also no resend/retry mechanism (TODO at line 332), so once `dispatchPendingDueDiligenceEmail` returns `success:false` the row is permanently stuck.

Going forward, new DD approvals SHOULD email the 7-user admin/director fallback set even with an empty group — assuming the fallback code is actually live in the current deploy.

## Step 5 — Proposed surgical fix

### Fix A (operational, no code) — seed prod data

Run once against prod (or check in as a new migration `0111_lead_dd_recipient_reseed.sql` so all envs converge):

```sql
INSERT INTO public.notification_recipient_groups (key, name, description)
VALUES ('lead_due_diligence', 'Lead Due Diligence',
        'Recipients who receive new-customer lead due diligence approval requests.')
ON CONFLICT (key) DO UPDATE
SET name = EXCLUDED.name, description = EXCLUDED.description;

INSERT INTO public.notification_recipient_assignments (group_id, user_id)
SELECT g.id, u.id
FROM public.notification_recipient_groups g
JOIN public.users u
  ON lower(u.email) IN ('tyamashita@trockgc.com', 'adnaan.iqbal@gmail.com')
WHERE g.key = 'lead_due_diligence'
ON CONFLICT (group_id, user_id) DO NOTHING;
```

Adding it as a new numbered migration guarantees it runs against any env where 0079/0081 silently no-op'd. The seed is idempotent.

### Fix B (code) — make the recipients page tolerate a missing group

The page should not 5xx/404 the entire UI just because the seed didn't run. Surgical change to `server/src/modules/leads/due-diligence-service.ts:804-815`:

```ts
// server/src/modules/leads/due-diligence-service.ts:804
export async function getNotificationRecipientGroup(tenantDb: TenantDb, key: string) {
  const [existing] = await tenantDb
    .select()
    .from(notificationRecipientGroups)
    .where(eq(notificationRecipientGroups.key, key))
    .limit(1);
  const group = existing ?? { id: null, key, name: key, description: null, createdAt: null };
  const recipients = await getLeadDueDiligenceRecipients(tenantDb, key);
  return { group, recipients };
}
```

This lets the recipients admin page load with the fallback admin/director list visible even when the seed row is missing. The PUT endpoint should still 404 if the group doesn't exist (it does today — keep as-is at line 823-825), so admins can't silently assign against a phantom group; instead, the GET should signal "unseeded" via `group.id === null` and the UI can surface a one-click "Initialize group" action that calls a new tiny POST that runs the same INSERT as Fix A.

### Fix C (code) — backfill stuck approvals

For the two existing rows (`ae6fb49f-…` pending, `be4252fc-…` approved), add a director-visible "Resend due diligence email" action that calls `dispatchPendingDueDiligenceEmail` again for pending rows where `email_sent_at IS NULL`. This is the action already documented as a TODO at `due-diligence-service.ts:332-333`. For the already-approved row (`be4252fc-…`), no email needs to go out — it's already decided.

### Tests to add

- `server/tests/modules/leads/due-diligence-service.test.ts` — case: `getNotificationRecipientGroup` against a DB where the group row was never inserted returns `group: { id: null, ... }` plus the admin/director fallback recipients (asserts ≥1 recipient).
- `server/tests/modules/admin/routes.test.ts` — `GET /admin/notification-recipient-groups/lead_due_diligence` returns 200 with `recipients.length > 0` even when `notification_recipient_groups` is empty.
- Migration test (if a runner exists): apply `0111_lead_dd_recipient_reseed.sql` against an empty schema and confirm `notification_recipient_groups` has 1 row and assignments has the seeded admin emails.

### Risks

- **Fix A (data seed):** Almost none — both INSERTs are `ON CONFLICT DO NOTHING`/`DO UPDATE` and reference only public-schema tables. Risk: if Brett/Takashi want a different recipient set, the seed will re-pin Takashi; should confirm intended recipients before merging the migration.
- **Fix B (code):** Low. Changes only `getNotificationRecipientGroup`'s no-row branch. Existing tests asserting 404 from this function need to be updated; PUT path stays unchanged so no auth/CRUD regression risk.
- **Fix C (resend action):** Medium — emails are user-visible. Gate behind director role and confirm the pending row is still `pending` before re-dispatching to avoid spamming on already-decided rows.
- **General:** Confirm `tenantMiddleware` continues to be NOT required for these two endpoints — they touch `public.*` tables only, and adding tenant middleware would actually break callers who haven't selected an office. Leave the raw-pool fallback alone.

## Blockers

None. Auth worked, Railway logs accessible (correct service name is `API`, not `api`), DB connection succeeded via Railway `variables` (env file's `DATABASE_PUBLIC_URL` was stale; flag for cleanup). No data corruption observed — just missing seed rows.
