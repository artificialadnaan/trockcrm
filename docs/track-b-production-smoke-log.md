# Track B Production Smoke Log

Date: 2026-05-04T20:42:06Z
Target: https://trockcrm.com
Branch: fix/security-dependency-hotfixes
Commit: 3b3d9ce

## Pre-flight

### `/api/health`

- Command: `curl -i https://trockcrm.com/api/health`
- Status: 200
- Body:

```json
{"status":"ok","timestamp":"2026-05-04T20:39:48.936Z"}
```

### `/api/auth/dev/users`

- Command: `curl -i https://trockcrm.com/api/auth/dev/users`
- Status: 200
- User count: 3
- Users returned: `admin@trock.dev`, `director@trock.dev`, `rep@trock.dev`

### Playwright

- Command: `npx playwright --version`
- Result: `Version 1.59.1`

## Spec modifications

Added an `afterAll` cleanup hook to `client/e2e/track-b-smoke.spec.ts` before the production run because the spec created `track-b-*@example.test` contacts but did not delete them.

The hook:

- Authenticates as `admin@trock.dev`.
- Searches `/api/contacts?search=track-b&limit=100`.
- Filters contacts matching `track-b-<timestamp>@example.test`.
- Deletes matching contacts through `DELETE /api/contacts/:id`.

Committed separately:

```text
3b3d9ce test(e2e): add cleanup hook for track-b-smoke production runs
```

## Test results

- Command: `PLAYWRIGHT_BASE_URL=https://trockcrm.com npx playwright test client/e2e/track-b-smoke.spec.ts --reporter=list`
- Exit code: 1
- Result: 5 passed, 1 failed

Full Playwright output:

```text
Running 6 tests using 1 worker

1 …94:1 › login flow uses local dev login and reaches the authenticated app
[track-b-smoke] cleanup deleted 0 smoke contact(s)
(node:88012) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
✘ 1 …login flow uses local dev login and reaches the authenticated app (2.8s)
2 …ke.spec.ts:100:1 › authenticated GET pages render without console errors
✓ 2 ….ts:100:1 › authenticated GET pages render without console errors (2.1s)
3 ….ts:117:1 › authenticated POST accepts the browser CSRF token round trip
✓ 3 …:1 › authenticated POST accepts the browser CSRF token round trip (1.0s)
4 …age write path is not rejected by CSRF when same-origin token is present
✓ 4 …e path is not rejected by CSRF when same-origin token is present (843ms)
5 …-smoke.spec.ts:154:1 › cross-origin cookie-authenticated POST is blocked
✓ 5 …pec.ts:154:1 › cross-origin cookie-authenticated POST is blocked (606ms)
6 …track-b-smoke.spec.ts:171:1 › navigation sweep records no console errors
[track-b-smoke] cleanup deleted 1 smoke contact(s)
(node:88081) Warning: The 'NO_COLOR' env is ignored due to the 'FORCE_COLOR' env being set.
✓ 6 …-smoke.spec.ts:171:1 › navigation sweep records no console errors (1.5s)

1) client/e2e/track-b-smoke.spec.ts:94:1 › login flow uses local dev login and reaches the authenticated app

Error: expect(received).toBeTruthy()

Received: false

  95 |   await loginAsAdmin(page);
  96 |   const me = await page.request.get("/api/auth/me");
> 97 |   expect(me.ok()).toBeTruthy();
     |                   ^
  98 | });

attachment #1: screenshot (image/png)
test-results/track-b-smoke-login-flow-u-33f58-aches-the-authenticated-app/test-failed-1.png

attachment #2: video (video/webm)
test-results/track-b-smoke-login-flow-u-33f58-aches-the-authenticated-app/video.webm

Error Context:
test-results/track-b-smoke-login-flow-u-33f58-aches-the-authenticated-app/error-context.md

1 failed
  client/e2e/track-b-smoke.spec.ts:94:1 › login flow uses local dev login and reaches the authenticated app
5 passed (11.0s)
```

## Cleanup

### Automatic cleanup during Playwright run

- First worker cleanup: 0 smoke contacts deleted.
- Second worker cleanup: 1 smoke contact deleted.

### Manual verification

- Command: `curl -i -b /tmp/track-b-prod-smoke.cookie 'https://trockcrm.com/api/contacts?search=track-b&limit=100'`
- Status: 200
- Body:

```json
{"contacts":[],"pagination":{"page":1,"limit":100,"total":0,"totalPages":0}}
```

Contacts created during run: 1
Contacts deleted: 1
Contacts remaining: 0

## Conclusion

Production smoke failed: 5 of 6 Track B tests passed, but `login flow uses local dev login and reaches the authenticated app` failed because `GET /api/auth/me` returned non-OK after the UI dev-login flow. Cleanup completed successfully and zero `track-b-*@example.test` contacts remain in production.

