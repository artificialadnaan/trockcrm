type EnvInput = {
  FRONTEND_URL?: string | undefined;
  RAILWAY_SERVICE_FRONTEND_URL?: string | undefined;
  NODE_ENV?: string | undefined;
  AZURE_CLIENT_ID?: string | undefined;
  DEV_MODE?: string | undefined;
};

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

export function getAllowedCorsOrigins(env: EnvInput): string[] {
  const origins = [
    normalizeOrigin(env.FRONTEND_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_FRONTEND_URL),
    "http://localhost:5173",
    "http://localhost:3000",
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  return origins;
}

export function isDevAuthEnabled(env: EnvInput, host: string | undefined): boolean {
  const normalizedHost = host?.trim().toLowerCase() ?? "";
  const isLocalDevEnv = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const hasAzureSso = Boolean(env.AZURE_CLIENT_ID?.trim());
  const explicitDevMode = env.DEV_MODE === "true";
  const isLocalhost =
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost.startsWith("localhost:");

  if (explicitDevMode) return true;
  if (hasAzureSso) return false;

  return isLocalDevEnv && isLocalhost;
}

export function getTokenCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    // "lax" instead of "none": frontend and API share the same domain in production,
    // so cross-site cookie sending is not required. "none" would also require Secure
    // on every environment, and opens the door to CSRF on cross-origin requests.
    sameSite: isProduction ? "lax" : "strict",
    maxAge: 24 * 60 * 60 * 1000,
  } as const;
}
