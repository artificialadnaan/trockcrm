import { defineConfig, configDefaults } from "vitest/config";

// Pre-merge CI gate config for the shared workspace. `shared` had 11 colocated src/**/*.test.ts unit
// suites but NO test runner wired (no vitest config, no test script), so they compiled (typecheck)
// but never executed in CI (#747). vitest itself is provided by the hoisted root node_modules
// (server/client/client-field depend on it); the committed package-lock pins it deterministically
// for `npm ci`, so no extra devDependency is required here.
//
// QUARANTINE (#746): none — all shared suites pass. Add a path here (with a #746 checkbox) only if
// one starts failing and must be fixed in a follow-up. Do NOT `.skip`; quarantine + burn down.
const QUARANTINE: string[] = [];

export default defineConfig({
  test: {
    environment: "node",
    include: ["src/**/*.test.ts"],
    exclude: [...configDefaults.exclude, ...QUARANTINE],
  },
});
