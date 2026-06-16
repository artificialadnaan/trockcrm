import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@trock-crm/shared/schema": path.resolve(__dirname, "../shared/src/schema/index.ts"),
      "@trock-crm/shared/types": path.resolve(__dirname, "../shared/src/types/index.ts"),
      "@trock-crm/shared/utils": path.resolve(__dirname, "../shared/src/utils/normalize.ts"),
      "@trock-crm/shared/lib/bidBoardStatusMap": path.resolve(__dirname, "../shared/src/lib/bidBoardStatusMap.ts"),
      "@trock-crm/shared/lib/rfpReviewerEmails": path.resolve(__dirname, "../shared/src/lib/rfpReviewerEmails.ts"),
      "@trock-crm/shared/lib/userProvisioningGuards": path.resolve(__dirname, "../shared/src/lib/userProvisioningGuards.ts"),
      "@trock-crm/shared": path.resolve(__dirname, "../shared/src/schema/index.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
    maxWorkers: 4,
    minWorkers: 1,
    testTimeout: 15_000,
  },
});
