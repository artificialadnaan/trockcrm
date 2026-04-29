# CRM Test Data Marker

Synthetic CRM records seeded for `admin@trock.dev`, `director@trock.dev`, and `rep@trock.dev` are marked two ways:

1. `is_test_data = true` on tenant records in these tables:
   - `companies`
   - `contacts`
   - `properties`
   - `leads`
   - `deals`
   - `tasks`
2. Human-readable text starts with `[TEST DATA]` in `description`, `notes`, `title`, or seeded test names where applicable.

Reports should exclude records where `is_test_data = true`. Dashboards and user work queues may show them so test users have realistic data.

Cleanup command:

```bash
node --import tsx scripts/cleanupTestData.ts        # dry-run, default
node --import tsx scripts/cleanupTestData.ts --apply # permanent delete of marked synthetic records
```

Cleanup is intentionally permanent because the records are synthetic. The script only targets rows explicitly marked with `is_test_data = true` or the `[TEST DATA]` prefix.
