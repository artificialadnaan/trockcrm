import dotenv from "dotenv";
dotenv.config();

import { createApp } from "./app.js";
import { configureR2Cors } from "./lib/r2-client.js";

const PORT = parseInt(process.env.PORT || "3001", 10);
const app = createApp();

app.listen(PORT, () => {
  console.log(`[API] T Rock CRM server running on port ${PORT}`);

  // Configure R2 CORS for browser uploads (idempotent, runs once on startup)
  const frontendUrl = process.env.FRONTEND_URL || "http://localhost:5173";
  configureR2Cors([frontendUrl, "http://localhost:5173", "http://localhost:3000"]);
});
