import path from "node:path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: false,
    environment: "node",
  },
  resolve: {
    alias: {
      "@trock-crm/shared/types": path.resolve(__dirname, "./shared/src/types/index.ts"),
    },
  },
});
