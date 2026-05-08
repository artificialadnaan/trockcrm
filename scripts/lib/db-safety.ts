import pg from "pg";

export type DbTarget = {
  protocol: string;
  host: string;
  database: string;
  username: string;
  redactedUrl: string;
  isProductionLike: boolean;
};

const PRODUCTION_HOST_PATTERNS = [
  /railway/i,
  /rlwy\.net$/i,
  /proxy\.rlwy\.net$/i,
  /render\.com$/i,
  /amazonaws\.com$/i,
  /neon\.tech$/i,
  /supabase\.(co|com)$/i,
];

export function describeDatabaseUrl(databaseUrl: string): DbTarget {
  const parsed = new URL(databaseUrl);
  const redacted = new URL(databaseUrl);
  if (redacted.password) redacted.password = "****";
  return {
    protocol: parsed.protocol,
    host: parsed.host,
    database: parsed.pathname.replace(/^\//, ""),
    username: parsed.username,
    redactedUrl: redacted.toString(),
    isProductionLike: PRODUCTION_HOST_PATTERNS.some((pattern) => pattern.test(parsed.hostname)),
  };
}

export function printDbTarget(databaseUrl: string, label: string) {
  const target = describeDatabaseUrl(databaseUrl);
  console.log(
    `[${label}] database=${target.protocol}//${target.username}:****@${target.host}/${target.database} productionLike=${target.isProductionLike}`,
  );
  return target;
}

export function assertWriteAllowed(databaseUrl: string, argv: string[], label: string) {
  const target = printDbTarget(databaseUrl, label);
  if (target.isProductionLike && !argv.includes("--confirm-production")) {
    console.warn(
      `[${label}] production-like host detected (${target.host}); proceeding because this database is currently approved as a pre-production reset/import sandbox.`,
    );
  }
  return target;
}

export async function getTenantSchemas(client: pg.Client) {
  const result = await client.query<{ schema_name: string }>(
    `
      SELECT schema_name
      FROM information_schema.schemata
      WHERE schema_name LIKE 'office\\_%' ESCAPE '\\'
      ORDER BY schema_name
    `,
  );
  return result.rows.map((row) => row.schema_name);
}

export function assertSafeIdentifier(value: string, label: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(value)) {
    throw new Error(`Unsafe ${label}: ${value}`);
  }
  return value;
}
