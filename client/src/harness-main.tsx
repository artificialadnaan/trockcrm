import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { MobileUiHarness } from "@/components/__harness__/mobile-ui-harness";
import "./globals.css";

// Standalone dev-only preview entry. This is NOT a route in the authenticated SPA
// and is NOT part of the production bundle (index.html is the sole `vite build`
// entry). It renders presentational components with mock data only — no
// AuthProvider, no AuthGate, no API client, no session. There is deliberately no
// skip-login path: this entry never touches auth because it never renders real,
// authenticated data. Served by `vite` dev at /harness.html for screenshots.
createRoot(document.getElementById("harness-root")!).render(
  <StrictMode>
    <MemoryRouter>
      <MobileUiHarness />
    </MemoryRouter>
  </StrictMode>,
);
