# Invite Hardening And Volume Validation Design

## Summary

This design hardens the temporary local-auth bridge before broader rollout and adds a repeatable validation loop for the high-volume Admin > Users dataset. The hardening work adds preview-first invite flows, credential revocation, invite expiration, local-auth lockout tracking, and auditable auth events. The validation work adds a production-safe automation path that exercises the large-user admin workflow without sending emails.

The goal is not to change the long-term identity direction. Microsoft SSO is still the future state. This work makes the temporary local-password bridge safer to operate and easier to inspect while the team uses imported users for scale testing.

## Goals

- Let admins preview invite content without sending any email.
- Keep `Send invite` and `Resend invite` available, but make them operationally safer.
- Add a way to revoke temporary local-auth access for a user immediately.
- Expire unused temporary passwords after a fixed window.
- Track failed login attempts and short-term lockouts at the user level.
- Surface invite, login, expiry, and lockout state clearly in Admin > Users.
- Record a public-schema audit trail for invite and local-auth events.
- Add repeatable volume-validation automation that can be run against production or a staging target without sending emails.

## Non-Goals

- Replacing local auth with Microsoft SSO.
- Introducing a full password-reset flow outside the existing invite-first model.
- Bulk-sending invites.
- Building a general-purpose admin analytics dashboard beyond the local-auth signals needed for rollout.
- Reworking the imported-user model, union import rules, or Dallas default office assignment.

## Existing System Constraints

### Current local auth

The repository already supports:

- `POST /api/auth/local/login`
- `POST /api/auth/local/change-password`
- `POST /api/admin/users/:id/send-invite`
- per-user local auth state in `public.user_local_auth`
- JWT cookie sessions that carry `mustChangePassword` but do not currently distinguish local-password sessions from dev sessions

The current flow provisions a password only when `Send invite` is clicked and immediately attempts to email the user.

### Current admin visibility

Admin > Users already shows:

- source-system badges
- coarse local-auth status (`not_invited`, `invite_sent`, `password_change_required`, `active`, `disabled`)
- per-user invite buttons
- bulk role and active/inactive actions

It does not currently show:

- invite expiration
- last invite actor
- last login
- password-changed timestamp
- lockout state
- a revocation action
- an audit trail for invite and auth lifecycle events

### Current safety gaps

The local auth bridge currently has four operational gaps:

1. invites cannot be previewed without sending email
2. temporary passwords do not expire automatically
3. failed local-password attempts do not create per-user lockouts
4. disabling local auth would not stop an already-issued local JWT from continuing to work

These are acceptable for early dev use but are weak for broader rollout.

## Proposed Architecture

The work is split into four bounded units:

1. **Local-auth state expansion**
   Extends `public.user_local_auth` with expiry and lockout fields.

2. **Local-auth event log**
   Adds a dedicated public-schema event table for invite, revoke, login, lockout, and password-change history.

3. **Admin hardening workflow**
   Adds preview and revoke endpoints plus richer Users-page visibility.

4. **Repeatable volume validation**
   Adds an executable automation path that validates the large-user admin workflow without triggering email delivery.

## Data Model Changes

### `public.user_local_auth`

Keep the existing single-row-per-user structure and add:

- `inviteExpiresAt`
- `failedLoginAttempts`
- `lastFailedLoginAt`
- `lockedUntil`
- `revokedAt`
- `revokedByUserId`

Semantics:

- `inviteExpiresAt` is set whenever a temporary password is provisioned.
- `failedLoginAttempts` increments on bad password attempts and resets on successful login or password change.
- `lockedUntil` is set once the user crosses the failure threshold.
- `revokedAt` and `revokedByUserId` indicate the temporary local-auth bridge was explicitly disabled by an admin.

### `public.user_local_auth_events`

Add an append-only event table keyed by `id` with:

- `userId`
- `eventType`
- `actorUserId` nullable
- `metadata` JSONB nullable
- `createdAt`

`eventType` covers:

