## Summary

Fixes the P0 file upload blocker for deal scoping documents and site photos by moving the shared client upload path back to direct-to-R2 presigned uploads.

## Root causes

### Small files: HTTP 403

The client was posting file bytes through `POST /api/files/upload-direct` with a custom raw `XMLHttpRequest`. That request included auth cookies but bypassed the shared `api()` helper, so it did not send the required `X-CSRF-Token` header. The global CSRF middleware rejected it with:

```json
{"error":{"message":"Invalid CSRF token"}}
```

### Larger files: HTTP 502 / upload failure

The same client path proxied the entire file through the API. That route has a local `express.raw({ limit: "50mb" })` limit and remains subject to Railway request timeouts and Cloudflare proxied upload limits. That architecture cannot support 150-200 MB construction files.

## Fix

- Changed shared `uploadFile()` to:
  1. `POST /api/files/upload-url`
  2. browser `PUT` directly to the returned R2 presigned URL
  3. `POST /api/files/confirm-upload`
- Kept auth/tenant checks on the presign and confirm API requests.
- Kept the direct R2 `PUT` credentialless.
- Raised explicit upload cap to 200 MB in client and server constants.
- Rejects files over 200 MB at presign time with HTTP 413 and `File exceeds 200 MB limit.`
- Raised presigned URL and pending upload token expiry to 30 minutes.
- Added upload progress on scoping intake uploads; existing file and photo upload UIs continue to receive progress from the same shared helper.

## R2 / proxy note

No global Express body limit was widened. The legacy `/api/files/upload-direct` route remains route-local at 50 MB, but the shared deal/scoping/photo upload path no longer uses it.

R2 bucket CORS already supports `PUT` with wildcard allowed headers. Production still needs `R2_ALLOWED_ORIGINS` / `FRONTEND_URL` to include the live app origins, especially `https://trockcrm.com`.

## Verification

- `npm run typecheck`
- `npx vitest run client/src/hooks/use-files.upload.test.ts client/src/components/deals/deal-scoping-workspace.test.ts server/src/modules/files/service.test.ts server/src/lib/r2-client.test.ts`
- Independent subagent review: no code-level blockers found.

Discovery details are saved in `.reviews/file-upload-fix/discovery.md`.
