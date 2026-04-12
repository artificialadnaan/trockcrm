# Procore OAuth Read-Only Auth Design

## Goal

Replace the CRM's current Procore `client_credentials` read path with a user-authorized Procore OAuth flow so the admin Procore validation page can read the same live project data that already works in Sync Hub.

## Problem

The current CRM Procore client uses app-only `client_credentials` auth. In production this can:

- fetch the T Rock company successfully
- return an access token successfully
- still return `[]` for `GET /rest/v1.0/companies/{companyId}/projects`

The working reference implementation in `trocksynchubv3` uses:

- Procore OAuth authorization-code flow
- stored access and refresh tokens
- user-context API calls with `Procore-Company-Id`

That difference explains why Sync Hub can see live projects while this CRM cannot.

## Scope

This change is limited to read-only Procore access needed by the admin validation flow.

Included:

- Procore OAuth connect/callback/status/disconnect routes
- encrypted token storage for one Procore connection
- Procore client support for OAuth user tokens with refresh
- read-only validation route using OAuth-backed Procore reads
- admin UI state for connect / connected / disconnected / auth error

Not included in this pass:

- migrating worker write paths to OAuth
- changing CRM-to-Procore write behavior
- broad Procore sync architecture changes
- multi-user Procore account selection

## Recommended Approach

Use a single shared Procore OAuth connection for the CRM, modeled after the existing Microsoft Graph token pattern and the working Sync Hub Procore OAuth flow.

Why this approach:

- matches the known-good production behavior in Sync Hub
- avoids guessing at undocumented `client_credentials` limitations
- keeps the validation flow read-only
- isolates the auth change from write-capable sync code

## Architecture

### 1. Stored Procore OAuth connection

Add a new public table for one Procore OAuth token set:

- `provider = procore` equivalent in a dedicated table
- encrypted `access_token`
- encrypted `refresh_token`
- `token_expires_at`
- optional metadata like scopes and connected account name/email if available

This is application-level shared integration state, not per-CRM-user auth.

### 2. Procore auth routes

Add API routes to:

- generate the authorize URL
- handle the callback
- return connection status
- disconnect the stored token

The callback should:

- exchange code for tokens against `login.procore.com`
- encrypt and store tokens
- redirect back to the CRM admin Procore page

### 3. Procore client auth resolution

Update `server/src/lib/procore-client.ts` so read requests resolve auth in this order:

1. stored Procore OAuth token if present
2. env-based `client_credentials` fallback only if no stored OAuth token exists
3. dev mock mode if Procore credentials are absent

When using OAuth-backed reads:

- send `Authorization: Bearer ...`
- send `Procore-Company-Id: <configured company id>`
- refresh tokens when near expiry

### 4. Read-only validation remains read-only

The project validation route and service must remain GET-only toward Procore.

Allowed:

- token exchange
- token refresh
- `GET` project list requests

Not allowed:

- creating projects
- patching project fields
- mutating CRM sync state as part of validation

### 5. Admin UI connect state

Extend the existing admin Procore page so it:

- checks Procore OAuth connection status
- shows a connect CTA when disconnected
- shows read-only validation results when connected
- shows a clear auth error when tokens are missing/expired/revoked

The page should not silently show `0 projects` when auth is missing or invalid.

## Data Model

Add a new shared table, for example `public.procore_oauth_tokens`, with:

- `id`
- `access_token`
- `refresh_token`
- `token_expires_at`
- `scopes[]`
- `connected_account_email` nullable
- `connected_account_name` nullable
- `status`
- `last_error` nullable
- `created_at`
- `updated_at`

Single-row behavior is acceptable for this pass.

## API Contract

### `GET /api/auth/procore/url`

Returns authorize URL for the Procore OAuth connect flow.

### `GET /api/auth/procore/callback`

Handles Procore redirect and stores tokens. Redirects to `/admin/procore`.

### `GET /api/auth/procore/status`

Returns:

- `connected: boolean`
- `expiresAt`
- `accountEmail`
- `accountName`
- `authMode: "oauth" | "client_credentials" | "dev"`

### `POST /api/auth/procore/disconnect`

Deletes stored OAuth tokens.

## Error Handling

Validation must distinguish these cases:

- no OAuth connection present
- OAuth token refresh failed
- Procore returned 401 or 403
- company accessible but zero projects returned

UI behavior:

- disconnected/auth-failed states show explicit messaging
- true empty project list still shows `0 projects`

## Security

- encrypt stored Procore tokens at rest using the same encryption utility pattern already used for Graph tokens
- validate OAuth state in callback
- use a signed callback state token tied to the current CRM user session
- never expose raw tokens to the frontend

## Testing

Server tests:

- authorize URL generation
- callback exchanges code and stores encrypted tokens
- token refresh path
- status route behavior
- disconnect route behavior
- validation route prefers OAuth token auth over `client_credentials`
- validation route returns explicit auth error instead of fake-empty results when OAuth is required but invalid

Client tests or helper tests:

- connection status view model
- disconnected vs connected vs auth-error rendering

## Rollout

1. Deploy schema and API changes
2. Open `/admin/procore`
3. Connect Procore using the T Rock Procore account
4. Re-run project validation
5. Confirm live projects appear

## Success Criteria

- admin can connect the T Rock Procore account from the CRM
- `/api/procore/project-validation` reads live projects using OAuth-backed Procore access
- the admin Procore page no longer shows a misleading empty result when auth is missing
- no Procore write behavior is introduced in the validation flow
