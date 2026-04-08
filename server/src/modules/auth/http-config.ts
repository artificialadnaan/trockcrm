type EnvInput = {
  FRONTEND_URL?: string | undefined;
  RAILWAY_SERVICE_FRONTEND_URL?: string | undefined;
  NODE_ENV?: string | undefined;
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

export function getTokenCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "strict",
    maxAge: 24 * 60 * 60 * 1000,
  } as const;
}