- `invite_previewed`
- `invite_sent`
- `invite_resent`
- `invite_revoked`
- `login_succeeded`
- `login_failed`
- `login_locked`
- `password_changed`

This table is the authoritative audit trail for temporary local-auth operations.

## Invite Hardening Design

### Preview-first invite flow

Add a new admin-only endpoint:

- `POST /api/admin/users/:id/preview-invite`

This endpoint does not mutate auth state and does not send email. It returns:

- recipient email
- email subject
- HTML/text preview body
- the current login URL
- a redacted placeholder for the temporary password instead of a real password

This lets admins verify the content and destination before sending.

### Send and resend behavior

Keep `POST /api/admin/users/:id/send-invite`, but change its semantics:

- provision or rotate the temporary password
- set `mustChangePassword = true`
- set `inviteExpiresAt` to a fixed TTL
- clear prior lockout state
- send the actual email
- record either `invite_sent` or `invite_resent`

### Expiration policy

Unused temporary passwords expire after `72 hours`.

Expired temporary credentials:

- still appear in Admin > Users as invite-related state
- may not be used for login
- can be renewed only by sending or resending an invite

`preview-invite` does not refresh the expiration window because it does not provision a password.

### Revocation behavior

Add:

- `POST /api/admin/users/:id/revoke-invite`

Revocation:

- disables local auth for the user
- clears `mustChangePassword`
- clears `lockedUntil` and failure counters
- stamps `revokedAt` and `revokedByUserId`
- records `invite_revoked`

This is the emergency stop for temporary local access before SSO arrives.

### Session invalidation behavior

Revocation must also stop existing local-password sessions, not just future logins.

JWT claims therefore gain an explicit auth source:

- `authMethod = "local"` for local-password sessions
- `authMethod = "dev"` for dev quick-login sessions

The request auth middleware re-checks local-auth gate state on every request for `authMethod = "local"`. If the local-auth row is disabled or revoked, the request is rejected even if the cookie itself has not expired yet.

The shared `JwtClaims` type must be expanded to carry `authMethod`.

For rollout compatibility, pre-deploy cookies that do not contain `authMethod` are treated as legacy sessions and rejected once this change ships. Users must authenticate again to receive a typed post-deploy session cookie. This keeps revocation rules simple and avoids guessing whether an old cookie came from dev or local auth.

## Login Hardening Design

### Lockout policy

Local login keeps the existing route shape but adds per-user lockout rules:

- threshold: `5` failed attempts
- lock window: `15 minutes`

Behavior:

- every failed password attempt increments `failedLoginAttempts`
- the fifth consecutive failure sets `lockedUntil`
- any further attempt during the lock window returns a deterministic lockout error
- successful login resets failure counters and clears lockout state

### Expired invite handling

If the password is correct but `inviteExpiresAt` is in the past and `mustChangePassword = true`, the login is rejected with an invite-expired error. Admins must resend or revoke the invite; users cannot recover from this state themselves.

### Password change behavior

Successful password change:

- writes the new hash
- clears `mustChangePassword`
- clears `inviteExpiresAt`
- clears failure counters and lockout state
- writes `passwordChangedAt`
- records `password_changed`

## Admin UX Changes

### Users table

Extend the existing `GET /api/admin/users` payload with:

- `inviteExpiresAt`
- `lastLoginAt`
- `passwordChangedAt`
- `lockedUntil`
- `lastInviteActorName` optional
- `lastInviteAt` optional
- `revokedAt`

The page should present:

- preview button
- send/resend button
- revoke button when local auth exists
- expanded login-state copy for:
  - invite expires in / expired
  - locked until
  - last login
  - password changed

### Invite preview dialog

Add a dialog opened from `Preview invite` that shows:

- recipient
- subject
- rendered message copy
- login URL
- an explicit note that the temporary password is generated only on send

The dialog has no send side effect by default. A secondary `Send invite` action inside the dialog is acceptable, but the default validation path should still work by opening and closing the dialog without sending.

