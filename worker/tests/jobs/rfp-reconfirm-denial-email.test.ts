import { describe, expect, it, vi } from "vitest";
import {
  handleRfpReconfirmDenialEmail,
  buildRfpReconfirmDenialEmail,
} from "../../src/jobs/rfp-reconfirm-denial-email.js";

const TENANT = "office_dallas";
const DEAL = "11111111-1111-1111-1111-111111111111";
const OFFICE = "22222222-2222-2222-2222-222222222222";
const REQUESTER = "33333333-3333-3333-3333-333333333333";
const REQUESTER_EMAIL = "rep@trockgc.com";
const TAKASHI = "takashi@trockgc.com";
const ADAM = "ashaw@trockgc.com";

const BASE_PAYLOAD = {
  tenantSchema: TENANT,
  dealId: DEAL,
  dealNumber: "TR-1001",
  dealName: "jasonn ranches",
  declinedReason: "Margins too thin",
  rfpApprovalRequestId: 55,
  requestedByUserId: REQUESTER,
};

const ENV = { NODE_ENV: "test", RFP_REJECTION_EMAIL_RECIPIENTS: `${TAKASHI}, ${ADAM}` } as NodeJS.ProcessEnv;
// production with NO leadership configured -> the shared resolver returns [] (no dev fallback outside dev/test)
const ENV_NO_LEADERSHIP = { NODE_ENV: "production" } as NodeJS.ProcessEnv;

/** Mock pool.query that routes by SQL text. Knobs: whether a receipt already exists, the resolved rep email. */
function makeQuery(opts: { receiptExists?: boolean; repEmail?: string | null; officeFound?: boolean } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO public.rfp_reconfirm_email_receipts")) return { rows: [] };
    if (sql.includes("FROM public.rfp_reconfirm_email_receipts")) {
      return { rows: opts.receiptExists ? [{ resend_message_id: "msg_old", sent_at: new Date() }] : [] };
    }
    if (sql.includes("FROM public.users")) {
      return { rows: opts.repEmail === undefined ? [{ email: REQUESTER_EMAIL }] : opts.repEmail === null ? [] : [{ email: opts.repEmail }] };
    }
    if (sql.includes("FROM public.offices")) {
      return { rows: opts.officeFound === false ? [] : [{ id: OFFICE }] };
    }
    return { rows: [] };
  });
  return { query: query as any, calls };
}

function makeSend() {
  const sendEmail = vi.fn(
    async (
      _to: string | string[],
      _subject: string,
      _html: string,
      _options: { text: string; idempotencyKey: string }
    ) => ({ success: true as const, messageId: "msg_new" })
  );
  return sendEmail;
}

const silentLogger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

describe("handleRfpReconfirmDenialEmail", () => {
  it("sends to the requesting rep + both leadership recipients, with deal details and an archived notice (no deal link)", async () => {
    const { query, calls } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = sendEmail.mock.calls[0];
    expect(to).toEqual([REQUESTER_EMAIL, TAKASHI, ADAM]);
    expect(subject).toContain("TR-1001");
    expect(subject).toContain("jasonn ranches");
    expect(html).toContain("jasonn ranches");
    expect(html).toContain("Margins too thin");
    // terminal outcome copy — leadership confirmed the denial (generic, no reviewer named)
    expect(html.toLowerCase()).toContain("leadership");
    // the deal is archived — no "View Deal in CRM" CTA (the deal 404s after archival)
    expect(html).not.toContain(`/deals/`);
    expect(html).not.toContain("View Deal in CRM");
    expect(html).toContain("archived");
    expect(html).not.toContain("Review &amp; Decide");
    expect(html).not.toContain("/rfp-review/");
    expect(html).not.toMatch(/trockconstruction\.com/);
    expect(options.idempotencyKey).toBe(`rfp-reconfirm-denial-${TENANT}-${DEAL}-55`);
    expect(calls.some((c) => c.sql.includes("INSERT INTO public.rfp_reconfirm_email_receipts"))).toBe(true);
  });

  it("degrades to leadership only (still sends) when the requesting rep has no id", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail({ ...BASE_PAYLOAD, requestedByUserId: null }, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("degrades to leadership only when the rep id resolves to no user", async () => {
    const { query } = makeQuery({ repEmail: null });
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("sends to the rep ALONE (does NOT throw) when leadership is unconfigured", async () => {
    // null-safe: 'denier' (leadership) missing but the rep resolves -> send to whoever's real (the rep)
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV_NO_LEADERSHIP, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([REQUESTER_EMAIL]);
  });

  it("logs and SKIPS (no send, no throw) when NEITHER the rep nor leadership resolves", async () => {
    // null-safe terminal case: 'if neither resolves, log and skip — don't crash'
    const { query, calls } = makeQuery({ repEmail: null });
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail({ ...BASE_PAYLOAD, requestedByUserId: null }, null, { query, sendEmail, env: ENV_NO_LEADERSHIP, logger: silentLogger });
    expect(sendEmail).not.toHaveBeenCalled();
    // no receipt written (nothing was sent)
    expect(calls.some((c) => c.sql.includes("INSERT INTO public.rfp_reconfirm_email_receipts"))).toBe(false);
  });

  it("does not double-email the rep if they also appear in the leadership list (case-insensitive dedupe -> single send)", async () => {
    const { query } = makeQuery({ repEmail: "Rep@trockgc.com" });
    const sendEmail = makeSend();
    const env = { NODE_ENV: "test", RFP_REJECTION_EMAIL_RECIPIENTS: `rep@trockgc.com, ${ADAM}` } as NodeJS.ProcessEnv;
    await handleRfpReconfirmDenialEmail(BASE_PAYLOAD, null, { query, sendEmail, env, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual(["Rep@trockgc.com", ADAM]);
  });

  it("skips (no send) when this RFP cycle already has a re-confirm receipt", async () => {
    const { query } = makeQuery({ receiptExists: true });
    const sendEmail = makeSend();
    await handleRfpReconfirmDenialEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).not.toHaveBeenCalled();
  });
});

describe("buildRfpReconfirmDenialEmail", () => {
  it("builds the terminal 'denial upheld' email with an archived notice and NO View-Deal CTA (deal 404s after archival)", () => {
    const email = buildRfpReconfirmDenialEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: "TR-1001",
      declinedReason: "Margins too thin",
      officeId: OFFICE,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.subject).toContain("TR-1001");
    expect(email.subject).toContain("jasonn ranches");
    // no deal link — the deal is archived (is_active=false) and getDealById 404s it
    expect(email.html).not.toContain(`/deals/`);
    expect(email.html).not.toContain("View Deal in CRM");
    expect(email.html).toContain("archived");
    expect(email.text).toContain("archived");
    expect(email.text).not.toContain(`/deals/`);
    // terminal: NO reviewer review-and-decide CTA, and the reviewer is never named
    expect(email.html).not.toContain("/rfp-review/");
    expect(email.html).not.toContain("Review &amp; Decide");
    expect(email.html.toLowerCase()).toContain("leadership");
    expect(email.html).not.toMatch(/trockconstruction\.com/);
    expect(email.text).not.toMatch(/trockconstruction\.com/);
  });

  it("handles missing fields (no dealUrl property on return value)", () => {
    const email = buildRfpReconfirmDenialEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: null,
      declinedReason: null,
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.html).toContain("No reason provided");
    expect(email.html).toContain("Pending");
    expect(email.html).toContain("archived");
    // TypeScript: dealUrl is no longer on the return type
    expect((email as any).dealUrl).toBeUndefined();
  });
});
