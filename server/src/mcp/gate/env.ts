/**
 * Demo page-gate password loader.
 *
 * The T Rock AI demo is protected by a single shared password (env DEMO_PASSWORD). This is the
 * ENTIRE access gate — there is no role model. Mirrors the MCP secret loader: hard-fails outside
 * local development/test if unset, dev placeholder locally.
 */
export function getDemoPassword(): string {
  const password = process.env.DEMO_PASSWORD;
  const nodeEnv = process.env.NODE_ENV;
  const isLocalDevEnv = nodeEnv === "development" || nodeEnv === "test";
  if (!password && !isLocalDevEnv) {
    throw new Error("DEMO_PASSWORD must be set outside local development/test");
  }
  return password || "dev-demo-password";
}

/** Anthropic Messages API key for the /api/ai-chat connector. Throws if unset (no dev fallback). */
export function getAnthropicApiKey(): string {
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) throw new Error("ANTHROPIC_API_KEY is not set");
  return key;
}

/** This service's own public https origin, used to build the MCP connector URL handed to Anthropic. */
export function getPublicBaseUrl(): string {
  const url = process.env.PUBLIC_BASE_URL;
  if (!url) throw new Error("PUBLIC_BASE_URL is not set");
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("PUBLIC_BASE_URL must be a valid URL");
  }
  const isLocal = parsed.hostname === "localhost" || parsed.hostname === "127.0.0.1";
  if (parsed.protocol !== "https:" && !isLocal) {
    // Anthropic's connector requires https; allow http only for local dev.
    throw new Error("PUBLIC_BASE_URL must be an https origin");
  }
  return `${parsed.protocol}//${parsed.host}`;
}
