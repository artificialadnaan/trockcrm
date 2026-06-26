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
