/**
 * Resolve the Postgres connection URL + SSL flag for an operator script.
 *
 * Prefers the PUBLIC/external URL so the documented `railway run --service=Postgres`
 * workflow works from a local machine: `railway run` executes locally with service
 * variables injected, and a Postgres service's internal `DATABASE_URL`
 * (`*.railway.internal`) only resolves inside Railway's network — a local client
 * must use the public TCP proxy URL. Falls back to the internal URL last (for runs
 * that genuinely execute inside Railway). SSL is enabled for everything except an
 * internal host. Mirrors the precedence used by the other operational scripts
 * (e.g. backfill-deal-regions.ts).
 */
export function resolveScriptDatabaseUrl(env: NodeJS.ProcessEnv = process.env): {
  url: string;
  ssl: boolean;
} {
  const url =
    env.CRM_DATABASE_URL?.trim() ||
    env.DATABASE_PUBLIC_URL?.trim() ||
    env.DATABASE_URL?.trim() ||
    "";
  if (!url) {
    throw new Error(
      "Missing database URL. Run via: railway run --service=Postgres npx tsx scripts/<script>.ts",
    );
  }
  const isInternal = /\.railway\.internal(?::\d+)?(?:\/|$|\?)/.test(url);
  return { url, ssl: !isInternal };
}
