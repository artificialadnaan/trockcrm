import { describe, expect, it, vi } from "vitest";
import {
  handleRfpRejectedEmail,
  resolveRfpRejectionRecipients,
  buildRfpRejectionEmail,
} from "./rfp-rejection-email.js";

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

/** Mock pool.query that routes by SQL text. Knobs: whether a receipt already exists, the resolved rep email. */
function makeQuery(opts: { receiptExists?: boolean; repEmail?: string | null; officeFound?: boolean } = {}) {
  const calls: Array<{ sql: string; params: any[] }> = [];
  const query = vi.fn(async (sql: string, params: any[] = []) => {
    calls.push({ sql, params });
    if (sql.includes("INSERT INTO public.rfp_rejection_email_receipts")) return { rows: [] };
    if (sql.includes("FROM public.rfp_rejection_email_receipts")) {
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

describe("resolveRfpRejectionRecipients", () => {
  it("splits a comma-separated env var, trims, and de-dupes", () => {
    expect(resolveRfpRejectionRecipients({ RFP_REJECTION_EMAIL_RECIPIENTS: ` ${TAKASHI} , ${ADAM} ,${TAKASHI}` } as any))
      .toEqual([TAKASHI, ADAM]);
  });
  it("returns [] when unset outside dev/test (fails loudly downstream)", () => {
    expect(resolveRfpRejectionRecipients({ NODE_ENV: "production" } as any)).toEqual([]);
  });
});

describe("handleRfpRejectedEmail", () => {
  it("sends to the requesting rep + both env recipients, with deal name/number + reason and a trockcrm.com link", async () => {
    const { query, calls } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpRejectedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject, html, options] = sendEmail.mock.calls[0];
    // recipients = requester + Takashi + Adam
    expect(to).toEqual([REQUESTER_EMAIL, TAKASHI, ADAM]);
    expect(subject).toContain("TR-1001");
    expect(subject).toContain("jasonn ranches");
    // body content
    expect(html).toContain("jasonn ranches");
    expect(html).toContain("TR-1001");
    expect(html).toContain("Margins too thin");
    // link: trockcrm.com host, /deals/{id}, officeId is the only query param, NEVER trockconstruction.com
    expect(html).toContain(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    expect(html).not.toMatch(/trockconstruction\.com/);
    expect(options.idempotencyKey).toBe(`rfp-rejected-${TENANT}-${DEAL}-55`);
    // receipt written
    expect(calls.some((c) => c.sql.includes("INSERT INTO public.rfp_rejection_email_receipts"))).toBe(true);
  });

  it("throws (loud) and does NOT send when RFP_REJECTION_EMAIL_RECIPIENTS is unset", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await expect(
      handleRfpRejectedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: { NODE_ENV: "production" } as any, logger: silentLogger })
    ).rejects.toThrow(/RFP_REJECTION_EMAIL_RECIPIENTS is not configured/);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("degrades to the env recipients (still sends) when the requesting rep has no id", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    await handleRfpRejectedEmail({ ...BASE_PAYLOAD, requestedByUserId: null }, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("degrades to the env recipients when the rep id resolves to no user", async () => {
    const { query } = makeQuery({ repEmail: null });
    const sendEmail = makeSend();
    await handleRfpRejectedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(sendEmail.mock.calls[0][0]).toEqual([TAKASHI, ADAM]);
  });

  it("skips (no send) when this rejection cycle already has a receipt", async () => {
    const { query } = makeQuery({ receiptExists: true });
    const sendEmail = makeSend();
    await handleRfpRejectedEmail(BASE_PAYLOAD, null, { query, sendEmail, env: ENV, logger: silentLogger });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("does not double-email the rep if they also appear in the env list (case-insensitive dedupe)", async () => {
    const { query } = makeQuery({ repEmail: "Rep@trockgc.com" });
    const sendEmail = makeSend();
    const env = { NODE_ENV: "test", RFP_REJECTION_EMAIL_RECIPIENTS: `rep@trockgc.com, ${ADAM}` } as NodeJS.ProcessEnv;
    await handleRfpRejectedEmail(BASE_PAYLOAD, null, { query, sendEmail, env, logger: silentLogger });
    expect(sendEmail.mock.calls[0][0]).toEqual(["Rep@trockgc.com", ADAM]);
  });
});

describe("buildRfpRejectionEmail link", () => {
  it("builds https://trockcrm.com/deals/{id}?officeId={office} and never trockconstruction.com", () => {
    const email = buildRfpRejectionEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: "TR-1001",
      declinedReason: "Margins too thin",
      officeId: OFFICE,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.dealUrl).toBe(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    // officeId is the ONLY query param (no stray junk)
    expect(email.dealUrl.split("?")[1]).toBe(`officeId=${OFFICE}`);
    expect(email.html).not.toMatch(/trockconstruction\.com/);
    expect(email.text).not.toMatch(/trockconstruction\.com/);
  });

  it("omits the query string when the office is unresolved", () => {
    const email = buildRfpRejectionEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: null,
      declinedReason: null,
      officeId: null,
      frontendUrl: "https://trockcrm.com",
    });
    expect(email.dealUrl).toBe(`https://trockcrm.com/deals/${DEAL}`);
    expect(email.reviewUrl).toBe(`https://trockcrm.com/rfp-review/${DEAL}`);
    expect(email.html).toContain("No reason provided");
    expect(email.html).toContain("Pending");
  });

  it("includes the override review-page link + button so reviewers can approve or re-confirm", () => {
    const email = buildRfpRejectionEmail({
      dealId: DEAL,
      dealName: "jasonn ranches",
      dealNumber: "TR-1001",
      declinedReason: "Margins too thin",
      officeId: OFFICE,
      frontendUrl: "https://trockcrm.com",
    });
    // primary CTA points at the dedicated review page for THIS deal, carrying officeId so it resolves
    expect(email.reviewUrl).toBe(`https://trockcrm.com/rfp-review/${DEAL}?officeId=${OFFICE}`);
    expect(email.reviewUrl.split("?")[1]).toBe(`officeId=${OFFICE}`);
    expect(email.html).toContain(`https://trockcrm.com/rfp-review/${DEAL}?officeId=${OFFICE}`);
    expect(email.html).toContain("Review &amp; Decide");
    // the text fallback links to the review page too
    expect(email.text).toContain(`https://trockcrm.com/rfp-review/${DEAL}?officeId=${OFFICE}`);
    // the requester (who is NOT a reviewer) still gets a working primary "View Deal in CRM" action -
    // the reviewer-only page must not become their only CTA (Codex P2).
    expect(email.html).toContain("View Deal in CRM");
    expect(email.html).toContain(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    expect(email.text).toContain(`https://trockcrm.com/deals/${DEAL}?officeId=${OFFICE}`);
    expect(email.html).not.toMatch(/trockconstruction\.com/);
  });
});
