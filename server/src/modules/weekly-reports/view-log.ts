import type { Request } from "express";
import { isIP } from "node:net";
import { pool } from "../../db.js";

/**
 * Record that somebody fetched a client's weekly-report link.
 *
 * "We never received that report" is a claim the CRM could not previously answer. It knew the message was
 * composed, that the provider accepted it, and what the provider said afterwards — and then nothing.
 *
 * OBSERVATIONS ONLY. Nothing here decides whether the fetch was a person or their mail security scanner;
 * that judgement is made at read time by `shared/lib/weeklyReportViews`, because its strongest signal —
 * whether the visitor went on to load the photographs or download the PDF — does not exist yet at the
 * moment a page fetch is logged.
 *
 * BEST-EFFORT, ALWAYS. Every call site is on a route a client is waiting on, and an audit row is worth
 * strictly less than the report it is auditing. A failure here is logged and swallowed: never awaited
 * into a response, never allowed to turn a readable report into an error.
 */
export type WeeklyReportViewEventType = "page" | "pdf" | "photo";

/**
 * The caller's address, honouring the proxy chain.
 *
 * Railway terminates TLS ahead of the app, so `req.ip` is the proxy unless Express is told to trust it.
 * `X-Forwarded-For` is a comma-separated chain and the ORIGINAL client is the leftmost entry — taking the
 * last would record our own edge on every row, which is an access log that says nothing at all.
 *
 * A header is client-supplied and therefore forgeable. That is acceptable for this purpose and worth
 * being explicit about: the log is corroborating evidence read by a human alongside the user agent, the
 * timing and what else the session fetched, not an identity claim standing on its own.
 */
export function clientIpFrom(req: Request): string | null {
  const forwarded = req.headers["x-forwarded-for"];
  const chain = Array.isArray(forwarded) ? forwarded[0] : forwarded;
  const first = chain?.split(",")[0]?.trim();
  if (first) return first;
  return req.ip ?? req.socket?.remoteAddress ?? null;
}

/**
 * The address to store, or null when there is not a real one.
 *
 * VALIDATED HERE rather than left to the `::inet` cast, because of what the cast's failure costs. The
 * insert is wrapped in a catch — a view that cannot be recorded must not break the page the client is
 * reading — so a 22P02 does not merely lose the address, it loses THE ENTIRE EVENT. And the input is
 * `X-Forwarded-For`, which the visitor controls: `:::`, `1.2.3.4:8080` and `....` are all made of legal
 * characters, all rejected by `inet`, and each one is a way for a link holder to leave no trace at all.
 *
 * `net.isIP` accepts exactly what `inet` accepts, so an address that survives this survives the cast.
 */
export function clientIpForLog(req: Request): string | null {
  const candidate = clientIpFrom(req);
  return candidate && isIP(candidate) ? candidate : null;
}

/** Bounded before it reaches the column — a user agent is attacker-controlled and unbounded. */
function bounded(value: unknown, max: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

export interface RecordWeeklyReportViewInput {
  weeklyReportId: string;
  tokenId: string | null;
  tenantId: string | null;
  officeSlug: string | null;
  eventType: WeeklyReportViewEventType;
}

export async function recordWeeklyReportView(
  req: Request,
  input: RecordWeeklyReportViewInput,
): Promise<void> {
  try {
    const ip = clientIpForLog(req);
    await pool.query(
      `INSERT INTO public.weekly_report_views
         (weekly_report_id, token_id, tenant_id, office_slug, event_type, ip, user_agent, referrer)
       VALUES ($1::uuid, $2::uuid, $3::uuid, $4, $5, $6::inet, $7, $8)`,
      [
        input.weeklyReportId,
        input.tokenId,
        input.tenantId,
        input.officeSlug,
        input.eventType,
        // Already validated — see clientIpForLog. Null here means "no usable address", never "the cast
        // will sort it out", because the cast failing takes the whole event with it.
        ip,
        bounded(req.headers["user-agent"], 1_000),
        bounded(req.headers.referer, 1_000),
      ],
    );
  } catch (error) {
    console.warn("[weekly-report-viewer] could not record a view", {
      weeklyReportId: input.weeklyReportId,
      eventType: input.eventType,
      error,
    });
  }
}
