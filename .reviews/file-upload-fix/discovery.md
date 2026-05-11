# File Upload 403/502 Discovery

Date: 2026-05-11
Branch: `fix/file-upload-403-and-502-size-limits`
Worktree: `/Users/adnaaniqbal/projects/trockcrm-file-upload-fix`

## Executive finding

Both failures were in the canonical deal file subsystem used by deal documents, scoping attachments, site photos, and field photo capture.

- 403 root cause: the client uploaded small files through a custom raw `XMLHttpRequest` to `POST /api/files/upload-direct`; that request included auth cookies but did not send the required `X-CSRF-Token`, so the global CSRF middleware returned `403 {"error":{"message":"Invalid CSRF token"}}`.
- 502 / large-file root cause: the client was proxying file bytes through the API route `POST /api/files/upload-direct`, which has `express.raw({ limit: "50mb" })` and also stays behind Cloudflare/Railway request-size and timeout limits. This cannot support 150-200 MB construction files.
- Architecture decision: use the existing direct-to-R2 presigned flow: `POST /api/files/upload-url` -> browser `PUT` directly to R2 -> `POST /api/files/confirm-upload`.

## Upload endpoints

### `POST /api/files/upload-url`

- Route file: `server/src/modules/files/routes.ts`
- Route lines: `server/src/modules/files/routes.ts:67`
- Purpose: presign/direct-to-R2 step 1.
- Middleware chain: global `helmet`, CORS, cookie parser, CSRF for unsafe cookie-auth requests, JSON parser, `authMiddleware`, `tenantMiddleware`, tenant `apiLimiter`, `requireCrmUser`, then `fileRoutes`.
- Sales allowed: yes, through `requireCrmUser`; no admin-only middleware on this route.
- Tenant isolation: yes, mounted under `app.use("/api", authMiddleware, tenantMiddleware, tenantRouter)`.
- Stage gate: none at upload time.
- Ownership/access checks: if `dealId` is present, route calls `getDealById(req.tenantDb!, dealId, req.user!.role, req.user!.id)` and denies inaccessible deals. Same pattern for `leadId`.
- Size validation: `requestUploadUrl()` validates file size before issuing a presign.

### `POST /api/files/confirm-upload`

- Route file: `server/src/modules/files/routes.ts`
- Route lines: `server/src/modules/files/routes.ts:213`
- Purpose: direct-to-R2 step 2, records metadata after R2 object exists.
- Middleware chain: same tenant-scoped file route chain as above.
- Sales allowed: yes, through `requireCrmUser`; no admin-only middleware.
- Tenant isolation: yes.
- Stage gate: none at confirm time.
- Ownership/access checks: confirm consumes server-side pending upload metadata by token and verifies R2 object `HEAD` before DB insert.

### `POST /api/files/upload-direct`

- Route file: `server/src/modules/files/routes.ts`
- Route lines: `server/src/modules/files/routes.ts:130`
- Purpose: legacy server-side proxy upload.
- Middleware chain: same as file routes, except app JSON parser skips this exact path and the route uses `express.raw({ type: "*/*", limit: "50mb" })`.
- Sales allowed: yes, through `requireCrmUser`; no admin-only middleware.
- Tenant isolation: yes.
- Stage gate: none.
- Ownership/access checks: same `getDealById` / `getLeadById` access checks before creating file metadata.
- Problem: this route receives the entire file body through the API and is limited to 50 MB before any R2 write.

### `POST /api/deals/:id/scoping-intake/attachments/link-existing`

- Route file: `server/src/modules/deals/routes.ts`
- Route lines: `server/src/modules/deals/routes.ts:757`
- Purpose: links an already-uploaded deal file into a scoping requirement.
- Middleware chain: deal routes are tenant scoped through `authMiddleware`, `tenantMiddleware`, tenant `apiLimiter`, `requireCrmUser`.
- Sales allowed: yes, route has no admin-only middleware.
- Tenant isolation: yes.
- Stage gate: no upload-stage gate here; it validates the file belongs to the same deal in service code.
- Ownership checks: `linkDealFileToScopingRequirement()` checks same-deal file linkage before applying scoping metadata.

