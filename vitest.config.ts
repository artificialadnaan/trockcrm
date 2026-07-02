import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./client/src"),
      "@trock-crm/shared/types": path.resolve(__dirname, "./shared/src/types/index.ts"),
      "@trock-crm/shared/lib/bidBoardStatusMap": path.resolve(__dirname, "./shared/src/lib/bidBoardStatusMap.ts"),
      "@trock-crm/shared/lib/rfpReviewerEmails": path.resolve(__dirname, "./shared/src/lib/rfpReviewerEmails.ts"),
      "@trock-crm/shared/lib/fieldScorecardEmails": path.resolve(__dirname, "./shared/src/lib/fieldScorecardEmails.ts"),
    },
  },
});
