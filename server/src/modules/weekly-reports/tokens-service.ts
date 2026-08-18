import crypto from "node:crypto";
import type { Request } from "express";
import { AppError } from "../../middleware/error-handler.js";
import { publicViewerBaseUrl } from "../public-photo-tokens/public-share-url.js";
import type { QueryExecutor } from "./projects-service.js";

// The durable client link, mirroring public.public_photo_tokens (0084) exactly.
//
// What is stored is a SHA-256 HASH of the token. The raw value exists only inside the URL that goes out by
// email, so a database read — a support query, a backup, a leaked dump — cannot reconstruct a live link to
// a client's report. Every lookup hashes the incoming value and matches on the hash.
//
// The table is in `public`, not per-office, because /wr/:token has no office context until the token
// resolves: the row is what tells the viewer which schema to read. Same reasoning as
// public.field_ai_report_runs (0209).

const TOKEN_BYTES = 32;

/**
 * 180 days, matching the spec.
 *
 * Deliberately finite. A link that never expires is a permanent unauthenticated read of a client-facing
 * document, sitting in an email thread that will outlive the project and everyone on it. Six months covers
 * the window in which anyone actually revisits a weekly update.
 */
export const WEEKLY_REPORT_TOKEN_TTL_DAYS = 180;

export type WeeklyReportTokenStatus = "active" | "expired" | "revoked";

/**
 * Report states a client may see through a share link.
 *
 * Enforced at BOTH ends — when the link is minted, and again on every public request — and that second
 * check is the one that matters. `approved` is not terminal: `approved -> pending_review` is a legal
 * transition the assigned superintendent may make on their own, and a report back in `pending_review` is
 * editable by that superintendent. Checking only at mint time therefore left a live client link serving
 * whatever the super typed next, in real time, with no PM having seen it — precisely the outcome the
 * approval gate exists to prevent. A report pulled back for rework goes dark until it is approved again.
 */
export function isWeeklyReportShareableStatus(status: unknown): boolean {
  return status === "approved" || status === "sent";
}

export interface WeeklyReportTokenRow {
  id: string;
  weeklyReportId: string;
  tenantId: string;
  officeSlug: string;
  createdByUserId: string | null;
  createdAt: string;
  expiresAt: string | null;
  revokedAt: string | null;
  status: WeeklyReportTokenStatus;
}

export function generateRawWeeklyReportToken(): string {
  return crypto.randomBytes(TOKEN_BYTES).toString("base64url");
}

export function hashWeeklyReportToken(rawToken: string): string {
  return crypto.createHash("sha256").update(rawToken).digest("hex");
}

/**
 * Shape gate applied BEFORE the token reaches the database.
 *
 * /wr/:token is unauthenticated and world-reachable, so every path segment anyone types becomes a query
 * unless something stops it first. base64url of 32 bytes is always 43 characters; anything else cannot be
 * one of ours and is refused without a round trip.
 */
export function isWeeklyReportTokenShape(value: unknown): value is string {
  return typeof value === "string" && /^[A-Za-z0-9_-]{43}$/.test(value);
}

function isoTimestamp(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) return value.toISOString();
  return new Date(String(value)).toISOString();
}

function tokenStatus(row: { revoked_at?: unknown; expires_at?: unknown }, now = Date.now()): WeeklyReportTokenStatus {
  if (row.revoked_at) return "revoked";
  const expires = row.expires_at ? new Date(String(row.expires_at)).getTime() : null;
  if (expires != null && expires <= now) return "expired";
  return "active";
}

function mapTokenRow(row: Record<string, any>): WeeklyReportTokenRow {
  return {
    id: row.id,
    weeklyReportId: row.weekly_report_id,
    tenantId: row.tenant_id,
    officeSlug: row.office_slug,
    createdByUserId: row.created_by_user_id ?? null,
    createdAt: isoTimestamp(row.created_at)!,
    expiresAt: isoTimestamp(row.expires_at),
    revokedAt: isoTimestamp(row.revoked_at),
    status: tokenStatus(row),
  };
}

export interface MintWeeklyReportTokenInput {
  weeklyReportId: string;
  tenantId: string;
  officeSlug: string;
  createdByUserId: string;
  /** Overridable only so tests can assert expiry behaviour without waiting six months. */
  ttlDays?: number;
}

/**
 * Mint a share link.
 *
 * `client` is the CALLER's executor — the request transaction when a CRM route mints one, so the token and
 * whatever else that request wrote either both land or neither does. public.weekly_report_tokens is
 * reachable from any search_path (it is schema-qualified), so a tenant-scoped connection works unchanged.
 *
 * Each call mints a NEW token rather than returning an existing one. A re-send is a new link, and the point
 * of that is revocation: revoking the link you just emailed must not kill the one a client is already using.
 */
export async function mintWeeklyReportToken(
  client: QueryExecutor,
  input: MintWeeklyReportTokenInput,
): Promise<{ rawToken: string; token: WeeklyReportTokenRow }> {
  const rawToken = generateRawWeeklyReportToken();
  const ttlDays = input.ttlDays ?? WEEKLY_REPORT_TOKEN_TTL_DAYS;
  const result = await client.query(
    `INSERT INTO public.weekly_report_tokens
       (token, weekly_report_id, tenant_id, office_slug, created_by_user_id, expires_at)
     VALUES ($1, $2::uuid, $3::uuid, $4, $5::uuid, now() + make_interval(days => $6::int))
     RETURNING id, weekly_report_id, tenant_id, office_slug, created_by_user_id,
               created_at, expires_at, revoked_at`,
    [
      hashWeeklyReportToken(rawToken),
      input.weeklyReportId,
      input.tenantId,
      input.officeSlug,
      input.createdByUserId,
      ttlDays,
    ],
  );
  return { rawToken, token: mapTokenRow(result.rows[0]) };
}

