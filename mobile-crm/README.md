# T-Rock CRM (mobile-crm)

The native CRM app — deals, contacts, notes and the rest of the selling loop on a phone. iOS only,
distributed through TestFlight.

**This is a different app from T-Rock Cam (`mobile/`).** T-Rock Cam is the field capture tool and speaks
only to `/api/field/*`. They share no bundle identifier, EAS project, App Store record, keychain entry or
`node_modules`. Reps will have both installed.

## Why this directory is not an npm workspace

`mobile-crm` is deliberately **not** in the root `package.json` `workspaces` array, and must not be added:

- Metro resolves from the nearest `node_modules`. Self-contained means it always finds this app's React
  first and never walks up into the repo root.
- `expo-doctor` stays clean (it flags hoisted-dependency drift).
- EAS can build the directory standalone.

`mobile/` documents the same constraint for the same reasons. The visible cost is a second nested
`package-lock.json`, which is expected.

The consequence to remember: **the root `npm ci` does not install this app, and `npm run check:premerge`
does not test it.** CI covers it through a dedicated `mobile-crm` job in
`.github/workflows/premerge-build-gate.yml`. Without that job this app would be entirely ungated.

## Setup

```bash
cd mobile-crm
npm ci
cp .env.example .env      # set EXPO_PUBLIC_API_BASE_URL to the API host, without a trailing /api
```

The API host is never committed — the repo's `.husky/pre-commit` hook blocks it. Supply it as a local
`.env` for development and as an EAS build-time environment variable for real builds.

## Commands

| Command | What it does |
|---|---|
| `npm run dev` | Expo dev server (needs a development build — see below) |
| `npm run ios` | Build and run on a local simulator/device |
| `npm run typecheck` | `tsc --noEmit` |
| `npm test` | Jest, including the core-`<Image>` AST guard |
| `npm run doctor` | `expo-doctor` — catches version and resolution drift |
| `npm run build:export` | `expo export` — proves the bundle actually builds |

This app uses `expo-dev-client`, so Expo Go will not run it. Use `npm run ios` or an EAS `development`
build.

## Auth

Login is `POST /api/auth/mobile-login` (added in #959), which returns the JWT **in the response body**.
The web CRM's `/api/auth/local/login` sets an httpOnly cookie a native client cannot read, and the field
app's `/api/auth/field-login` mints `surface:"field"` tokens that CRM routes reject by design.

The client is **Bearer-only and sets no cookie**. That is what keeps it outside the server's CSRF gate,
which engages only when a `token` cookie is present on an unsafe request.

Two behaviours worth knowing:

- **`field_contractor` cannot sign in here.** The server's `requireCrmUser` rejects that role on every CRM
  route, so allowing it would produce a login that succeeds and then 403s on every screen.
- **`must_change_password` is not a login failure.** The user is signed in and routed to
  `change-password`. Bouncing them at login is what produced the loop recorded as `TODO(#721)` on the
  field surface.

## Offices are separate database schemas

Multi-office is schema-per-tenant: the server sets `search_path` per request from the `x-office-id`
header. Sending the wrong office id therefore returns **another office's data**, not an error. The office
switcher must stay explicit and visible for that reason.

## Before the first TestFlight build

Blocked on account access, not code:

1. **App icon and splash.** `app.config.ts` intentionally declares neither, so Expo's defaults apply.
   Reusing `mobile/assets` would put T-Rock Cam's mark on the CRM app.
2. **App Store Connect record** for `com.trockgc.trockcrm` — yields the `ascAppId` for `eas.json`.
3. **`eas init`** under owner `adnaan.iqbal` — yields the `EAS_PROJECT_ID`. There is no committed
   default, so builds must supply it via the environment until the project exists.
4. **`EXPO_TOKEN`** repo secret, for the build workflow.
5. **`EXPO_PUBLIC_API_BASE_URL`** as an EAS build environment variable.

No new server environment variables are required — `mobile-login` reuses `JWT_SECRET`.
