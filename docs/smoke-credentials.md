# Smoke Test Credentials

These are test-only accounts for the T Rock CRM smoke office. They are not customer credentials and must not be copied into CI fixtures or production data seed tests.

| Account | Role | Password |
|---|---|---|
| `test-sales@trock.test` | rep | `TrockTest123!` |
| `test-admin@trock.test` | admin | `dev123!` |
| `test-director@trock.test` | director | `TrockTest123!` |

Operational notes:

- The rep account is the cleanup-gate smoke user and should have the six `SMOKE TEST DELETE` cleanup assignments pending before gate verification.
- Admin and director bypass the cleanup gate by role.
- Do not add these literal passwords to automated tests that run against production.
