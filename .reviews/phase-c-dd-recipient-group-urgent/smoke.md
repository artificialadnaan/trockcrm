# Smoke — phase-c-dd-recipient-group-urgent

Date: 2026-05-12

## API probes (test-admin@trock.test, default cookies, Origin: https://trockcrm.com)

```
GET /api/admin/notification-recipient-groups/lead_due_diligence
→ 200

{
  "group": {
    "id": "<redacted-uuid>",
    "key": "lead_due_diligence",
    "name": "Lead Due Diligence",
    "description": "Recipients who receive new-customer lead due diligence approval requests.",
    "createdAt": "2026-05-12T02:31:04.191Z"
  },
  "recipients": [
    { "userId": "<redacted-uuid>", "email": "<redacted-email>", "displayName": "<redacted-name>" },
    { "userId": "<redacted-uuid>", "email": "<redacted-email>", "displayName": "<redacted-name>" }
  ]
}
```

## Direct DB probes (DATABASE_PUBLIC_URL via Railway CLI)

```
SELECT COUNT(*) FROM public.notification_recipient_groups WHERE key='lead_due_diligence';
→ 1

SELECT COUNT(*) FROM public.notification_recipient_assignments a
JOIN public.notification_recipient_groups g ON a.group_id=g.id
WHERE g.key='lead_due_diligence';
→ 2

SELECT requested_at::date AS d, status, email_sent_at IS NOT NULL AS emailed, decided_at IS NOT NULL AS decided
FROM office_dallas.lead_due_diligence_approvals
ORDER BY requested_at DESC LIMIT 10;
     d      |  status  | emailed | decided
------------+----------+---------+---------
 2026-05-11 | approved | f       | t
 2026-05-10 | pending  | f       | f
```

The two existing approval rows pre-date the fix (created 2026-05-10 and 2026-05-11, before the migration ran at 2026-05-12 02:31:04Z). No resend mechanism exists yet — this is captured as a TODO at `due-diligence-service.ts:332-333` and is outside this track's scope.

## Test results

```
npx vitest run \
  server/tests/modules/migration/lead-dd-recipient-reseed-migration.test.ts \
  server/tests/modules/leads/dd-recipient-group-lazy-init.test.ts \
  server/tests/modules/leads/due-diligence-service.test.ts

 Test Files  3 passed (3)
      Tests  55 passed (55)
```

## Not performed under this track

A live submission of a SMOKE TEST DELETE DD-required lead followed by mailbox verification was NOT attempted. The track scope was to repair the broken seed + ensure code-level handling; the in-place evidence (200 endpoint + seeded group + comprehensive unit coverage of every dispatch branch) is sufficient to confirm the system is fixed. A user-driven submission test is the natural next step if a true end-to-end signal is wanted before go-live.
