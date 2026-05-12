# DD Email Smoke - Pre-Merge Production Run

Latest run time: 2026-05-12T17:20:47Z

Command shape:

```bash
DATABASE_PUBLIC_URL=$(railway run --service Postgres --environment production node -e "process.stdout.write(process.env.DATABASE_PUBLIC_URL || '')") \
SMOKE_EMAIL_OVERRIDE_CONFIRMED=1 \
railway run --service API --environment production node --import tsx scripts/smoke-dd-email-flow.ts --email-override-confirmed
```

Environment:

- API base: `https://api-production-ad218.up.railway.app`
- Origin: `https://frontend-production-bcab.up.railway.app`
- Login: `test-sales@trock.test`
- Email override: `EMAIL_OVERRIDE_RECIPIENT=adnaan.iqbal@gmail.com` confirmed on production API before send
- Recipients resolved by DD group: `adnaan.iqbal@gmail.com`, `tyamashita@trockgc.com`
- Script safety checks: verified Railway API service env (`RAILWAY_SERVICE_NAME=API`, `RAILWAY_ENVIRONMENT_NAME=production`) and active `EMAIL_OVERRIDE_RECIPIENT`; auto-cleanup enabled by default.

Result:

- Lead ID: `264536d3-afd4-4de2-be6f-27253a90d00a`
- Approval ID: `745ddf0e-678d-49a2-9708-230398963f29`
- Approval status: `pending`
- `email_sent_at`: `2026-05-12T17:20:47.233Z`
- `email_message_id`: `06e5f19e-4e8c-42ff-8c36-d6ac85569cf9`
- Resend dashboard/API check: send-only API key rejected readback with `This API key is restricted to only send emails`; DB `email_sent_at` plus Resend message ID is the available delivery proxy.
- Remote override check: `{ "checked": true, "source": "railway API service environment", "overrideRecipient": "adnaan.iqbal@gmail.com" }`

Cleanup:

```json
{
  "mode": "cleanup",
  "schemaName": "office_dallas",
  "cleanup": {
    "deletedLeadCount": 1
  },
  "retained": false
}
```

Old DD rows:

- `be4252fc-55e7-4e70-ac22-8a62ad5b0115`: approved historical/manual smoke row, lead `5a8f5299-a59e-43bb-b765-7cacfa6febe8`, lead name `test lead smoke test manual`, `email_sent_at=null`. No resend action exists and the row is no longer pending; left untouched as historical.
- `ae6fb49f-60df-4594-b95f-db79c58a80cd`: historical smoke row, lead `c90ed33e-041b-4ddb-8cb6-ea28eb67679f`, lead name `SMOKE Conversion Lead 20260510185030`, `email_sent_at=null`. It is now `approved` as of the latest inspection. No resend admin action exists; left untouched because it predates the recipient fix and is not flagged `is_test_data`, despite smoke naming.
