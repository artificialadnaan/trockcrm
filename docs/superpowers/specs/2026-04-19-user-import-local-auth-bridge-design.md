# User Import And Local Auth Bridge Design

## Summary

This design adds a one-shot user import for mass testing and a temporary local-password onboarding flow that will later be replaced by Microsoft SSO. The import seeds the union of Procore users and HubSpot owners into CRM users, assigns new users to the Dallas office with the default `rep` role, and preserves existing CRM assignments. The admin panel remains the source of truth for viewing, activating, deactivating, and promoting users.

The temporary auth bridge lets admins send invites after import. Each invite rotates a random temporary password, emails login instructions, and forces the user to change their password immediately after first login. The local-auth layer is isolated from the core `users` table so it can be removed or disabled cleanly when Microsoft SSO is introduced.

## Goals

- Seed a large testable user set from the union of Procore and HubSpot identities.
- Populate imported users in Admin > Users without waiting for first login.
- Preserve current CRM users conservatively when email matches an imported identity.
- Give admins a manual invite action instead of auto-emailing during import.
- Provide a temporary `email + password` login flow for imported users.
- Force a password change immediately after first successful login with a temporary password.
- Keep the design compatible with future Microsoft SSO linking by email and `azureAdId`.

## Non-Goals

- Implementing Microsoft SSO login.
- Inferring CRM roles from Procore titles, HubSpot roles, or Graph claims.
- Building a recurring background sync for external users.
- Granting dynamic office access beyond assigning new users to Dallas as their primary office.
- Changing existing users' role, office, or active status during import.

## Existing System Constraints

### User identity

The application stores users in `public.users` with these important fields:

- `email`
- `displayName`
- `azureAdId`
- `role`
- `officeId`
- `isActive`

The current admin users page reads directly from this table via `/api/admin/users`.

To support imported-user visibility, the admin users response will be extended with derived fields from the new external identity and local-auth tables:

- `sourceSystems`
- `localAuthStatus`
- invite timestamps if useful for admin troubleshooting

### Current auth

The repository does not currently have password-based production auth. It has:

- dev login via `/api/auth/dev/login`
- current-user session lookup via `/api/auth/me`
- cookie-based JWT session handling
- Microsoft Graph OAuth for email access, not for directory-wide user login

### Current external integrations

- HubSpot already has owner-fetch support that can resolve owner email addresses.
- Procore has authenticated API plumbing but no existing CRM user-import path.

## Proposed Architecture

The feature is split into four bounded units:

1. **External user import service**
   Fetches HubSpot owners and Procore users, normalizes them, unions them by email, and upserts CRM users conservatively.

2. **Temporary local-auth credential store**
   Stores password hashes and onboarding state for imported users without polluting `public.users`.

3. **Admin invite workflow**
   Adds admin endpoints and UI actions for sending invites and re-sending invites later.

4. **Temporary login + forced password reset flow**
   Adds a local login route and a first-login password change gate while preserving the existing cookie/JWT session model.

## Import Design

### Source set

The import uses the union of:

- HubSpot owners
- Procore users

Each source record is normalized into a shared import shape:

- `email`
- `displayName`
- `externalIds`
  - `hubspotOwnerId`
  - `procoreUserId`
- `sourceFlags`
  - `fromHubspot`
  - `fromProcore`

### Matching and normalization

User matching is based on normalized email:

- trim
- lowercase
- reject blank or malformed email entries

If both systems produce the same email, they collapse into one CRM user candidate and both source identifiers are retained.

### Conservative upsert rules

For an imported candidate whose email already exists in CRM:

- do not change `role`
- do not change `officeId`
- do not change `isActive`
- do not overwrite `displayName` if the CRM user already has one
- do fill missing external/source metadata
- do fill missing `azureAdId` later if SSO linking adds it

For a candidate missing from CRM:

- create a new CRM user
- assign primary office to Dallas
- assign role `rep`
- set `isActive = true`

### Dallas office assignment

The import resolves the Dallas office record once by slug and fails fast if the office does not exist or is inactive. New imported users use Dallas as their primary office. Existing users keep their current office.

### External metadata persistence

The current `users` table does not have fields for HubSpot owner ID or Procore user ID. To avoid overloading existing fields, the design adds a dedicated mapping table for imported identities so the system can:

- preserve external identifiers
- record which systems each user came from
- avoid duplicate re-imports
- support future audit/debugging

Proposed fields:

- `userId`
- `sourceSystem` (`hubspot`, `procore`)
- `externalUserId`
- `externalEmail`
- `externalDisplayName`
- `lastImportedAt`

Uniqueness should prevent the same source user from linking to multiple CRM users.

## Temporary Local Auth Design

### Why a separate auth store

Local auth is temporary and should not become the long-term identity model. Password hashes, invite state, and password-reset requirements belong in a separate auth table, not directly on `public.users`.

This makes SSO cleanup straightforward:

- disable local login
- leave `users` intact
- keep email identity continuity

