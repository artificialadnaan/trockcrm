import path from "path";
import dotenv from "dotenv";
// `npm run start:ai-demo -w @trock-crm/server` runs with PWD in server/ but INIT_CWD at the repo
// root, where the .env actually lives. Resolve from INIT_CWD (like the connectivity check) so a
// repo-root .env is honored and the service isn't reported unconfigured when the vars are present.
dotenv.config({ path: path.resolve(process.env.INIT_CWD ?? process.cwd(), ".env") });

/**
 * Entry point for the T Rock AI demo service. Deployed as a SEPARATE Railway service from the
 * `server` workspace via the `start:ai-demo` script (`node dist/mcp/index.js`) — the CRM API
 * (dist/index.js) and this demo run the same build but different start commands.
 */
async function main(): Promise<void> {
  // Import env consumers AFTER dotenv.config() has run. ESM evaluates ALL static imports before the
  // module body, so a static import of ./app.js — which transitively constructs the Postgres pool in
  // db.ts and reads AI_CHAT_MODEL in anthropic-stream.ts at module-load time — would capture the
  // PRE-.env environment. Dynamic import here guarantees those load-time reads see the loaded .env.
  const { createMcpDemoApp } = await import("./app.js");
  const { getAnthropicApiKey, getDemoPassword, getPublicBaseUrl } = await import("./gate/env.js");
  const { getMcpSessionSecret } = await import("./auth/secret.js");

  const PORT = parseInt(process.env.PORT || "3002", 10);

  // Fail fast at boot, not on the first request: these throw if DEMO_PASSWORD / MCP_SESSION_SECRET
  // are missing outside dev, or if MCP_SESSION_SECRET reuses JWT_SECRET. Surfacing it here keeps the
  // failure immediate and traceable to startup.
  getDemoPassword();
  getMcpSessionSecret();

  // This service SHIPS the chat UI and depends on Postgres, so outside local dev also require the
  // chat connector config AND the database — otherwise a deploy can go green (health passes) while
  // every /api/ai-chat returns 503 or every tool call fails on pool.connect(). Skipped in dev/test
  // so the gate + MCP + static shell can be booted locally without an Anthropic key / database.
  const isLocalDevEnv = process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (!isLocalDevEnv) {
    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL must be set outside local development/test");
    }
    getPublicBaseUrl();
    getAnthropicApiKey();
  }

  const app = createMcpDemoApp();
  app.listen(PORT, () => {
    console.log(`[AI-DEMO] T Rock AI demo server running on port ${PORT}`);
  });
}

main().catch((err) => {
  console.error(`[AI-DEMO] startup failed: ${err instanceof Error ? err.message : String(err)}`);
  process.exit(1);
});
