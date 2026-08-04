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
  const derivedR2Host = r2CspDomain?.startsWith("https://*.")
    ? r2CspDomain.replace("https://*.", "https://")
    : null;
  const cspConnectSrc = unique([
    "'self'",
    ...(r2CspDomain ? [r2CspDomain] : []),
    // The apex host, for the same reason imgSrc needs it below — and this directive is the one browser
    // UPLOADS go through, which is what this policy's own test is named for.
    ...(derivedR2Host ? [derivedR2Host] : []),
    ...splitEnvList(env.CSP_CONNECT_SRC),
    ...DEFAULT_CSP_CONNECT_SRC,
  ]);
  // BOTH THE WILDCARD AND THE BARE HOST. R2 presigns against `<account>.r2.cloudflarestorage.com`
  // itself, and a CSP source of `https://*.<account>.r2.cloudflarestorage.com` does NOT match that —
  // `*.` matches subdomains and never the apex. So the derived policy admitted a host nothing serves
  // from and refused the one everything is signed on: the CRM's own photos as much as TROCK Scope's
  // evidence frames.
  //
  // Latent until now because the app is served by its own frontend container, which sets no CSP; this
  // policy governs only what the API container serves, which includes the SPA fallback in app.ts. So
  // the bug bites whoever next runs the app from the API, and it is a one-line difference to not have
  // it waiting for them.
  //
  // An explicitly configured `R2_CSP_DOMAIN` is used exactly as given: it is somebody's deliberate
  // value, and second-guessing its shape is how a correct override gets broken.
  const cspR2Sources = unique([
    "'self'",
    ...(r2CspDomain ? [r2CspDomain] : []),
    ...(derivedR2Host ? [derivedR2Host] : []),
  ]);

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
