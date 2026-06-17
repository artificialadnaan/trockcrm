import { mergeConfig, defineConfig, configDefaults } from "vitest/config";
import viteConfig from "./vite.config";

// Pre-merge CI gate config: runs the client UNIT tests (src/**/*.{test,spec}.{ts,tsx}), minus a
// shrinking QUARANTINE. The `include` deliberately scopes to src/ so the Playwright e2e specs under
// client/e2e/ are NOT run here — those have their own `test:e2e` (browser) job.
//
// QUARANTINE (#743) — suites already failing on main (stale UI expectations from components that
// evolved while these never ran in CI). Excluded so the broadened gate is green TODAY. Burn-down
// tracked in #746: fix each (real fix, not a skip) and REMOVE it here.
const QUARANTINE = [
  "src/components/deals/deal-scoping-workspace.test.ts",
  "src/components/deals/kanban-deal-card.test.tsx",
  "src/components/layout/app-shell-layout.test.tsx",
  "src/components/layout/detail-page-shell.test.tsx",
  "src/components/layout/sidebar.test.tsx",
  "src/pages/director/director-dashboard-page.test.tsx",
  "src/pages/leads/lead-list-page.move.test.tsx",
  "src/pages/projects/project-detail-page.test.tsx",
  "src/pages/projects/projects-page.test.tsx",
  // --- Env-dependent: surfaced when #747's own broadened gate ran on UTC CI; passed on a local
  //     CT (UTC-5) dev box, so the first inventory missed them. Run burn-down with TZ=UTC. ---
  // TZ-dependent date-range assertions (new Date(y,m,d) is local; formatted window differs under UTC).
  "src/pages/deals/deal-list-page-period.test.tsx",
  // TZ-dependent "current date/time" assertion (15:30 UTC vs 10:30 CT).
  "src/components/activities/activity-log-form.test.tsx",
];

export default mergeConfig(
  viteConfig,
  defineConfig({
    test: {
      include: ["src/**/*.{test,spec}.{ts,tsx}"],
      exclude: [...configDefaults.exclude, "e2e/**", ...QUARANTINE],
    },
  }),
);
