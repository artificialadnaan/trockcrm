import crypto from "crypto";

type EnvInput = {
  AUTH_COOKIE_DOMAIN?: string | undefined;
  CORS_ALLOWED_ORIGINS?: string | undefined;
  STRICT_CROSS_SITE_AUTH_ORIGINS?: string | undefined;
  FRONTEND_URL?: string | undefined;
  FIELD_APP_URL?: string | undefined;
  FIELD_FRONTEND_URL?: string | undefined;
  RAILWAY_SERVICE_FIELD_FRONTEND_URL?: string | undefined;
  RAILWAY_SERVICE_TROCKCRM_FIELD_URL?: string | undefined;
  RAILWAY_PUBLIC_DOMAIN?: string | undefined;
  RAILWAY_STATIC_URL?: string | undefined;
  RAILWAY_SERVICE_FRONTEND_URL?: string | undefined;
  NODE_ENV?: string | undefined;
  AZURE_CLIENT_ID?: string | undefined;
  DEV_MODE?: string | undefined;
  ALLOW_DEV_AUTH_IN_PROD?: string | undefined;
  I_UNDERSTAND_DEV_AUTH_IN_PROD?: string | undefined;
};

type CookieRequestInput = {
  host?: string | undefined;
  hostname?: string | undefined;
  origin?: string | string[] | undefined;
};

export const CSRF_COOKIE_NAME = "csrf_token";
export const CSRF_HEADER_NAME = "x-csrf-token";
export const FIELD_CSRF_HEADER_NAME = "x-requested-with";
export const FIELD_CSRF_HEADER_VALUE = "XMLHttpRequest";

function normalizeOrigin(value: string | null | undefined): string | null {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^https?:\/\//i.test(trimmed)) return trimmed.replace(/\/+$/, "");
  return `https://${trimmed.replace(/\/+$/, "")}`;
}

