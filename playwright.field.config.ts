import { defineConfig } from "@playwright/test";

const baseURL = process.env.FIELD_PLAYWRIGHT_BASE_URL?.trim() || "http://127.0.0.1:4174";

export default defineConfig({
  testDir: "./client-field/e2e",
  timeout: 60_000,
  expect: {
    timeout: 10_000,
  },
  fullyParallel: false,
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  webServer: process.env.FIELD_PLAYWRIGHT_BASE_URL
    ? undefined
    : {
        command: "VITE_API_BASE_URL=http://mock-api.test npm run dev --workspace=client-field -- --host 127.0.0.1 --port 4174",
        url: baseURL,
        reuseExistingServer: !process.env.CI,
        timeout: 120_000,
      },
});
