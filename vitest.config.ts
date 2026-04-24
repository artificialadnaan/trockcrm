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
    },
  },
});
