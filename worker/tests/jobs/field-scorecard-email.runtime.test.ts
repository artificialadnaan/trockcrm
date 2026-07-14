import { describe, expect, it, vi } from "vitest";
import {
  handleFieldScorecardEmail,
  type FieldScorecardEmailPayload,
} from "../../src/jobs/field-scorecard-email.js";

const DIGEST = "a".repeat(64);
const PDF_KEY = `office_dallas/deals/DFW-10432/documents/scorecards/card.${DIGEST}.v2.pdf`;
const payload: FieldScorecardEmailPayload = {
  tenantSchema: "office_dallas",
  scorecardId: "11111111-1111-1111-1111-111111111111",
  dealId: "22222222-2222-2222-2222-222222222222",
  dealName: "Maple Street Tower",
  projectNumber: "DFW-10432",
  weekOf: "2026-07-06",
  totalScore: 84,
  ratingLabel: "Meets Standard",
  pdfR2Key: PDF_KEY,
};
const env = {
  NODE_ENV: "production",
  FIELD_SCORECARD_EMAIL_RECIPIENTS: "ops@trock.com",
} as unknown as NodeJS.ProcessEnv;
const logger = { log: vi.fn(), warn: vi.fn(), error: vi.fn() };

function queryWithCurrentKey(pdfR2Key: string | null, pdfRenderVersion = 2) {
  return vi.fn(async (query: string) => {
    if (/SELECT/i.test(query)) {
      return {
        rows: [{
          email_sent_at: null,
          pdf_r2_key: pdfR2Key,
          pdf_render_version: pdfRenderVersion,
        }],
      };
    }
    return { rows: [] };
  });
}

describe("field scorecard email artifact safety", () => {
  it("uses the row's current artifact key after regeneration, not a stale queued payload key", async () => {
    const currentKey = `office_dallas/deals/DFW-10432/documents/scorecards/card.${"b".repeat(64)}.v3.pdf`;
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-current"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-1" });

    await handleFieldScorecardEmail(
      { ...payload, pdfR2Key: "legacy.pdf" },
      null,
      { query: queryWithCurrentKey(currentKey, 3) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).toHaveBeenCalledWith(currentKey);
    expect(sendEmail.mock.calls[0][3].attachments).toHaveLength(1);
  });

  it("sends without an attachment when evidence deletion invalidated the row key", async () => {
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-stale-with-deleted-evidence"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "mail-2" });

    await handleFieldScorecardEmail(
      payload,
      null,
      { query: queryWithCurrentKey(null) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });

  it.each([
    {
      name: "a legacy v1 artifact",
      key: `office_dallas/deals/DFW-10432/documents/scorecards/card.${DIGEST}.v1.pdf`,
      version: 1,
    },
    {
      name: "a late legacy writer's key on a v2 row",
      key: "office_dallas/deals/DFW-10432/documents/scorecards/card.pdf",
      version: 2,
    },
    {
      name: "the old non-content-addressed v2 key",
      key: "office_dallas/deals/DFW-10432/documents/scorecards/card.v2.pdf",
      version: 2,
    },
  ])("sends the CRM-link fallback instead of attaching $name", async ({ key, version }) => {
    const getPdf = vi.fn().mockResolvedValue(Buffer.from("%PDF-stale-without-current-evidence"));
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: `mail-stale-${version}` });

    await handleFieldScorecardEmail(
      payload,
      null,
      { query: queryWithCurrentKey(key, version) as any, getPdf, sendEmail, env, logger },
    );

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    expect(sendEmail.mock.calls[0][3].attachments).toBeUndefined();
  });
});
