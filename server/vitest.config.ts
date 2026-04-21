import path from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  resolve: {
    alias: {
      "@trock-crm/shared/schema": path.resolve(__dirname, "../shared/src/schema/index.ts"),
      "@trock-crm/shared/types": path.resolve(__dirname, "../shared/src/types/index.ts"),
      "@trock-crm/shared/utils": path.resolve(__dirname, "../shared/src/utils/normalize.ts"),
    },
  },
  test: {
    globals: false,
    environment: "node",
    include: ["tests/**/*.test.ts"],
  },
});
