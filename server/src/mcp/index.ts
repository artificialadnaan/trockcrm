import dotenv from "dotenv";
dotenv.config();

import { createMcpDemoApp } from "./app.js";

/**
 * Entry point for the T Rock AI demo service. Deployed as a SEPARATE Railway service from the
 * `server` workspace via the `start:ai-demo` script (`node dist/mcp/index.js`) — the CRM API
 * (dist/index.js) and this demo run the same build but different start commands.
 */
const PORT = parseInt(process.env.PORT || "3002", 10);
const app = createMcpDemoApp();

app.listen(PORT, () => {
  console.log(`[AI-DEMO] T Rock AI demo server running on port ${PORT}`);
});
