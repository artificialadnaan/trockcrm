/// <reference types="vitest" />
import react from "@vitejs/plugin-react";
import { resolve } from "path";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      "@": resolve(__dirname, "./src"),
      "@trock-crm/shared/types": resolve(__dirname, "../shared/src/types/index.ts"),
    },
  },
  envPrefix: ["VITE_"],
  server: {
    port: 5174,
    proxy: {
      "/api": {
        target: process.env.VITE_API_BASE_URL ?? process.env.VITE_API_URL ?? "http://localhost:3001",
        changeOrigin: true,
      },
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
