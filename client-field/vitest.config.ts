import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@trock-crm/shared/types": resolve(__dirname, "../shared/src/types/index.ts"),
    },
  },
  test: {
    exclude: ["e2e/**", "node_modules/**", "dist/**"],
    coverage: {
      exclude: [
        "e2e/**",
        "dist/**",
        "node_modules/**",
        "src/main.tsx",
        "*.config.*",
        "postcss.config.js",
      ],
    },
  },
});
