import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { ListDetailHarness } from "@/components/__harness__/list-detail-harness";
import "./globals.css";

// Standalone dev-only preview entry for the list+detail mobile pass. NOT a route in
// the authenticated SPA and NOT part of the production bundle (index.html is the sole
// `vite build` entry). Renders presentational components with mock data only — no
// AuthProvider, no AuthGate, no API client, no session. There is deliberately no
// skip-login path. Served by `vite` dev at /harness-list-detail.html for screenshots.
createRoot(document.getElementById("harness-root")!).render(
  <StrictMode>
    <MemoryRouter>
      <ListDetailHarness />
    </MemoryRouter>
  </StrictMode>,
);
