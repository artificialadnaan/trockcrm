import crypto from "crypto";

type EnvInput = {
  CORS_ALLOWED_ORIGINS?: string | undefined;
  FRONTEND_URL?: string | undefined;
  FIELD_APP_URL?: string | undefined;
  FIELD_FRONTEND_URL?: string | undefined;
  RAILWAY_SERVICE_FIELD_FRONTEND_URL?: string | undefined;
  RAILWAY_PUBLIC_DOMAIN?: string | undefined;
  RAILWAY_STATIC_URL?: string | undefined;
  RAILWAY_SERVICE_FRONTEND_URL?: string | undefined;
  NODE_ENV?: string | undefined;
  AZURE_CLIENT_ID?: string | undefined;
  DEV_MODE?: string | undefined;
  ALLOW_DEV_AUTH_IN_PROD?: string | undefined;
};

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const FIELD_CSRF_HEADER_NAME = "x-requested-with";
export const FIELD_CSRF_HEADER_VALUE = "XMLHttpRequest";

function normalizeOrigin(value: string | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

export function getAllowedCorsOrigins(env: EnvInput): string[] {
  const origins = [
    ...((env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(normalizeOrigin)),
    normalizeOrigin(env.FRONTEND_URL),
    normalizeOrigin(env.FIELD_APP_URL),
    normalizeOrigin(env.FIELD_FRONTEND_URL),
    normalizeOrigin(env.RAILWAY_PUBLIC_DOMAIN),
    normalizeOrigin(env.RAILWAY_STATIC_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_FRONTEND_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_FIELD_FRONTEND_URL),
    "http://localhost:5173",
    "http://localhost:5174",
    "http://localhost:3000",
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  return origins;
}

export function getFieldAppUrl(env: EnvInput): string {
  const configured = normalizeOrigin(env.FIELD_APP_URL);
  if (configured) return configured;
  if (env.NODE_ENV === "production") {
    throw new Error("FIELD_APP_URL is required when NODE_ENV=production");
  }
  return "http://localhost:5174";
}

function normalizeHost(host: string | undefined): string {
  const normalized = host?.trim().toLowerCase() ?? "";
  if (normalized.startsWith("[::1]")) return "::1";
  return normalized.split(":")[0] ?? "";
}

function isLocalOrTestHost(host: string | undefined): boolean {
  const normalizedHost = normalizeHost(host);
  return (
    normalizedHost === "localhost" ||
    normalizedHost === "127.0.0.1" ||
    normalizedHost === "::1" ||
    normalizedHost === "test" ||
    normalizedHost.endsWith(".test")
  );
}

export function assertSafeDevAuthConfig(env: EnvInput): void {
  if (
    env.NODE_ENV === "production" &&
    env.DEV_MODE === "true" &&
    !isDevAuthProductionOverrideEnabled(env)
  ) {
    throw new Error("Unsafe auth configuration: DEV_MODE=true is not allowed when NODE_ENV=production");
  }
  getFieldAppUrl(env);
}

export function isDevAuthProductionOverrideEnabled(env: EnvInput): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.DEV_MODE === "true" &&
    env.ALLOW_DEV_AUTH_IN_PROD === "true"
  );
}

export function isDevAuthEnabled(env: EnvInput, host: string | undefined): boolean {
  const isLocalDevEnv = env.NODE_ENV === "development" || env.NODE_ENV === "test";
  const hasAzureSso = Boolean(env.AZURE_CLIENT_ID?.trim());
  const explicitDevMode = env.DEV_MODE === "true";
  const isLocalhost = isLocalOrTestHost(host);

  if (isDevAuthProductionOverrideEnabled(env)) return true;
  if (explicitDevMode) return isLocalDevEnv && isLocalhost;
  if (hasAzureSso) return false;

  return isLocalDevEnv && isLocalhost;
}

export function getTokenCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";

  return {
    httpOnly: true,
    secure: isProduction,
    // Production runs the frontend and API on separate origins, so auth cookies must be
    // sent on cross-site fetch requests from the frontend app to the API service.
    sameSite: isProduction ? "none" : "strict",
    maxAge: 24 * 60 * 60 * 1000,
  } as const;
}

export function getCsrfCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";

  return {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "none" : "strict",
    maxAge: 24 * 60 * 60 * 1000,
  } as const;
}

export function createCsrfToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export function isUnsafeHttpMethod(method: string): boolean {
  return ["POST", "PUT", "PATCH", "DELETE"].includes(method.toUpperCase());
}

export function isFieldApiPath(path: string): boolean {
  return path === "/api/field" || path.startsWith("/api/field/");
}

export function isValidFieldCsrfHeader(value: string | undefined): boolean {
  return value === FIELD_CSRF_HEADER_VALUE;
}

export function isPublicAuthCsrfExempt(input: {
  method: string;
  path: string;
  host?: string | undefined;
  env: EnvInput;
}): boolean {
  if (input.method.toUpperCase() !== "POST") return false;

  if (
    input.path === "/api/auth/accept-invite" ||
    input.path === "/api/auth/field-login" ||
    input.path === "/api/auth/local/login"
  ) {
    return true;
  }

  return input.path === "/api/auth/dev/login" && isDevAuthEnabled(input.env, input.host);
}

export function getRequestOrigin(headers: {
  origin?: string | string[] | undefined;
  referer?: string | string[] | undefined;
  referrer?: string | string[] | undefined;
}): string | null {
  const origin = Array.isArray(headers.origin) ? headers.origin[0] : headers.origin;
  const refererHeader = headers.referer ?? headers.referrer;
  const referer = Array.isArray(refererHeader) ? refererHeader[0] : refererHeader;
  const normalizedOrigin = normalizeOrigin(origin);
  if (normalizedOrigin) return normalizedOrigin;
  if (!referer) return null;

  try {
    const parsed = new URL(referer);
    return `${parsed.protocol}//${parsed.host}`;
  } catch {
    return null;
  }
}

export function isAllowedCookieAuthOrigin(env: EnvInput, origin: string | null): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return getAllowedCorsOrigins(env).includes(normalized);
}

export function isValidCsrfPair(cookieToken: string | undefined, headerToken: string | undefined): boolean {
  if (!cookieToken || !headerToken) return false;
  return safeEqual(cookieToken, headerToken);
}
