import rateLimit from "express-rate-limit";
import type { Request } from "express";

// Key by authenticated user ID when available, fall back to IP.
// This prevents a shared office IP from rate-limiting all 30 users together.
function userOrIpKey(req: Request): string {
  return (req as any).user?.id ?? req.ip ?? "unknown";
}

export const apiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300, // 300 req/min per user (a page load uses 3-5 calls)
  keyGenerator: userOrIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});

export const authLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many auth attempts, please try again later" } },
});

export const publicDueDiligenceGetLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 60,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later",
});

export const publicDueDiligencePostLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many decision attempts, please try again later",
});

// Normalize an IP to a stable rate-limit key. express-rate-limit ships an `ipKeyGenerator` helper that IPv6-
// normalizes to a /64 subnet, but it is NOT exported in the installed v7 build (verified: `undefined`), so we
// fall back to the raw req.ip. IPv4 is used verbatim; IPv6 is lower-cased so casing variants share one bucket.
function correctiveActionIpKey(req: Request): string {
  const raw = req.ip ?? "unknown";
  return raw.includes(":") ? raw.toLowerCase() : raw;
}

// Public corrective-action token routes (GET items / POST response / upload url·confirm·discard) are reachable
// with only a ?token and are mounted under /api/field, which has NO apiLimiter. Their authorize step fans the
// arbitrary scorecard UUID across EVERY active office schema (resolveWriteOffice), so a flood carrying any
// nonempty token would generate one DB query per office per request — a cross-office-scan DoS amplifier. Cap
// BEFORE the authorize/scan runs, on EVERY request to these routes (tokenless included).
//
// Key by IP ONLY — deliberately NOT IP+token. A forged ?token only has to pass the 43-char base64url SHAPE gate
// to reach resolveWriteOffice (verification happens AFTER the scan), so an attacker rotating the token would get
// a FRESH bucket per token under an IP+token key and never trip the cap — defeating the exact amplification this
// limiter exists to stop. An IP-only bucket is a shared ceiling that token rotation cannot escape. We also DROP
// the old tokenless `skip`: authorizeCorrectiveAction calls resolveWriteOffice UNCONDITIONALLY (before the
// token/session branch), so a TOKENLESS/session request is ALSO a cross-office-scan amplifier and must be capped
// too — the earlier belief that only the token path amplifies was wrong.
//
// Sizing: ONE full supported response is 50 photos → 1 GET items + 50 presign (upload/url) + 50 confirm
// (upload) + 1 POST response = 102 requests within a minute. Two legit responders behind ONE shared office NAT
// IP now SHARE this bucket (the trade-off of IP-only keying), so size for a couple of concurrent full responses:
// 2 × 102 = 204, rounded up to 220/min for retry/refresh headroom. That comfortably clears legitimate
// concurrent use while a scanning flood — hundreds of GETs/min from one IP, whatever the token — still trips it.
export const CORRECTIVE_ACTION_PUBLIC_LIMIT = 220; // ≈ two full 50-photo responses (204) + headroom, per IP.
export const correctiveActionPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: CORRECTIVE_ACTION_PUBLIC_LIMIT,
  keyGenerator: correctiveActionIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});

// The public weekly-report viewer (/wr/:token), which is unauthenticated and mounted outside apiLimiter.
// Every request reaches the database, and the photo route additionally buffers an original from R2 and
// re-encodes it with sharp — the expensive part, and the reason a cap belongs in front of it.
//
// Keyed by IP, reusing correctiveActionIpKey for the same reason it exists: keying by IP+token would hand a
// scanner a fresh bucket per guessed token, since a forged token only has to pass a 43-character shape gate
// to reach the lookup at all.
//
// Sizing: ONE page load is 1 HTML + up to 60 photos + 1 PDF ≈ 62 requests. A client refreshing, or several
// people behind one corporate NAT reading the same report, must not trip it — 300/min clears roughly four
// full page loads a minute while a scanning flood still stops.
const WEEKLY_REPORT_PUBLIC_LIMIT = 300;
export const weeklyReportPublicLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WEEKLY_REPORT_PUBLIC_LIMIT,
  keyGenerator: correctiveActionIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: "Too many requests, please try again later",
});

