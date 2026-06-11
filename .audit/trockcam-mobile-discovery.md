# T-Rock Cam (iOS / Expo) — Build-Ready Discovery

**Date:** 2026-06-11 · **Branch lane:** RED (new mobile client)
**Source web app:** `client-field/` (React 19 + Vite SPA) = "T-RockCam.com"
**Backend (unchanged, consumed as-is):** `server/src/modules/field/*`, `public-photo-tokens/*`, `files/*`
**Target:** Expo SDK 54 (RN 0.81.x / React 19) **iOS-only**, distributed via EAS → TestFlight
**Reference Expo project:** `/Users/adnaaniqbal/projects/trock-expense/apps/mobile`

> Every endpoint/shape/behavior below was transcribed from actual source by 4 parallel readers + synthesis. Mounted backend paths are `/api/...`.

---

## 1. Feature Inventory (web → must exist on mobile)

### 1.1 Auth & session
- **Login** (`LoginPage`) — email+password → `POST /api/auth/field-login`; lockout (423) after 5 fails/15min.
- **Accept invite** (`AcceptInvitePage`) — `GET /api/auth/invite-preview?token=` → `POST /api/auth/accept-invite` (password ≥8 + confirm + strength hint). Deep-link target.
- **Session bootstrap / role gate** (`auth.tsx`, `ProtectedRoute`) — `GET /api/field/me`; allowed roles: `admin, director, rep, construction, field_contractor`.
- **Logout** — `POST /api/auth/logout` (+ clear local CSRF/office).

