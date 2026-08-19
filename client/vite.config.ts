import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import path from "path";

export default defineConfig({
  plugins: [react()],
  envPrefix: ["VITE_", "PROPOSAL_"],
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
      "@trock-crm/shared/types": path.resolve(__dirname, "../shared/src/types/index.ts"),
      // Each `shared/lib/*` subpath the client imports needs its own entry: the bare package name is not
      // aliased, so an unaliased subpath resolves through node_modules to `shared/dist`, which is only as
      // fresh as the last build. Vitest inherits this config, so a missing entry fails the suite too.
      "@trock-crm/shared/lib/weeklyReportEmail": path.resolve(
        __dirname,
        "../shared/src/lib/weeklyReportEmail.ts",
      ),
    },
  },
  server: {
    port: 5173,
    proxy: {
      "/api": {
        target: "http://localhost:3001",
        changeOrigin: true,
      },
    },
  },
});