// The mail provider's delivery webhook (/api/webhooks/resend), which is world-reachable and verifies a
// signature over the request body. That HMAC is the work an unauthenticated caller can force — cheap per
// request, not cheap at volume, and reachable by anyone who learns the URL.
//
// SIZED SO THE PROVIDER CANNOT TRIP IT. This is not a CRM surface where a 429 costs somebody a refresh:
// the webhook is configured per provider ACCOUNT, so every system email this company sends — scorecards,
// RFP mail, project-number notifications, weekly reports — produces events here, and a burst is normal
// (one send to four recipients emits sent/delivered/opened events within seconds). The provider does retry
// a non-2xx, so a trip is recoverable rather than lost, but a limiter that fires on ordinary traffic
// converts real delivery facts into delayed ones for no benefit. 600/min is roughly an order of magnitude
// above the busiest minute this account has ever had.
//
// Keyed by IP, like its siblings: the provider sends from a small stable set, so legitimate traffic shares
// a bucket that an unrelated flood cannot consume.
const WEEKLY_REPORT_DELIVERY_WEBHOOK_LIMIT = 600;
export const weeklyReportDeliveryWebhookLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WEEKLY_REPORT_DELIVERY_WEBHOOK_LIMIT,
  keyGenerator: correctiveActionIpKey,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many requests, please try again later" } },
});

/**
 * The weekly-report dictation pass, which is the only authenticated route in this app that spends money
 * per call.
 *
 * It reaches Anthropic with `claude-opus-5` on every request, up to MAX_ATTEMPTS times, and every field
 * account in the company can authenticate against the surface it is mounted on. The per-CALL cost is
 * already bounded — the transcript is capped at 4k chars and the output at the section ceiling — but
 * nothing bounded calls per ACTOR, so a stuck retry loop in the app, or one stolen field token, could
 * spend without limit and the first sign of it would be an invoice.
 *
 * KEYED BY USER, NOT IP, unlike every other limiter in this file. Those protect unauthenticated surfaces
 * where the IP is the only identity available. Here the caller is authenticated before this runs, and IP
 * is actively the wrong key: a crew on one jobsite shares a cellular NAT, so an IP bucket would let one
 * superintendent's runaway exhaust the budget of everyone standing next to them. The actor who spends the
 * money is the account.
 *
 * MOUNTED AFTER `requireFieldContractor` so `req.fieldUser` exists. That also means an unauthenticated
 * flood is refused by auth without consuming anyone's bucket.
 *
 * SIZED WELL ABOVE HUMAN USE, because tripping it is invisible and cheap: the phone swallows any 4xx and
 * falls back to its on-device bullet split (mobile/src/weekly-reports/dictation.ts), so a superintendent
 * who somehow hit this still gets their words formatted into the same editable box. The recorder stops
 * itself at 60 seconds, so a person cannot physically produce more than about one transcript a minute per
 * section; 30 is an order of magnitude above the busiest real session and still stops a loop dead.
 */
const WEEKLY_REPORT_DICTATION_LIMIT = 30;
export const weeklyReportDictationLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: WEEKLY_REPORT_DICTATION_LIMIT,
  keyGenerator: (req: Request) => {
    const id = (req as Request & { fieldUser?: { id?: unknown } }).fieldUser?.id;
    // Falling back to IP rather than to a single shared bucket: a constant key would put every caller
    // whose id could not be read into one bucket, which is a self-inflicted outage rather than a limit.
    return typeof id === "string" && id ? `user:${id}` : `ip:${correctiveActionIpKey(req)}`;
  },
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: { message: "Too many dictation requests, please try again in a minute" } },
});
