import type { HelmetOptions } from "helmet";

const DEFAULT_CSP_CONNECT_SRC = [
  "https://api-production-ad218.up.railway.app",
];

const CLOUDFLARE_INSIGHTS_SRC = "https://static.cloudflareinsights.com";

function splitEnvList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values));
}

export function getR2CspDomain(env: NodeJS.ProcessEnv = process.env): string | null {
  const configured = env.R2_CSP_DOMAIN?.trim();
  if (configured) return configured;

  const accountId = env.R2_ACCOUNT_ID?.trim();
  if (!accountId) return null;

  return `https://*.${accountId}.r2.cloudflarestorage.com`;
}

export function getSecurityOptions(env: NodeJS.ProcessEnv = process.env): HelmetOptions {
  const r2CspDomain = getR2CspDomain(env);
  const cspConnectSrc = unique([
    "'self'",
    ...(r2CspDomain ? [r2CspDomain] : []),
    ...splitEnvList(env.CSP_CONNECT_SRC),
    ...DEFAULT_CSP_CONNECT_SRC,
  ]);
  const cspR2Sources = [
    "'self'",
    ...(r2CspDomain ? [r2CspDomain] : []),
  ];

  return {
    contentSecurityPolicy: {
      directives: {
        connectSrc: cspConnectSrc,
        scriptSrc: ["'self'", CLOUDFLARE_INSIGHTS_SRC],
        imgSrc: [...cspR2Sources, "data:"],
        mediaSrc: cspR2Sources,
      },
    },
  };
}
