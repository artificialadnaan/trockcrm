import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import base from "./vitest.config";

// Pre-merge CI gate config: runs ALL unit tests (tests/**/*.test.ts, per the base `include`), minus a
// shrinking QUARANTINE of pre-existing failing suites. This broadens the gate from the old
// runtime-only filter (~97 files) so the ~700 passing suites now run in CI and new breakage is caught.
//
// QUARANTINE (#743) — suites that already fail on main (stale SQL-string/mock/spy expectations from
// code that evolved while these never ran in CI). Excluded so the broadened gate is green TODAY.
// Burn-down tracked in #746: fix each (real fix, not a skip) and REMOVE it here. The gate gets
// monotonically stricter. Do NOT add entries without a #746 checkbox.
const QUARANTINE = [
  "tests/app-password-change-cookie.test.ts",
  "tests/field-route-policy.test.ts",
  "tests/modules/commissions/reporting.test.ts",
  "tests/modules/dashboard/at-risk-summary.test.ts",
  "tests/modules/dashboard/routes.test.ts",
  "tests/modules/dashboard/won-close-hs-date.test.ts",
  "tests/modules/deals/board-service.test.ts",
  "tests/modules/deals/pipeline-team-scope.test.ts",
  "tests/modules/deals/scoping-routes.test.ts",
  "tests/modules/deals/stage-page-service.test.ts",
  "tests/modules/email/routes.test.ts",
  "tests/modules/files/address-routes.test.ts",
  "tests/modules/files/audit-routes.test.ts",
  "tests/modules/files/photo-schema-foundation.test.ts",
  "tests/modules/leads/conversion-service.test.ts",
  "tests/modules/leads/reassignment.test.ts",
  "tests/modules/migration/hubspot-extra-properties-deals-migration.test.ts",
  "tests/modules/ownership/owner-display-data-source.test.ts",
  "tests/modules/properties/properties-engagement-list-detail-consistency.test.ts",
  "tests/modules/properties/properties-linked-value-consistency.test.ts",
  "tests/modules/sales-review/service.test.ts",
  "tests/scripts/project-number-notification-skip.test.ts",
  // --- Env-dependent: surfaced when #747's own broadened gate ran on Linux/UTC CI; passed on a
  //     local macOS/CT dev box, so the first inventory missed them. Verify burn-down under CI conditions. ---
  // backfill script hardcodes "/private/tmp" (macOS-only) -> ENOENT on Linux CI. Fix: path.join(os.tmpdir(), ...).
  "tests/scripts/backfill-procore-bid-board-ids.test.ts",
  // --- Colocated server/src/** suites, now visible after adding src/** to `include` (#747). ---
  // stale source-text assertion: greps the lead service source for 'nextAssignedRepId: input.assignedRepId',
  // which the code no longer contains. Fix: assert behavior, not source text.
  "src/modules/leads/assignment-task-source.test.ts",
];

export default mergeConfig(
  base,
  defineConfig({
    test: {
      // Base `include` is only tests/**; the gate must also run the colocated server/src/**/*.test.ts
      // unit suites (r2-client, projects/service, reports, etc.) that were otherwise invisible (#747).
      include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
      exclude: [...configDefaults.exclude, ...QUARANTINE],
    },
  }),
);