## Client upload flow

- `client/src/hooks/use-files.ts` is the shared upload helper used by `FileUploadZone` and photo capture.
- `client/src/components/files/file-upload-zone.tsx` handles deal/scoping document uploads through `uploadFile()`.
- `client/src/pages/photos/photo-capture-page.tsx` handles site/field photo capture through `uploadFile()`.
- Before this fix, `uploadFile()` sent the file body to `/api/files/upload-direct` with custom XHR headers.
- After this fix, `uploadFile()` requests `/api/files/upload-url`, uploads with `PUT` to the returned R2 URL, then calls `/api/files/confirm-upload`.
- Deal scoping uploads now pass the shared upload progress callback and render `Uploading N%` on the upload control during the R2 PUT. FileUploadZone and photo capture already had progress bars driven by the same callback.

## 403 repro

Repro command used locally against `createApp()` with production origin allowed:

```bash
node --import tsx -e "import http from 'node:http'; import request from 'supertest'; process.env.CORS_ALLOWED_ORIGINS='https://trockcrm.com'; import { createApp } from './server/src/app.ts'; const server=http.createServer(createApp()); await new Promise((resolve,reject)=>{server.once('error',reject); server.listen(0,'127.0.0.1',resolve);}); try { const res=await request(server).post('/api/files/upload-direct').set('Origin','https://trockcrm.com').set('Cookie',['token=fake','csrf_token=test-csrf']).set('Content-Type','image/png').set('X-Original-Filename',encodeURIComponent('small.png')).set('X-File-Category','photo').send(Buffer.from('x')); console.log(JSON.stringify({status:res.status,body:res.body},null,2)); } finally { server.close(); }"
```

Exact response:

```json
{
  "status": 403,
  "body": {
    "error": {
      "message": "Invalid CSRF token"
    }
  }
}
```

Blocking middleware: global CSRF middleware in `server/src/app.ts`, which checks cookie-auth unsafe methods and requires the `X-CSRF-Token` header to match the `csrf_token` cookie.

403 category: browser/request-level CSRF header issue. Closest provided category is `(e) browser-level`; it is not RBAC, stage gate, ownership, tenant, R2 PUT, or CSP.

## 502 / size root cause

- Global Express JSON limit is `10mb`, but `/api/files/upload-direct` skips JSON and uses route-local `express.raw({ type: "*/*", limit: "50mb" })`.
- There is no `multer` upload path for these deal files.
- No `railway.json`, `railway.toml`, or `Procfile` exists in the repo root.
- Cloudflare proxied upload requests over 100 MB cannot be made reliable in code. API-proxied uploads also remain exposed to Railway request timeout behavior.
- Because the pre-fix client posted the entire file to `/api/files/upload-direct`, large files were subject to all API/proxy limits before reaching R2.

502 category: `(l) combination` of route-local raw body limit plus API-proxied architecture exposed to Railway timeout and Cloudflare hard upload limits. Direct-to-R2 is required for 150-200 MB files.

## Implementation notes

- Kept the global Express JSON limit at `10mb`.
- Did not widen the proxy upload route beyond its existing `50mb`; the client no longer uses it for normal uploads.
- Raised explicit file cap to 200 MB in server and client constants.
- Changed server oversize rejection to HTTP 413 with clear message: `File exceeds 200 MB limit.`
- Raised presigned URL expiry to 30 minutes.
- R2 bucket CORS code already allows `PUT` with `AllowedHeaders: ["*"]` and includes configured origins through `R2_ALLOWED_ORIGINS` / `FRONTEND_URL` fallback.

## Tests added

- `client/src/hooks/use-files.upload.test.ts`
  - verifies presign -> direct R2 `PUT` -> confirm, with CSRF on API calls and no credentials on the R2 PUT.
  - verifies files over 200 MB are rejected before presign.
- `server/src/modules/files/service.test.ts`
  - verifies files over 200 MB are rejected at presign time with 413.
- `server/src/lib/r2-client.test.ts`
  - verifies presign expiry is 30 minutes.