### Auth event drawer

Add a lightweight drawer or dialog for per-user local-auth events. It only needs the most recent events and should show:

- event type
- timestamp
- actor when present
- concise metadata summary

This is for operators to understand whether a user was invited, re-invited, revoked, locked, or successfully activated.

## Volume Validation Design

### Scope

The validation loop targets the imported-user-heavy admin surface, not the entire app. It verifies that:

- Admin > Users loads against the real high-volume dataset
- search and filter counts remain coherent
- preview-invite flow works without sending email
- revoke flow updates state and reloads cleanly
- login-state badges react correctly to lockout/expiry/revocation test fixtures

### Executable automation

Add a Playwright-driven script that can run against a target frontend URL and:

1. sign in through one of two explicit auth modes
2. open Admin > Users
3. assert summary cards and filter controls exist
4. search for a test user
5. open invite preview and verify dialog content
6. revoke local auth for a test user when explicitly requested by the script inputs
7. verify the table refreshes with the expected status

The default mode must avoid sending emails.

Supported auth modes:

- `dev-picker` for local/dev environments where the quick-login picker is enabled
- `local-credentials` for production or staging, using a designated internal test-admin account supplied through environment variables

The script must not assume that the dev picker exists in production.

Production-safe validation accounts:

- auth account: a maintained internal test-admin mailbox such as `admin@trock.dev`
- mutation target: a maintained internal test user such as `rep@trock.dev`

The script must require these values explicitly in credential mode and must not fall back to imported real customer addresses.

### Test-user discipline

Automation only mutates designated dev users such as `rep@trock.dev`. It does not operate on imported real addresses and does not click `Send invite`.

## API Changes

Add or extend:

- `POST /api/admin/users/:id/preview-invite`
- `POST /api/admin/users/:id/revoke-invite`
- `GET /api/admin/users/:id/local-auth-events`
- `GET /api/admin/users`
  - include expanded local-auth fields listed above

Update:

- `POST /api/admin/users/:id/send-invite`
  - provision expiring credentials
  - clear lockout state
  - write event log entries

- `POST /api/auth/local/login`
  - enforce expiration and lockout
  - write success/failure/lock events

- `POST /api/auth/local/change-password`
  - clear expiry/failure/lock fields
  - write `password_changed`

- JWT auth claims and request auth middleware
  - include `authMethod`
  - reject revoked/disabled local-auth sessions on every authenticated request

## Error Handling

Deterministic user-facing error cases:

- invite preview for inactive user
- send invite for inactive user
- login attempt during lockout
- login attempt with expired invite
- revoke on user with no local auth row
- event-log request for missing user

Admin UI must show these as actionable toast or inline errors, not generic fetch failures.

## Security Notes

- Do not store plaintext temporary passwords.
- `preview-invite` never generates or returns a real password.
- Preview and send must share the same invite-template builder so the preview body and the sent email stay aligned except for the password placeholder.
- Lockout checks happen before password verification is reattempted.
- Revoke disables the local bridge cleanly without deleting audit history.
- Audit events belong in `public`, not tenant schemas, because auth is global.

## Testing Requirements

### Server

- preview-invite route returns redacted preview and no email send
- send-invite writes expiry and event rows
- resend-invite rotates state and writes `invite_resent`
- revoke disables local auth and writes `invite_revoked`
- failed login increments counters
- fifth failed login sets `lockedUntil`
- successful login clears failure counters
- expired invite blocks login
- password change clears expiry/lockout and writes event

### Client

- Users page renders new login metadata
- preview dialog opens with returned content
- revoke action refreshes state
- event drawer renders recent entries
- invite and revoke buttons disable while pending

### Automation

- validation script passes against a high-volume dataset without sending email
- validation script can target production and a non-production URL

## Rollout

1. Ship preview/revoke/event-log support.
2. Ship login expiry and lockout.
3. Run the no-email validation loop against production.
4. Only after that, use `Send invite` for controlled rollout.
