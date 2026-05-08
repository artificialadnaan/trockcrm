import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  root: "client",
  plugins: [react()],
  server: {
    port: 5175,
    proxy: {
      "/api": "http://localhost:3025",
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
});
