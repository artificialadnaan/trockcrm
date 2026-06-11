# T-Rock Cam — iOS (Expo)

Native iPhone app that mirrors **T-RockCam.com** (the `client-field/` web app). It is a
new **client** onto the existing trockcrm backend — same endpoints, same auth, no server
changes. iOS-only.

Features (parity with the field web app):
- Field **login** + **invite acceptance** (deep link `trockcam://accept-invite?token=…`)
- **Projects** list — search, starred section, star/unstar, pull-to-refresh
- **Project detail** — photo gallery with grouping (date/category/uploader) + category/tag/uploader filters, full-screen swipe viewer with per-photo details
- **Capture** — rear camera + multi-import, GPS tagging (EXIF → live GPS), 8 categories, description with **voice dictation**, tags with autocomplete, concurrent upload (3), retry-failed, **pending** capture assignment
- **Photo reports** — select → preview → edit titles/descriptions → generate branded PDF
- **Profile** + sign out

## Stack
Expo **SDK 54**, expo-router 6 (file-based, typed routes), React 19.1 / RN 0.81, react-query,
expo-secure-store, expo-image-picker, expo-image-manipulator, expo-location, expo-audio,
expo-file-system. Mirrors the conventions of `trock-expense/apps/mobile`.

## Auth model (verified against the backend)
- JWT returned in the login/accept-invite body → stored in `expo-secure-store` → sent as
  `Authorization: Bearer <jwt>` (no cookie jar).
- Every unsafe request also sends `x-requested-with: XMLHttpRequest` (the **field** CSRF gate).
- Optional `x-office-id`; defaults to the user's primary office.
- 401/403 → sign out; 423 → lockout message.

## Environment
The backend API host is **required** and is provided by the environment — it is never
hard-coded (repo disclosure policy). Set it via an EAS build env var or a local `.env`
to the trockcrm field API host (no trailing `/api`):
```
EXPO_PUBLIC_API_BASE_URL=https://<prod-api-host>
```
Copy `.env.example` to `.env` for local runs, or set it on the EAS build profile / in your
EAS project's environment. The app throws a clear error on launch if it is unset.

## Install
```bash
cd mobile
npm install
```

## First-time EAS setup (one-time, account-bound)
These steps need *your* Expo + Apple accounts and cannot be pre-baked:
```bash
npm i -g eas-cli          # if not already installed
eas login                 # Expo account (owner: adnaan.iqbal)
eas init                  # creates the EAS project + prints its projectId
```
Then make the project id available to `app.config.ts` (either is fine):
```bash
export EAS_PROJECT_ID=<the id eas init printed>
# or add EAS_PROJECT_ID to .env
```

## Run on the iOS Simulator (fastest)
```bash
cd mobile
npx expo run:ios          # builds a dev client into the Simulator
# later runs: npm run dev  (expo start --dev-client)
```

## Build for TestFlight
```bash
cd mobile
eas build --platform ios --profile production
```
- `production` auto-increments the build number (`appVersionSource: remote`).
- EAS manages the iOS distribution certificate + provisioning profile interactively on first run
  (an Apple Developer account is required).

## Submit to TestFlight
```bash
cd mobile
eas submit --platform ios --profile production --latest
```
`--latest` submits the most recent production build. On first submit, EAS prompts for the App
Store Connect app (create one named **T-Rock Cam**, bundle id `com.trockgc.trockcam`) and an
App Store Connect API key.

## Checks
```bash
npm run typecheck     # tsc --noEmit
npm run test          # jest (pure logic: grouping/filtering, api client, upload pool)
npm run doctor        # npx expo-doctor
```

## Notes / scope
- **iOS-only** by design: there is no `android` config block and no Android EAS profile.
- This app is a **non-workspace** package nested in the trockcrm monorepo; `metro.config.js`
  disables hierarchical module lookup so the bundler never resolves the repo's hoisted React.
- **No public photo viewer** in v1 (the field web app has none either; the public share stays
  web-only). The backend public-viewer exposure-policy gap is tracked separately as a
  server-side ticket — see `.audit/trockcam-mobile-discovery.md`.
- Deferred: a native date-range *picker* for the gallery filter (date grouping + category/tag/
  uploader filters ship now; `filterPhotos` already supports `from`/`to`).
