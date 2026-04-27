# Rep dashboard `myCleanup` null guard

## Problem
`AppShell layout > migrates the rep dashboard, deals, and contacts to PageHeader`
in `client/src/components/layout/app-shell-layout.test.tsx` fails with:

```
TypeError: Cannot read properties of undefined (reading 'total')
  at RepDashboardPage src/pages/dashboard/rep-dashboard-page.tsx:250:39
  const cleanupCount = data.myCleanup.total;
```

The test mocks `useRepDashboard` but the mock fixture omits the `myCleanup` field
that the component now reads. Verified pre-existing on `main` (independent of the
pipeline UI rebuild branch).

## Suggested fix
Decide which is canonical:

1. **Component should null-guard** — `data.myCleanup?.total ?? 0` and same for
   `data.myCleanup?.byReason ?? []`. Correct if the API can legitimately return
   no cleanup payload (e.g., for reps with zero pipeline).
2. **Mock should include `myCleanup`** — extend the test fixture in
   `app-shell-layout.test.tsx` with the canonical shape. Correct if the API
   contract guarantees the field.

Check the response shape returned by `GET /dashboard/rep` (server route) to
determine which side is wrong.

## Files affected
- `client/src/pages/dashboard/rep-dashboard-page.tsx` (component, lines ~250–255)
- `client/src/components/layout/app-shell-layout.test.tsx` (test mock, ~line 258)
- `client/src/hooks/use-dashboard.ts` (type definition for `myCleanup`)
- `server/routes/dashboard.ts` or equivalent (API contract source of truth)
