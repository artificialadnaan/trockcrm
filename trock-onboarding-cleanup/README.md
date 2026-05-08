# T Rock Onboarding Cleanup

Temporary lean-MVP service for HubSpot migration cleanup before T Rock reps enter the main CRM.

This service is intentionally separate from the production CRM. It shares the CRM database and auth token validation, but owns only migration cleanup workflows.

## Current Checkpoint

- Scaffold only.
- Migration SQL lives in `migrations/20260507_cleanup_onboarding_support.sql`.
- Do not deploy or run full imports until the pre-flight check passes.

## Scripts

- `npm run dev` - run API and Vite client locally.
- `npm run migrate` - apply cleanup migration to `DATABASE_URL`.
- `npm run preflight` - verify stage slugs, deterministic user IDs, cleanup schema, and seed dry-run.

