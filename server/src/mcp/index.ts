import dotenv from "dotenv";
dotenv.config();

import { createMcpDemoApp } from "./app.js";
import { getAnthropicApiKey, getDemoPassword, getPublicBaseUrl } from "./gate/env.js";
import { getMcpSessionSecret } from "./auth/secret.js";

/**
 * Entry point for the T Rock AI demo service. Deployed as a SEPARATE Railway service from the
 * `server` workspace via the `start:ai-demo` script (`node dist/mcp/index.js`) — the CRM API
 * (dist/index.js) and this demo run the same build but different start commands.
 */
const PORT = parseInt(process.env.PORT || "3002", 10);

// Fail fast at boot, not on the first request: these throw if DEMO_PASSWORD / MCP_SESSION_SECRET
// are missing outside dev, or if MCP_SESSION_SECRET reuses JWT_SECRET. Surfacing it here keeps the
// failure immediate and traceable to startup.
getDemoPassword();
getMcpSessionSecret();

// This service SHIPS the chat UI, so outside local dev also require the chat connector config —
// otherwise a deploy can go green (health passes) while every /api/ai-chat returns 503. Skipped in
// dev/test so the gate + MCP + static shell can be booted locally without an Anthropic key.
const isLocalDevEnv = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
if (!isLocalDevEnv) {
  getPublicBaseUrl();
  getAnthropicApiKey();
}

const app = createMcpDemoApp();

app.listen(PORT, () => {
  console.log(`[AI-DEMO] T Rock AI demo server running on port ${PORT}`);
});