### 1.2 Projects (deals) browsing
- **Projects list** (`ProjectsPage`) — `GET /api/field/projects?status=active&page=&perPage=&search=` (50/page; search name/deal#/address; stage badge, address, photo count, last-activity; pull-to-refresh).
- **Starred section** — `GET /api/field/projects/starred` (shown only if ≥1 star; skipped during search).
- **Star/unstar** — `POST` / `DELETE /api/field/projects/:dealId/star`.

### 1.3 Project detail, gallery & reports
- **Photo gallery** (`ProjectDetailPage`) — `GET /api/field/projects/:dealId/photos?category=&uploader=&from=&to=` (grid; group by date/category/uploader; filter category/tags/date-range/uploader; swipe modal viewer; per-photo address/coords/GPS-source/Procore-sync; 8 category pills).
- **Reports list + download** — `GET /api/field/projects/:dealId/reports` → `GET /api/field/reports/:reportId/download`.
- **Report builder** (`ReportBuilder`) — `POST /api/field/reports/preview` → `POST /api/field/reports/generate` (two-step select→edit; group by tag/date/none; section reorg/reorder; per-section description override; custom sections; branded PDF, 7-day expiry).
- **Tag autocomplete** — `GET /api/field/projects/:dealId/tags?q=&limit=`.

### 1.4 Capture & upload (the core flow)
- **Target validate/search** — `GET /api/field/photo-targets/validate?...` ; `GET /api/field/photo-targets/search?search=&limit=` (deals/leads/opps, debounced 200ms).
- **Capture** — rear camera + multi-gallery import; 8 categories; description; voice dictation; tags.
- **3-step upload** (`capture-upload.ts`) — `POST /api/field/photos/upload-url` → `PUT {uploadUrl}` (R2 presigned, off-backend, `Content-Type` only) → `POST /api/field/photos/confirm-upload`. Concurrency = 3; retry-failed-only.
- **Tag sync** (non-blocking, after confirm) — `POST /api/field/photos/:photoId/tags` (`DELETE .../tags/:tag` exists).
- **Pending captures** (no target) — `GET /api/field/photos/pending` → `POST /api/field/photos/:photoId/assign-target`.
- **Voice dictation** (`VoiceRecorder`/`photo-dictation.ts`) — `GET /api/field/photos/transcribe-description` (probe `{configured}`) then `POST` raw audio body + `x-file-name` header (≤60s, 2 retries/500ms backoff).
- **GPS priority:** EXIF → live GPS → none. `addressSource: 'exif' | 'live_gps'`. Camera compress: JPEG, maxWidthOrHeight 2048, maxSizeMB 1.2, quality 0.85.

### 1.5 Shell / profile
- **FieldLayout** — header + logo + user name; bottom nav Projects/Capture/Profile; logout; safe-area.
- **HomePage** (profile) — greeting; placeholder.

### 1.6 Public viewer (separate surface — NOT part of the field SPA)
- `GET /api/public/photo-viewer/:token` (deal meta + photo timeline) ; `GET /api/public/photo-viewer/:token/photos/:photoId/download` (audited presigned). `client-field` has **no** public-viewer page.

---

## 2. Verified API contract

| # | Method | Path | Auth | Notes |
|---|---|---|---|---|
| 1 | POST | `/api/auth/field-login` | **public** (rate-limited) | `{email,password}` → `{user,token,csrfToken?}` |
| 2 | POST | `/api/auth/accept-invite` | **public** | `{token,password}` → `{user,token,csrfToken?}` |
| 3 | GET | `/api/auth/invite-preview?token=` | **public** | `{firstName,lastName,email}` |
| 4 | POST | `/api/auth/logout` | session | clears session (web-only caller; verify Bearer) |
| 5 | GET | `/api/field/me` | field | `{user: FieldUserResponse}` |
| 6 | GET | `/api/field/projects` | field+tenant | `{projects,total,page,perPage}` |
| 7 | GET | `/api/field/projects/starred` | field+tenant | `{projects}` |
| 8/9 | POST/DELETE | `/api/field/projects/:dealId/star` | field+tenant | `{starred}` |
| 10 | GET | `/api/field/projects/:dealId/photos` | field+tenant | `{photos, pagination}` |
| 11 | GET | `/api/field/projects/:dealId/reports` | field+tenant | `{reports}` |
| 12 | GET | `/api/field/projects/:dealId/tags?q=&limit=` | field+tenant | `{tags}` |
| 13 | GET | `/api/field/reports/:reportId/download` | field+tenant | `{url,filename}` (presigned ~3600s) |
| 14 | POST | `/api/field/reports/preview` | field+tenant | `{cover,sections}` |
| 15 | POST | `/api/field/reports/generate` | field+tenant | `{report:{id,title,pdfUrl,expiresAt,createdAt}}` |
| 16 | GET | `/api/field/photo-targets/search?search=&limit=` | field+tenant | `{targets:[{id,name,type,dealNumber?}]}` |
| 17 | GET | `/api/field/photo-targets/validate?dealId=…` | field+tenant | `{target:{id,type}}` |
| 18 | POST | `/api/field/photos/upload-url` | field+tenant | → `{uploadUrl,objectKey,r2Key,expiresIn,uploadToken,systemFilename,displayName,folderPath}` |
| 19 | PUT | `{uploadUrl}` (R2, off-backend) | presigned | `Content-Type` only; no checksum/auth header |
| 20 | POST | `/api/field/photos/confirm-upload` | field+tenant | `{…,uploadToken,objectKey,latitude?,longitude?,addressSource?,takenAt?}` → `{photo}` |
| 21 | GET | `/api/field/photos/pending` | field+tenant | `{photos}` |
| 22 | POST | `/api/field/photos/:photoId/assign-target` | field+tenant | → `{photo}` |
| 23 | POST | `/api/field/photos/:photoId/tags` | field+tenant | `{tags}` → `{tags}` |
| 24 | DELETE | `/api/field/photos/:photoId/tags/:tag` | field+tenant | → `{tags}` |
| 25 | GET | `/api/field/photos/transcribe-description` | field | `{configured}` |
| 26 | POST | `/api/field/photos/transcribe-description` | field | raw audio + `x-file-name` → `{transcript,language?,duration?}` |
| 27 | POST | `/api/field/photos/:photoId/transcribe-description` | field+tenant | raw audio + `x-file-name` |
| 28 | GET | `/api/public/photo-viewer/:token` | **public (token)** | deal + photos (see §4) |
| 29 | GET | `/api/public/photo-viewer/:token/photos/:photoId/download` | **public (token, audited)** | `{url,filename}` |

**Must use the field photo wrappers (#18/#20), not CRM `/api/files/*` (those require `authMiddleware`, not the field role).**

---

## 3. Auth model (RESOLVED → Bearer token)

- **Session = JWT** `{userId,email,officeId,role,authMethod:'local'}`, **24h** expiry, **no refresh** endpoint. Returned in the login/accept-invite **response body as `token`** (in addition to an httpOnly cookie).
- **Mobile decision: use `Authorization: Bearer <jwt>` + `expo-secure-store`** (RN has no durable cookie jar; cookie is `Secure`/`SameSite`/`.trockcrm.com`-scoped → fragile on native). Backend's field middleware accepts Bearer for `/api/field/*`.
- **Field CSRF ≠ CRM CSRF:** `/api/field/*` does **not** validate `x-csrf-token`; it requires **`x-requested-with: XMLHttpRequest`** on every unsafe method (POST/PUT/PATCH/DELETE). Omitting it → **403 on every write**.
- **Office:** optional `x-office-id`; default to user's primary office (`FieldUserResponse.tenantId`). No field endpoint lists accessible offices → office-switcher out of scope v1.
- **Errors:** 401/403 → clear secure-store + route to login; **423** (lockout) → distinct login-screen message.
- `FieldUserResponse = { id, email, firstName|null, lastName|null, role, tenantId, active }`.

---

## 4. Exposure policy — ⚠️ DISCREPANCY (needs decision)

**Task says (claimed "already locked"):** keep `name / address / uploader`; **drop `GPS / geocoded address / dealNumber`.**

**What the current backend `publicPhotoShape` actually returns** (`public-photo-tokens/service.ts:226-289`):
- Keeps: deal `name`, **`dealNumber`**, `propertyAddress`, uploader name.
- Keeps per-photo: **geocoded `address`**, **`latitude`/`longitude` rounded to 7 dp**, `addressSource`, plus category/description/takenAt/mime/etc.
- Drops: raw full-precision GPS (`geoLat/geoLng`), `r2Key`/`systemFilename`/`folderPath`, deal finance, file internals, external URLs, linked-record IDs.
- **`jpegOnly: false`** (AVIF/GIF/HEIC/HEIF/JPEG/PNG/WEBP all served) and **`exifStripped: false`** (R2 streams the original unmodified binary; no proxy/transcode).

➡️ The current public viewer **exposes `dealNumber`, geocoded address, and rounded GPS** — the three things the task's locked policy says to drop. It also does **not** strip EXIF and is **not** JPEG-only. **This must be reconciled** (see decision Q below). The field SPA itself has no public viewer, so this only matters if the mobile app adds one.

---

## 5. Expo conventions to mirror (trock-expense/apps/mobile)

- Expo **SDK 54.0.0**, React **19.1.0**, RN **0.81.5**, `newArchEnabled: true`.
- **expo-router ~6** (file-based, `experiments.typedRoutes`), `app/` + `(app)` auth group + `[id].tsx`.
- Deps: `@tanstack/react-query` (user-scoped keys, `clear()` on sign-out), `expo-secure-store` (`trock.session.v1` blob + type guard), `expo-image-picker` (`exif:true`, `quality 0.7`), `expo-file-system/legacy` `uploadAsync` PUT, `expo-constants`, `expo-status-bar`, `react-native-gesture-handler`/`safe-area-context`/`screens`.
- **API client:** `apiFetch<T>(path,{token,method,body,onUnauthorized,timeoutMs})` — 30s timeout, `ApiError(status,message)`, 204→undefined, 401→onUnauthorized. `endpoints.ts` = injectable `Fetcher` fns; `AuthContext` injects token-bound fetcher.
- **Upload:** picker → contentType → `createUploadUrl` → `putFileToR2` (`FileSystem.uploadAsync`, BINARY_CONTENT, Content-Type only) → confirm.
- **Shell:** `RootLayout` = `GestureHandlerRootView` > `SafeAreaProvider` > `QueryClientProvider` > `AuthProvider` > `Stack`; `(app)/_layout.tsx` gates `!token` via `<Redirect>`; `ready` flag blocks first paint.
- **Config:** `EXPO_PUBLIC_API_BASE_URL` in `src/config.ts`. `app.json` (scheme, bundleId, infoPlist permissions, plugins, `extra.eas.projectId`). `index.ts` → `import 'expo-router/entry'`. TS strict, `@/* → ./src/*`.
- **eas.json:** `cli.appVersionSource:remote`; `development`(devClient/internal) · `preview`(internal) · `production`(`autoIncrement`); `submit.production`.

---

## 6. Proposed Expo structure (iOS-only) — mobile substitutions

```
mobile/
├── app.config.ts            # iOS bundleId, name "T-Rock Cam", icon/splash, infoPlist, plugins, extra.eas
├── eas.json                 # iOS-only: development / preview / production + submit.production
├── index.ts                 # import 'expo-router/entry'
├── babel.config.js · metro.config.js · tsconfig.json · README.md
├── assets/                  # icon, splash, T Rock logo
├── app/
│   ├── _layout.tsx          # RootLayout (providers + Stack)
│   ├── index.tsx            # gate → /login or /(app)/projects
│   ├── login.tsx            # ← LoginPage
│   ├── accept-invite.tsx    # ← AcceptInvitePage (deep-link)
│   └── (app)/
│       ├── _layout.tsx      # Tabs: Projects / Capture / Profile (← FieldLayout) + Redirect gate
│       ├── projects/index.tsx        # ← ProjectsPage
│       ├── projects/[id].tsx         # ← ProjectDetailPage (gallery + reports + ReportBuilder)
│       ├── capture.tsx               # ← CapturePage
│       └── profile.tsx               # ← HomePage
└── src/
    ├── config.ts · theme/theme.ts
    ├── auth/{AuthContext.tsx, session.ts}
    ├── api/{client.ts, endpoints.ts}
    ├── capture/{camera.ts, gallery.ts, location.ts, compress.ts, upload.ts}
    ├── dictation/transcribe.ts
    ├── projects/field-projects.ts
    ├── query/{keys.ts, hooks.ts}
    └── components/{ui.tsx, BrandLogo, VoiceRecorder, PhotoTagInput, ReportBuilder, PhotoGrid, PhotoViewerModal, TargetPicker}
```

| Web (browser) API | Mobile replacement |
|---|---|
| `getUserMedia` rear camera | `expo-camera` `CameraView` (or `expo-image-picker.launchCameraAsync`) |
| `<input type=file multiple>` | `expo-image-picker.launchImageLibraryAsync({allowsMultipleSelection,exif:true})` |
| `exifr.parse` | picker `exif` payload (GPS + DateTimeOriginal) |
| `navigator.geolocation` | `expo-location` |
| `browser-image-compression` | `expo-image-manipulator` (resize 2048 / JPEG q0.85) |
| `MediaRecorder` (voice) | `expo-audio` (SDK 54; `expo-av` deprecated) |
| direct R2 `fetch PUT` | `expo-file-system` `uploadAsync` (PUT, Content-Type only) |
| `sessionStorage` CSRF/office | `expo-secure-store` session blob |

**iOS infoPlist:** `NSCameraUsageDescription`, `NSPhotoLibraryUsageDescription`, `NSPhotoLibraryAddUsageDescription`, `NSLocationWhenInUseUsageDescription`, `NSMicrophoneUsageDescription`, `ITSAppUsesNonExemptEncryption:false`.

---

## 7. Open questions / risks (verify during build)

1. **Bearer on all `/api/field/*`** — confirm `requireFieldContractor` accepts raw Bearer for every field route (not just `/me`). *(verify in middleware source)*
2. **`x-requested-with: XMLHttpRequest`** is the load-bearing field-CSRF gate — every write needs it or 403.
3. **24h JWT, no refresh** → detect 401, force re-login (acceptable for v1).
4. **Office switcher** — no list endpoint → default to primary office; multi-office out of scope v1.
5. **423 lockout** — distinct login message.
6. **HEIC/AVIF** — gallery imports may be HEIC on iOS; transcode to JPEG client-side (mirror web) for `confirm-upload` consistency. RN `<Image>` can't render AVIF without a lib.
7. **Raw audio upload from RN** — `transcribe-description` wants raw `audio/*` body + `x-file-name`; send via `FileSystem.uploadAsync` (raw), confirm content-type accepted.
8. **Public viewer scope** — decision Q below.
9. **`/api/auth/logout` Bearer support** — verify; fallback = local-only sign-out.
10. **Tag delete (#24)** — web uses full-replace (#23) only; mobile likely same.

---

## Decisions (RESOLVED 2026-06-11)
- **A. App location** → **`trockcrm/mobile/`, non-workspace.** New worktree off `main`; PR into trockcrm via the standard Codex+CodeRabbit gate. Own `node_modules` + metro `disableHierarchicalLookup` so EAS never resolves the repo's hoisted React.
- **B. Public viewer** → **omitted in v1.** True mirror of the field SPA (6 screens, the 29 endpoints). No `public/viewer` route; the public share stays web-only.
- **Auth** → Bearer + `expo-secure-store` + `x-requested-with: XMLHttpRequest` + `x-office-id` (verified in `middleware/field-auth.ts:34` and `auth/http-config.ts:30`).

---

## 🎫 SERVER-SIDE TICKET (separate lane — do NOT touch in the mobile lane)

**Title:** Public photo-viewer exposure policy doesn't match the "locked" decision
**File:** `server/src/modules/public-photo-tokens/service.ts` (`publicPhotoShape`, ~L226-289)
**Owner lane:** server/backend (NOT the mobile RED lane)

**Locked policy (per product):** public share keeps `name / property address / uploader`; **drops `GPS`, `geocoded address`, and `dealNumber`**; should be JPEG-only + EXIF-stripped.

**Current behavior (verified):** the public viewer **exposes** `dealNumber`, the per-photo **geocoded address**, and **rounded GPS (7 dp)**; serves **any** image MIME (`jpegOnly:false`); streams the **original binary with EXIF intact** (`exifStripped:false`, no R2 proxy/transcode).

**Gap to close (server work, out of mobile scope):**
1. Strip `dealNumber` from the public deal shape.
2. Drop per-photo `address` (geocoded) + `latitude`/`longitude` from `publicPhotoShape`.
3. Decide JPEG-only + EXIF-strip enforcement (R2 proxy/transcode or upload-time normalization) — bigger change; needs its own design.

**Mobile impact:** none in v1 (no public viewer shipped). If a mobile viewer is added later it must enforce the drop-list **client-side** until the server is fixed.
