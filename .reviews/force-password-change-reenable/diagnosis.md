# Force Password Change Re-enable Diagnosis

## Assumptions

- "Real T Rock users" means active, enabled, non-revoked local-auth users whose email is not `@trock.test` or `@trock.dev`.
- `field_contractor` local-auth rows are not eligible for this CRM force-password-change pass because `loginWithLocalPassword()` rejects that role before password verification.
- Path A is authoritative: keep existing Friday temporary passwords valid; do not rotate password hashes.

## What Was Disabled

The disable was a code change plus a production DB state change.

Code change:

- Commit `d63d7117` (`fix: let invites proceed directly to cleanup`) changed `server/src/modules/auth/local-auth-service.ts`.
- `sendUserInvite()` was changed from `mustChangePassword: true` to `mustChangePassword: false` for both insert and upsert paths.
- Invite copy was changed away from immediate password-change language and toward cleanup-only onboarding.

Database state:

- Production `public.user_local_auth` currently has no eligible real local-auth users with `must_change_password=true`.
- All eligible real users were effectively left using their Friday temp passwords as working passwords during cleanup.

Environment:

- Railway API production env has no force-password-change bypass flag.
- Checked password/auth-related names; relevant values were `DEV_MODE=false`, `ALLOW_DEV_AUTH_IN_PROD=false`, and `AUTH_COOKIE_DOMAIN=.trockcrm.com`.

Current gate code:

- `client/src/App.tsx` still renders `<ForcePasswordChangeScreen />` when `user.mustChangePassword` is true.
- `server/src/middleware/auth.ts` still blocks non-auth endpoints for users with `mustChangePassword=true`, except `/api/auth/me`, `/api/auth/logout`, and `/api/auth/local/change-password`.
- Therefore, the CRM force-password-change gate is still live. The bypass is that affected rows are false and future invites currently create false rows.

## Production User State Before Re-enable

Production data was queried during discovery and dry-run verification. Exact counts and user identifiers are intentionally omitted from this committed report to avoid publishing production operational data in GitHub. The unredacted dry-run output is retained for the final operator handoff.

## Expired Invite Edge Case

Some eligible users have `last_login_at=null` and expired `invite_expires_at`. If we only set `must_change_password=true`, their existing Friday temporary passwords would still fail with `Temporary invite has expired`.

The script therefore clears `invite_expires_at` only for affected users with no login and an expired invite. This does not rotate or change their password hash; it preserves Path A by keeping the existing temp password valid while forcing a password change at next successful login.

## Password-Change Cookie Fix Verification

Created and deleted a `SMOKE TEST DELETE` production user with `must_change_password=true`.

Browser flow through the fallback production frontend/API host after PR `#274`:

```json
{
  "ok": true,
  "meAfterChange": {
    "status": 200,
    "mustChangePassword": false
  },
  "csrflessChange": {
    "status": 403,
    "body": "{\"error\":{\"message\":\"Invalid CSRF token\"}}"
  },
  "meAfterRelogin": {
    "status": 200,
    "mustChangePassword": false
  }
}
```

This confirms the prior cookie/CSRF bug is fixed without disabling CSRF.

## Re-enable Plan

- Restore `sendUserInvite()` so future temporary-password invites set `mustChangePassword=true`.
- Update invite copy to mention immediate password change again.
- Add `scripts/force-password-change-real-users.ts`.
- Add `password_change_forced` to `local_auth_event_type` so the production flip writes a durable per-user auth event.
- After deploy, run the script with `--execute` against production.
- Verify eligible real-user count moves from false to true as expected in the unredacted operator output.