### Credential table

Add a dedicated `user_local_auth` table keyed by `userId` with:

- `passwordHash`
- `mustChangePassword`
- `inviteSentAt`
- `inviteSentByUserId`
- `lastLoginAt`
- `passwordChangedAt`
- `isEnabled`
- timestamps

This table exists only for users who should be able to use temporary local auth.

### Invite behavior

The import does not send emails.

Admins can later click `Send invite` on a user in Admin > Users. The invite action:

1. generates a random temporary password
2. hashes it securely
3. upserts the user’s local-auth row
4. sets `mustChangePassword = true`
5. records invite metadata
6. sends an email containing:
   - the login email
   - the temporary password
   - a link to the login page

Re-sending an invite rotates the password and invalidates the previous one.

### Login behavior

Local login uses `email + password` and the existing JWT cookie/session model.

On successful password login:

- if `mustChangePassword = false`, login completes normally
- if `mustChangePassword = true`, login succeeds but the frontend is immediately redirected into a mandatory password change screen

The user may not access the rest of the app until the password change succeeds.

### Password change behavior

The forced password change screen:

- requires current temporary password confirmation
- requires a new password + confirmation
- rejects weak or malformed passwords according to a defined minimum policy
- updates the stored hash
- sets `mustChangePassword = false`
- sets `passwordChangedAt`
- then transitions into the normal authenticated app

## Admin UX Changes

### Users page

Admin > Users should show imported users the same way existing users are shown today, with incremental additions:

- source badges or summary such as `HubSpot`, `Procore`, or `HubSpot + Procore`
- local auth status
  - not invited
  - invite sent
  - password change required
  - active local auth
- action button
  - `Send invite`
  - `Resend invite` when already provisioned

The existing role and active/inactive controls remain.

### Import execution

The design uses a one-shot import entry point, not a recurring sync. That can be exposed as:

- an admin-only server route triggered from the UI, or
- a one-shot server script/CLI task

For this feature, the recommended first delivery is an admin-only one-shot import route plus a button or command the operator can run intentionally.

The response should include a summary:

- scanned source counts
- created CRM users
- matched existing CRM users
- skipped invalid records
- source-specific errors

## API Changes

### Admin import endpoints

- `POST /api/admin/users/import-external`
  - admin only
  - performs one-shot union import from Procore + HubSpot
  - returns summary counts and row-level warnings

### Admin invite endpoints

- `POST /api/admin/users/:id/send-invite`
  - admin only
  - provisions or rotates temporary local auth
  - sends invite email

### Local auth endpoints

- `POST /api/auth/local/login`
  - public
  - accepts `email`, `password`
  - returns user payload and a `mustChangePassword` session flag

- `POST /api/auth/local/change-password`
  - authenticated local user
  - requires current password and new password
  - clears `mustChangePassword`

- `GET /api/auth/me`
  - extend response to include whether the current session must change password

### Admin user listing

- `GET /api/admin/users`
  - keep current user rows
  - extend each row with:
    - `sourceSystems`
    - `localAuthStatus`
    - optional invite metadata for operational visibility

## Security And Validation

### Password handling

- store only password hashes, never plaintext
- use a modern password hashing algorithm already available in the server runtime
- temporary passwords are visible only at generation time for the outbound email
- re-sending an invite invalidates the old temporary password

### Access control

- only admins can import users
- only admins can send or re-send invites
- inactive users cannot authenticate through temporary local auth
- local login can be guarded by an environment flag so it is easy to disable globally after SSO launch

### Import safety

- fail if Dallas office cannot be resolved
- skip source rows with missing/invalid email
- log row-level issues without failing the entire batch unless a hard dependency is missing

## Testing Strategy

### Import tests

- unions HubSpot + Procore users by normalized email
- creates missing users as Dallas reps
- preserves existing CRM role/office/active state
- records external identity mappings
- skips invalid-email rows

### Invite tests

- send invite provisions local auth
- resend invite rotates password hash and updates timestamps
- invite email payload contains expected login instructions

### Local auth tests

- valid local login sets session
- inactive users are rejected
- wrong password is rejected
- must-change-password users are blocked from app access until password change
- successful password change clears the gate

### Admin UI tests

- users page shows source/auth status
- send invite action triggers refresh
- must-change-password state is visible

## Rollout Plan

1. Add data model and server services for import + temporary local auth.
2. Add one-shot import path and validate imported users appear in Admin > Users.
3. Add invite email action.
4. Add local login + forced password change flow.
5. Use the system for mass-volume testing.
6. Later, disable local auth once Microsoft SSO is ready and users are linked by email/`azureAdId`.

## Open Decisions Resolved

- Seed set: union of Procore users and HubSpot owners.
- Default office for new users: Dallas.
- Default role for new users: `rep`.
- Existing users: conservative update only.
- Invite timing: import first, invite later from Admin.
- Local auth lifetime: temporary bridge until Microsoft SSO is implemented.