export type WeeklyReportTokenResolution =
  | { status: "active" | "expired" | "revoked"; token: WeeklyReportTokenRow }
  | { status: "unknown"; token: null };

/**
 * Resolve a raw token WITHOUT filtering out the dead ones.
 *
 * The obvious query — `WHERE token = $1 AND revoked_at IS NULL AND expires_at > now()` — collapses expired,
 * revoked and never-existed into a single 404, and the viewer then cannot tell a client whose link has aged
 * out ("here is your PM, ask them for a fresh one") from a mistyped URL. The distinction is the whole
 * difference between a friendly page and a dead end, so the filtering happens HERE, in the returned status.
 */
export async function resolveWeeklyReportToken(
  client: QueryExecutor,
  rawToken: string,
): Promise<WeeklyReportTokenResolution> {
  if (!isWeeklyReportTokenShape(rawToken)) return { status: "unknown", token: null };
  const result = await client.query(
    `SELECT id, weekly_report_id, tenant_id, office_slug, created_by_user_id,
            created_at, expires_at, revoked_at
       FROM public.weekly_report_tokens
      WHERE token = $1
      LIMIT 1`,
    [hashWeeklyReportToken(rawToken)],
  );
  const row = result.rows[0];
  if (!row) return { status: "unknown", token: null };
  const token = mapTokenRow(row);
  return { status: token.status, token };
}

/**
 * Revoke a link. Idempotent via COALESCE — re-revoking must not move the timestamp, or an audit reading
 * "revoked at 4pm" would silently become "revoked at 6pm" the second time somebody clicked the button.
 *
 * Scoped by tenant AND by report, both inside the UPDATE's own predicate. Tenant scoping stops one office
 * revoking another's links; report scoping stops one report's page revoking a link belonging to a different
 * report in the same office. Checking the report id after the write would have relied on a rollback to undo
 * a revocation that should never have happened.
 */
export async function revokeWeeklyReportToken(
  client: QueryExecutor,
  input: { tokenId: string; tenantId: string; weeklyReportId: string },
): Promise<WeeklyReportTokenRow> {
  const result = await client.query(
    `UPDATE public.weekly_report_tokens
        SET revoked_at = COALESCE(revoked_at, now())
      WHERE id = $1::uuid AND tenant_id = $2::uuid AND weekly_report_id = $3::uuid
      RETURNING id, weekly_report_id, tenant_id, office_slug, created_by_user_id,
                created_at, expires_at, revoked_at`,
    [input.tokenId, input.tenantId, input.weeklyReportId],
  );
  const row = result.rows[0];
  if (!row) throw new AppError(404, "Share link not found");
  return mapTokenRow(row);
}

/** Every link ever minted for a report, newest first. Raw tokens are unrecoverable and never returned. */
export async function listWeeklyReportTokens(
  client: QueryExecutor,
  weeklyReportId: string,
  tenantId: string,
): Promise<WeeklyReportTokenRow[]> {
  const result = await client.query(
    `SELECT id, weekly_report_id, tenant_id, office_slug, created_by_user_id,
            created_at, expires_at, revoked_at
       FROM public.weekly_report_tokens
      WHERE weekly_report_id = $1::uuid AND tenant_id = $2::uuid
      ORDER BY created_at DESC`,
    [weeklyReportId, tenantId],
  );
  return result.rows.map(mapTokenRow);
}

/**
 * The client-facing URL for a raw token.
 *
 * `/wr/` is served by the API service itself, which is why publicViewerBaseUrl's warning matters here: the
 * configured host must be one the API answers on. Pointed at the field host (trockcam.com) or an SPA-only
 * frontend, this mints links that resolve to a 404 the client sees and we do not.
 */
export function weeklyReportShareUrl(req: Request, rawToken: string): string {
  return `${publicViewerBaseUrl(req)}/wr/${encodeURIComponent(rawToken)}`;
}

/**
 * Refuse to mint a client link when nothing says where client links live.
 *
 * FAILS CLOSED IN PRODUCTION, warns elsewhere. The deploy is configured today (reports.trockcam.com), so
 * this is fragility rather than a live bug — but the cost of being wrong is a client receiving an email
 * whose only link 404s, discoverable by nobody but them, and the send is irreversible the moment the
 * transaction commits. A local or CI process legitimately has no such host, so the refusal is scoped to the
 * environment where a real client is on the other end.
 *
 * LIVES HERE, NEXT TO `weeklyReportShareUrl`, BECAUSE THERE ARE NOW TWO SENDERS. It began as a private
 * helper in routes.ts, and the field mount needs exactly the same refusal for a sharper reason: a PM
 * sending from a phone has no way to notice that the link they just emailed points at a host that does not
 * serve /wr. Copying the check into field-routes.ts would have made the two surfaces' answer to "is this
 * deploy safe to send from?" independently editable, which is the divergence the whole send flow is
 * arranged to avoid.
 */
export function assertClientLinksAreConfigured(): void {
  if (process.env.PUBLIC_SHARE_BASE_URL?.trim()) return;
  if (process.env.NODE_ENV === "production") {
    throw new AppError(
      500,
      "Client links are not configured (PUBLIC_SHARE_BASE_URL is unset), so the link in the client's " +
        "email would not resolve. Nothing has been sent.",
    );
  }
  console.warn(
    "[weekly-report] PUBLIC_SHARE_BASE_URL is unset — a client link would be minted against FRONTEND_URL " +
      "or the request host, neither of which is guaranteed to serve /wr.",
  );
}