function normalizeCookieDomain(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

function sharedAuthCookieDomain(env: EnvInput): string | undefined {
  return normalizeCookieDomain(env.AUTH_COOKIE_DOMAIN) ?? (env.NODE_ENV === "production" ? ".trockcrm.com" : undefined);
}

function requestHost(input: CookieRequestInput): string | undefined {
  return input.hostname ?? input.host;
}

function domainMatchesHost(domain: string | undefined, host: string | undefined): boolean {
  if (!domain || !host) return false;
  const normalizedDomain = domain.replace(/^\./, "").toLowerCase();
  const normalizedHost = normalizeHost(host);
  return normalizedHost === normalizedDomain || normalizedHost.endsWith(`.${normalizedDomain}`);
}

function cookieDomainForRequest(env: EnvInput, request: CookieRequestInput): string | undefined {
  const domain = sharedAuthCookieDomain(env);
  return domainMatchesHost(domain, requestHost(request)) ? domain : undefined;
}

function safeEqual(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function getFieldFrontendOrigins(env: EnvInput): Array<string | null> {
  return [
    normalizeOrigin(env.FIELD_APP_URL),
    normalizeOrigin(env.FIELD_FRONTEND_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_FIELD_FRONTEND_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL),
  ];
}

function getDefaultStrictCrossSiteAuthOrigins(env: EnvInput): string[] {
  return [
    normalizeOrigin(env.RAILWAY_SERVICE_TROCKCRM_FIELD_URL),
    normalizeOrigin(env.FIELD_APP_URL),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);
}

export function getAllowedCorsOrigins(env: EnvInput): string[] {
  const origins = [
    ...((env.CORS_ALLOWED_ORIGINS ?? "").split(",").map(normalizeOrigin)),
    normalizeOrigin(env.FRONTEND_URL),
    ...getFieldFrontendOrigins(env),
    normalizeOrigin(env.RAILWAY_PUBLIC_DOMAIN),
    normalizeOrigin(env.RAILWAY_STATIC_URL),
    normalizeOrigin(env.RAILWAY_SERVICE_FRONTEND_URL),
    ...(env.NODE_ENV === "production"
      ? []
      : [
          "http://localhost:5173",
          "http://localhost:5174",
          "http://localhost:3000",
        ]),
  ].filter((value, index, values): value is string => Boolean(value) && values.indexOf(value) === index);

  if (env.NODE_ENV !== "production") return origins;
  return origins.filter(isHttpsNonLocalOrigin);
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

function isHttpsNonLocalOrigin(origin: string): boolean {
  try {
    const parsed = new URL(origin);
    return parsed.protocol === "https:" && !isLocalOrTestHost(parsed.host);
  } catch {
    return false;
  }
}

export function assertSafeDevAuthConfig(env: EnvInput): void {
  if (
    env.NODE_ENV === "production" &&
    env.DEV_MODE === "true" &&
    !isDevAuthProductionOverrideEnabled(env)
  ) {
    throw new Error("Unsafe auth configuration: DEV_MODE=true is not allowed when NODE_ENV=production unless ALLOW_DEV_AUTH_IN_PROD=true and I_UNDERSTAND_DEV_AUTH_IN_PROD=yes are both set");
  }
  getFieldAppUrl(env);
}

export function isDevAuthProductionOverrideEnabled(env: EnvInput): boolean {
  return (
    env.NODE_ENV === "production" &&
    env.DEV_MODE === "true" &&
    env.ALLOW_DEV_AUTH_IN_PROD === "true" &&
    env.I_UNDERSTAND_DEV_AUTH_IN_PROD === "yes"
  );
}

export function getDevAuthProductionWarning(env: EnvInput): string | null {
  if (!isDevAuthProductionOverrideEnabled(env)) return null;
  return "[AUTH][PRODUCTION DEV AUTH ENABLED] DEV_MODE=true is active in production because ALLOW_DEV_AUTH_IN_PROD=true and I_UNDERSTAND_DEV_AUTH_IN_PROD=yes are both set. This is a high-risk temporary smoke-test override; remove it before go-live.";
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

// Office-staff session cookie lifetime: 30 days, matching the JWT_EXPIRES_IN default in service.ts.
// The token cookie and the (double-submit) CSRF cookie MUST share this value — a 30-day token under a
// shorter CSRF cookie would start failing mutating requests once the CSRF cookie expired, and a
// shorter token cookie would drop the session early. Session invalidation is enforced per-request in
// authMiddleware (is_active + token_version), independent of this lifetime.
const SESSION_COOKIE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;

export function getTokenCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";
  const domain = sharedAuthCookieDomain(env);

  return {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    domain,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  } as const;
}

function shouldPartitionCookieForRequest(env: EnvInput, request: CookieRequestInput): boolean {
  if (env.NODE_ENV !== "production") return false;
  return sameSiteForRequest(env, request) === "none";
}

function sameSiteForRequest(env: EnvInput, request: CookieRequestInput): "strict" | "lax" | "none" {
  const isProduction = env.NODE_ENV === "production";
  if (!isProduction) return "strict";

  const origin = getRequestOrigin({ origin: request.origin });
  const host = normalizeHost(requestHost(request));
  if (!origin || !host) return "lax";

  try {
    const parsedOrigin = new URL(origin);
    if (normalizeHost(parsedOrigin.host) === host) return "lax";
  } catch {
    return "lax";
  }

  return isAllowedCookieAuthOrigin(env, origin) && isStrictCrossSiteAuthOrigin(env, origin) ? "none" : "lax";
}

export function getTokenCookieOptionsForRequest(env: EnvInput, request: CookieRequestInput) {
  const { domain: _domain, sameSite: _sameSite, ...base } = getTokenCookieOptions(env);
  const domain = cookieDomainForRequest(env, request);
  const sameSite = sameSiteForRequest(env, request);
  const partitioned = shouldPartitionCookieForRequest(env, request) || undefined;
  return domain
    ? { ...base, sameSite, domain, ...(partitioned ? { partitioned } : {}) } as const
    : { ...base, sameSite, ...(partitioned ? { partitioned } : {}) } as const;
}

function tokenClearOptionVariantsForRequest(
  env: EnvInput,
  request: CookieRequestInput,
  path: string
) {
  const isProduction = env.NODE_ENV === "production";
  const domain = cookieDomainForRequest(env, request);
  const sameSite = sameSiteForRequest(env, request);
  const partitioned = shouldPartitionCookieForRequest(env, request);
  const base = {
    httpOnly: true,
    secure: isProduction,
    sameSite,
    path,
    maxAge: 0,
  } as const;
  const variants = partitioned
    ? [base, { ...base, partitioned: true } as const]
    : [base];

  return [
    ...(domain ? variants.map((options) => ({ ...options, domain })) : []),
    ...variants,
  ] as const;
}

export function getLegacyTokenCookieClearsForRequest(env: EnvInput, request: CookieRequestInput) {
  return [
    ...tokenClearOptionVariantsForRequest(env, request, "/"),
    ...tokenClearOptionVariantsForRequest(env, request, "/api/auth"),
  ].map((options) => ({ name: "token" as const, options }));
}

export function getLogoutCookieClears(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";
  const domain = sharedAuthCookieDomain(env);
  const tokenOptions = {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    path: "/",
    maxAge: 0,
  } as const;
  const csrfOptions = {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    path: "/",
    maxAge: 0,
  } as const;

  return [
    { name: "token", options: domain ? { ...tokenOptions, domain } : tokenOptions },
    { name: "token", options: tokenOptions },
    { name: CSRF_COOKIE_NAME, options: domain ? { ...csrfOptions, domain } : csrfOptions },
    { name: CSRF_COOKIE_NAME, options: csrfOptions },
  ] as const;
}

export function getLogoutCookieClearsForRequest(env: EnvInput, request: CookieRequestInput) {
  const isProduction = env.NODE_ENV === "production";
  const sameSite = sameSiteForRequest(env, request);
  const domain = cookieDomainForRequest(env, request);
  const csrfOptionsBase = {
    httpOnly: false,
    secure: isProduction,
    sameSite,
    path: "/",
    maxAge: 0,
  } as const;
  const partitioned = shouldPartitionCookieForRequest(env, request);
  const csrfOptionVariants = partitioned
    ? [csrfOptionsBase, { ...csrfOptionsBase, partitioned: true } as const]
    : [csrfOptionsBase];

  return [
    ...getLegacyTokenCookieClearsForRequest(env, request),
    ...(domain
      ? csrfOptionVariants.map((options) => ({ name: CSRF_COOKIE_NAME, options: { ...options, domain } }))
      : []),
    ...csrfOptionVariants.map((options) => ({ name: CSRF_COOKIE_NAME, options })),
  ] as const;
}

export function getCsrfCookieOptions(env: EnvInput) {
  const isProduction = env.NODE_ENV === "production";
  const domain = sharedAuthCookieDomain(env);

  return {
    httpOnly: false,
    secure: isProduction,
    sameSite: isProduction ? "lax" : "strict",
    domain,
    path: "/",
    maxAge: SESSION_COOKIE_MAX_AGE_MS,
  } as const;
}

export function getCsrfCookieOptionsForRequest(env: EnvInput, request: CookieRequestInput) {
  const { domain: _domain, sameSite: _sameSite, ...base } = getCsrfCookieOptions(env);
  const domain = cookieDomainForRequest(env, request);
  const sameSite = sameSiteForRequest(env, request);
  const partitioned = shouldPartitionCookieForRequest(env, request) || undefined;
  return domain
    ? { ...base, sameSite, domain, ...(partitioned ? { partitioned } : {}) } as const
    : { ...base, sameSite, ...(partitioned ? { partitioned } : {}) } as const;
}

export function getStrictCrossSiteAuthOrigins(env: EnvInput): string[] {
  const configured = env.STRICT_CROSS_SITE_AUTH_ORIGINS?.trim();
  const source = configured
    ? [...getDefaultStrictCrossSiteAuthOrigins(env), ...configured.split(",")]
    : getDefaultStrictCrossSiteAuthOrigins(env);

  return source
    .map(normalizeOrigin)
    .filter((value): value is string => Boolean(value))
    .filter(isHttpsNonLocalOrigin)
    .filter((value, index, values) => values.indexOf(value) === index);
}

function isStrictCrossSiteAuthOrigin(env: EnvInput, origin: string | null): boolean {
  if (!origin) return false;
  const normalized = normalizeOrigin(origin);
  if (!normalized) return false;
  return getStrictCrossSiteAuthOrigins(env).includes(normalized);
}

export function shouldExposeCsrfTokenInResponse(env: EnvInput, request: CookieRequestInput): boolean {
  if (env.NODE_ENV !== "production") return false;

  const origin = getRequestOrigin({ origin: request.origin });
  const host = normalizeHost(requestHost(request));
  if (!origin || !host) return false;

  try {
    const parsedOrigin = new URL(origin);
    if (normalizeHost(parsedOrigin.host) === host) return false;
  } catch {
    return false;
  }

  return isAllowedCookieAuthOrigin(env, origin) && isStrictCrossSiteAuthOrigin(env, origin);
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
