import { defineConfig } from "@playwright/test";

const baseURL =
  process.env.PLAYWRIGHT_BASE_URL?.trim() ||
  process.env.BASE_URL?.trim() ||
  "https://frontend-production-bcab.up.railway.app";

export default defineConfig({
  testDir: "./tests/audit",
  timeout: 60_000,
  workers: 1,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: 2,
  reporter: "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
});
