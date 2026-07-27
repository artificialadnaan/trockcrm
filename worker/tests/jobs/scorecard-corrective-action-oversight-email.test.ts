import { describe, expect, it, vi } from "vitest";
import {
  handleScorecardCorrectiveActionOversightEmail,
  type ScorecardCorrectiveActionOversightEmailPayload,
} from "../../src/jobs/scorecard-corrective-action-oversight-email.js";

const SCORECARD = "11111111-1111-1111-1111-111111111111";
const DEAL = "22222222-2222-2222-2222-222222222222";
const CYCLE = "99999999-9999-9999-9999-999999999999";
const GENERATION = new Date("2026-07-27T14:00:00.000Z");

const env = {
  NODE_ENV: "production",
  FRONTEND_URL: "https://trockcrm.com",
  FIELD_SCORECARD_EMAIL_RECIPIENTS: "james@trockgc.com, ops@trockgc.com",
} as unknown as NodeJS.ProcessEnv;

function makeLogger() {
  return { log: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function payload(
  over: Partial<ScorecardCorrectiveActionOversightEmailPayload> = {},
): ScorecardCorrectiveActionOversightEmailPayload {
  return {
    tenantSchema: "office_dallas",
    scorecardId: SCORECARD,
    dealId: DEAL,
    officeId: "00000000-0000-0000-0000-0000000000f1",
    phase: "opened",
    cycleNonce: CYCLE,
    ...over,
  };
}

const ITEMS = [
  {
    item_type: "action_item",
    item_ref: "0",
    item_label: "Re-inspect slab 2",
    status: "resolved",
    responder_name: "Sam Super",
    responded_at: new Date("2026-07-27T13:00:00.000Z"),
    response_comment: "Re-poured and cured.",
    photo_count: 2,
  },
  {
    item_type: "critical_deficiency",
    item_ref: "missed_hold_point",
    item_label: "Missed hold point",
    status: "open",
    responder_name: null,
    responded_at: null,
    response_comment: null,
    photo_count: 0,
  },
];

interface ScorecardOverrides {
  openedAt?: Date | null;
  closedAt?: Date | null;
  pdfR2Key?: string | null;
  pdfRenderVersion?: number;
  status?: string;
  pdfContentGeneration?: Date | null;
  updatedAt?: Date;
}

/** Query mock routing on SQL text — no DB. Captures the stamp UPDATE for assertion. */
function makeQuery(
  over: ScorecardOverrides = {},
  responders: Array<{ email: string | null }> = [],
) {
  const stampUpdates: Array<{ sql: string; params: unknown[] }> = [];
  const query = vi.fn(async (sql: string, params: unknown[] = []) => {
    // Order matters: recipientResolutionSql ALSO selects `FROM office_dallas.field_scorecards sc`, so the
    // responder branch must be tested before the scorecard-snapshot branch or it is swallowed by it.
    if (sql.includes("WITH candidates AS")) return { rows: responders };
    if (sql.includes("FROM office_dallas.field_scorecards sc")) {
      return {
        rows: [
          {
            deal_id: DEAL,
            deal_name: "Arboretum at Lewisville",
            project_number: "DFW-4-19426-ak",
            week_of: "2026-07-27",
            total_score: 23,
            average_score: "2.3",
            rating: "corrective_action",
            form_version: 2,
            status: over.status ?? "corrective_action_open",
            pdf_r2_key: over.pdfR2Key === undefined ? `sc.${"a".repeat(64)}.v3.pdf` : over.pdfR2Key,
            pdf_render_version: over.pdfRenderVersion ?? 3,
            pdf_content_generation:
              over.pdfContentGeneration === undefined ? GENERATION : over.pdfContentGeneration,
            updated_at: over.updatedAt ?? GENERATION,
            corrective_action_oversight_opened_at: over.openedAt ?? null,
            corrective_action_oversight_closed_at: over.closedAt ?? null,
          },
        ],
      };
    }
    if (sql.includes("scorecard_corrective_actions ca")) return { rows: ITEMS };
    if (sql.includes("UPDATE office_dallas.field_scorecards")) {
      stampUpdates.push({ sql, params });
      return { rows: [] };
    }
    return { rows: [] };
  });
  return { query, stampUpdates };
}

function makeSend() {
  return vi.fn(async () => ({ success: true, messageId: "msg-1" }));
}

describe("handleScorecardCorrectiveActionOversightEmail", () => {
  it("sends the opened notice to the configured recipients", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    const [to, subject, html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(to).toEqual(["james@trockgc.com", "ops@trockgc.com"]);
    expect(subject).toContain("Corrective action opened");
    expect(subject).toContain("DFW-4-19426-ak");
    expect(html).toContain("Corrective Action Opened");
    expect(html).toContain("Re-inspect slab 2");
  });

  it("sends the completed notice with the corrective-action-bearing PDF attached", async () => {
    const { query } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 fake"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    const [, subject, html, options] = sendEmail.mock.calls[0] as unknown as [
      string[],
      string,
      string,
      { attachments?: Array<{ filename: string }> },
    ];
    expect(subject).toContain("Corrective action completed");
    expect(html).toContain("Corrective Action Completed");
    expect(options.attachments).toHaveLength(1);
    expect(options.attachments![0].filename).toBe(`field-scorecard-${SCORECARD}.pdf`);
  });

  it("refuses to attach a pre-v3 artifact, which would show the card WITHOUT the corrective action", async () => {
    // Attaching a v2 PDF to a "completed" email would show a scorecard with no corrective action on it —
    // exactly the defect this feature fixes. Better to send with no attachment and a CRM link.
    const { query } = makeQuery({ pdfRenderVersion: 2, status: "corrective_action_closed" });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 fake"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    expect(getPdf).not.toHaveBeenCalled();
    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { attachments?: unknown[] },
    ];
    expect(options.attachments).toBeUndefined();
  });

  it("degrades to a no-attachment send when the PDF object is unavailable", async () => {
    const { query } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => {
      throw new Error("NoSuchKey");
    });

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { attachments?: unknown[] },
    ];
    expect(options.attachments).toBeUndefined();
  });

  it("NEVER includes a corrective-action token or responder link", async () => {
    // The responder email carries a per-recipient token that AUTHORIZES answering. An oversight watcher must
    // never receive one — this is the invariant that makes a separate email mandatory over a CC.
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , html, options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { text: string },
    ];
    for (const body of [html, options.text]) {
      expect(body).not.toMatch(/token=/i);
      expect(body).not.toMatch(/corrective-actions\?/i);
      expect(body).not.toMatch(/trockcam:\/\//i);
    }
  });

  it("subtracts the cycle's responders from the oversight recipient list", async () => {
    // A superintendent who is also on FIELD_SCORECARD_EMAIL_RECIPIENTS gets "please fix this", not both.
    const { query } = makeQuery({}, [{ email: "JAMES@trockgc.com" }]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).toEqual(["ops@trockgc.com"]);
  });

  it("logs and returns without throwing when no recipients remain", async () => {
    // Supplementary notification: the responders were already told by their own job, so a dead-letter is noise.
    const { query } = makeQuery({}, [{ email: "james@trockgc.com" }, { email: "ops@trockgc.com" }]);
    const sendEmail = makeSend();
    const logger = makeLogger();

    await expect(
      handleScorecardCorrectiveActionOversightEmail(payload(), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger,
      }),
    ).resolves.toBeUndefined();

    expect(sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalled();
  });

  it("skips when the phase stamp is already set, so a retry does not double-send", async () => {
    const { query } = makeQuery({ openedAt: new Date("2026-07-27T12:00:00.000Z") });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("treats the two phases independently — an opened stamp does not suppress the closed notice", async () => {
    const { query } = makeQuery({ openedAt: new Date("2026-07-27T12:00:00.000Z"), closedAt: null, status: "corrective_action_closed" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("does NOT gate on the stored cycle nonce — a rotated nonce must not strand the notice", async () => {
    // The responder worker's self-repair path rotates corrective_action_cycle_nonce and re-enqueues itself.
    // A pending oversight job minted under the OLDER nonce must still send; gating on a nonce match here
    // would silently drop the opened notice. Dedup is the stamp, not the nonce.
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(
      payload({ cycleNonce: "00000000-0000-0000-0000-00000000dead" }),
      null,
      { query: query as never, sendEmail: sendEmail as never, env, logger: makeLogger() },
    );

    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("uses a phase- and cycle-scoped Resend idempotency key", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { idempotencyKey: string },
    ];
    expect(options.idempotencyKey).toBe(
      `corrective-action-oversight-office_dallas-${SCORECARD}-opened-cycle-${CYCLE}`,
    );
  });

  it("stamps only its own phase column", async () => {
    const { query, stampUpdates } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(stampUpdates).toHaveLength(1);
    expect(stampUpdates[0].sql).toContain("corrective_action_oversight_opened_at = NOW()");
    expect(stampUpdates[0].sql).not.toContain("corrective_action_oversight_closed_at");
  });

  it("does not stamp when the provider reports an unsuccessful send", async () => {
    const { query, stampUpdates } = makeQuery();
    const sendEmail = vi.fn(async () => ({ success: false, messageId: null }));

    await expect(
      handleScorecardCorrectiveActionOversightEmail(payload(), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger: makeLogger(),
      }),
    ).rejects.toThrow();

    expect(stampUpdates).toHaveLength(0);
  });

  it("skips an invalid payload without touching the database", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();
    const logger = makeLogger();

    for (const bad of [
      payload({ tenantSchema: "public; DROP TABLE users" }),
      payload({ scorecardId: "" }),
      payload({ phase: undefined }),
      payload({ phase: "bogus" as never }),
    ]) {
      await handleScorecardCorrectiveActionOversightEmail(bad, null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger,
      });
    }

    expect(query).not.toHaveBeenCalled();
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips a scorecard that no longer exists", async () => {
    const query = vi.fn(async () => ({ rows: [] }));
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("skips an 'opened' notice for a card that left the corrective-action state (no send, no stamp)", async () => {
    // Both jobs run ~120s after enqueue. An edit lifting the card above band walks it to `submitted` and
    // deletes every item, so an unguarded job would announce a corrective action that no longer exists.
    const { query, stampUpdates } = makeQuery({ status: "submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("skips an 'opened' notice for a card already CLOSED before the job ran", async () => {
    // A single-item corrective action answered in-app inside the window. An unguarded job would announce
    // it as open while listing every item Resolved, immediately followed by the completed notice.
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("skips a 'closed' notice for a card that has REOPENED", async () => {
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_open" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("does NOT attach a v3 PDF that predates the corrective-action response", async () => {
    // The post-commit refresh is best-effort; an R2 blip leaves a v3 artifact rendered BEFORE the response,
    // which still shows every item Open. Attaching that under "Corrective Action Completed" would be the
    // very defect this feature fixes, one level down.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      pdfContentGeneration: new Date("2026-07-27T13:00:00.000Z"),
      updatedAt: new Date("2026-07-27T14:00:00.000Z"),
    });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 stale"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    expect(getPdf).not.toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { attachments?: unknown[] },
    ];
    expect(options.attachments).toBeUndefined();
  });

  it("does NOT attach a pre-migration artifact with a null rendered generation", async () => {
    const { query } = makeQuery({ status: "corrective_action_closed", pdfContentGeneration: null });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    expect(getPdf).not.toHaveBeenCalled();
  });

  it("counts only renderable response photos, excluding soft-deleted ones", async () => {
    // Three-way consistency: the PDF loader and the CRM item read both filter on files.is_active /
    // deleted_at. Counting soft-deleted rows here would make the email say "3 photos" while the attached
    // PDF and the CRM both show 2.
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const itemsSql = query.mock.calls
      .map((call) => call[0] as string)
      .find((text) => text.includes("scorecard_corrective_actions ca"))!;
    expect(itemsSql).toContain("f.is_active = TRUE");
    expect(itemsSql).toContain("f.deleted_at IS NULL");
  });
});
