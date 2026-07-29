import { describe, expect, it, vi } from "vitest";
import {
  handleScorecardCorrectiveActionOversightEmail,
  type ScorecardCorrectiveActionOversightEmailPayload,
} from "../../src/jobs/scorecard-corrective-action-oversight-email.js";

const SCORECARD = "11111111-1111-1111-1111-111111111111";
const DEAL = "22222222-2222-2222-2222-222222222222";
const CYCLE = "99999999-9999-9999-9999-999999999999";
const OVERSIGHT_CYCLE = "88888888-8888-8888-8888-888888888888";
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
    oversightCycle: OVERSIGHT_CYCLE,
    ...over,
  };
}

const ITEMS = [
  {
    item_type: "action_item",
    item_ref: "0",
    item_label: "Re-inspect slab 2",
    // A REAL post-0202 status. This fixture said "resolved" — a value migration 0202 renamed away — and the
    // renderer compared against the same dead string, so several assertions passed while testing a state the
    // database can no longer produce.
    status: "approved",
    responder_name: "Sam Super",
    responder_email: "pat@trockgc.com",
    // Deliberately an evening-CT instant whose UTC CALENDAR DATE is the following day: 8:30 PM CDT on Jul 27
    // is Jul 28 in UTC. Any renderer that slices the ISO string dates this response to the wrong day.
    responded_at: new Date("2026-07-28T01:30:00.000Z"),
    response_comment: "Re-poured and cured.",
    photo_count: 2,
  },
  {
    item_type: "critical_deficiency",
    item_ref: "missed_hold_point",
    item_label: "Missed hold point",
    status: "open",
    responder_name: null,
    responder_email: null,
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
  /** false => the guarded stamp UPDATE matches no row (superseded mid-send). */
  stampMatches?: boolean;
  storedNonce?: string | null;
  storedOversightCycle?: string | null;
  /** Values the FINAL pre-delivery revalidation sees, modelling a change mid-preparation. */
  revalidateOversightCycle?: string | null;
  revalidatePhaseStamp?: Date | null;
  revalidateStatus?: string;
  /** updated_at the delivery-time recheck sees — an edit landing during preparation. */
  revalidateUpdatedAt?: Date;
  /** Generation the POST-FETCH artifact recheck sees, modelling an edit during the R2 read. */
  postFetchGeneration?: Date | null;
  /** Key the POST-FETCH recheck sees — a replacement artifact published during the R2 read. */
  postFetchKey?: string | null;
  /** [] => the card became non-browsable during preparation. */
  revalidateRows?: unknown[];
  /** [] => the browsable/active gate filtered the row out entirely. */
  scorecardRows?: unknown[];
  /** The card's CURRENT action-item list — what the corrective-action rows are ordered against. */
  actionItems?: string[];
  /** Non-null => the approver has already been told about this cycle. */
  approvalRequestedAt?: Date | null;
  /** Override the corrective-action rows (e.g. two action items, to assert ordering). */
  items?: unknown[];
  /**
   * Does the scorecard ROW still exist when the browsable gate misses? This is the difference between a
   * deleted card (nothing to notify, complete the job) and a merely-hidden project (restorable, so retry).
   * Defaults to false = gone.
   */
  rowAlive?: boolean;
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
    // The alive probe run when the browsable gate misses — matched on SELECT 1, which no other query uses.
    if (sql.includes("SELECT 1 FROM")) return { rows: over.rowAlive ? [{ "?column?": 1 }] : [] };
    // The final pre-delivery revalidation — a narrow SELECT, distinct from the snapshot join above.
    // The POST-FETCH artifact recheck — narrower than both the snapshot and the delivery revalidation.
    if (sql.includes("SELECT pdf_r2_key, pdf_content_generation")) {
      return {
        rows: [
          {
            pdf_r2_key:
              over.postFetchKey === undefined
                ? (over.pdfR2Key === undefined ? `sc.${"a".repeat(64)}.v4.pdf` : over.pdfR2Key)
                : over.postFetchKey,
            pdf_content_generation:
              over.postFetchGeneration === undefined
                ? (over.pdfContentGeneration === undefined ? GENERATION : over.pdfContentGeneration)
                : over.postFetchGeneration,
            updated_at: over.updatedAt ?? GENERATION,
          },
        ],
      };
    }
    if (sql.includes("AS phase_stamp")) {
      if (over.revalidateRows) return { rows: over.revalidateRows };
      return {
        rows: [
          {
            corrective_action_oversight_cycle:
              over.revalidateOversightCycle === undefined
                ? (over.storedOversightCycle === undefined ? OVERSIGHT_CYCLE : over.storedOversightCycle)
                : over.revalidateOversightCycle,
            status: over.revalidateStatus ?? over.status ?? "corrective_action_open",
            updated_at: over.revalidateUpdatedAt ?? over.updatedAt ?? GENERATION,
            phase_stamp: over.revalidatePhaseStamp ?? null,
          },
        ],
      };
    }
    if (sql.includes("FROM office_dallas.field_scorecards sc")) {
      if (over.scorecardRows) return { rows: over.scorecardRows };
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
            action_items: over.actionItems ?? ["Re-inspect slab 2"],
            pdf_r2_key: over.pdfR2Key === undefined ? `sc.${"a".repeat(64)}.v4.pdf` : over.pdfR2Key,
            pdf_render_version: over.pdfRenderVersion ?? 4,
            pdf_content_generation:
              over.pdfContentGeneration === undefined ? GENERATION : over.pdfContentGeneration,
            updated_at: over.updatedAt ?? GENERATION,
            corrective_action_cycle_nonce: over.storedNonce === undefined ? CYCLE : over.storedNonce,
            corrective_action_oversight_cycle:
              over.storedOversightCycle === undefined ? OVERSIGHT_CYCLE : over.storedOversightCycle,
            corrective_action_oversight_opened_at: over.openedAt ?? null,
            corrective_action_oversight_closed_at: over.closedAt ?? null,
            corrective_action_approval_requested_at: over.approvalRequestedAt ?? null,
          },
        ],
      };
    }
    if (sql.includes("scorecard_corrective_actions ca")) return { rows: over.items ?? ITEMS };
    if (sql.includes("UPDATE office_dallas.field_scorecards")) {
      stampUpdates.push({ sql, params });
      // rowCount 0 models a guarded UPDATE that matched nothing (stamp already set, or the cycle moved on).
      return { rows: [], rowCount: over.stampMatches === false ? 0 : 1 };
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
    expect(subject).toContain("Corrective action approved");
    expect(html).toContain("Corrective Action Approved");
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

  it("scopes the STAMP to the payload cycle, so a superseded send cannot mark a newer cycle notified", async () => {
    // Greptile P1: cycle A's send is in flight; a reopen clears the stamp and mints nonce B. Without a nonce
    // clause on the stamp, A's worker writes the stamp and cycle B's queued job then sees it set and skips —
    // oversight is never told about the reopen, permanently, because nothing clears it again until the NEXT
    // reopen. The SKIP guard stays nonce-free on purpose; only this write is cycle-aware.
    const { query, stampUpdates } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(stampUpdates).toHaveLength(1);
    // Scoped to the OVERSIGHT marker — the same signal the send decision used. Scoping it to the shared
    // nonce instead meant a self-repair rotation let the send happen but the stamp match nothing.
    expect(stampUpdates[0].sql).toContain("corrective_action_oversight_cycle = $2::uuid");
    expect(stampUpdates[0].sql).toContain("corrective_action_oversight_cycle IS NULL");
    expect(stampUpdates[0].params).toEqual([SCORECARD, OVERSIGHT_CYCLE]);
  });

  it("logs rather than throwing when the stamp is superseded mid-send", async () => {
    // The email did go out and accurately described the older cycle; the current cycle's own job still has a
    // null stamp and will notify. Throwing here would retry a send that already happened.
    const { query } = makeQuery({ stampMatches: false });
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

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Sent but not stamped"),
      expect.anything(),
    );
  });

  it("refuses to attach a v3-stamped row whose stored key is not a content-addressed artifact", async () => {
    // The version column alone is not proof the stored OBJECT matches it. The sibling field-scorecard email
    // validates the digest + revision suffix for the same reason; the two jobs must agree on what counts as
    // a current artifact.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      pdfR2Key: "office_dallas/deals/DFW-1/documents/scorecards/legacy.pdf",
    });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 legacy"));

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

  it("gates on the ACTIVE, BROWSABLE scorecard, not the id alone", async () => {
    // This job runs ~120s after enqueue. A soft-delete or a move to Lost does not change the corrective-action
    // status, so an id-only lookup would still send a notice whose CRM link 404s.
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const snapshotSql = query.mock.calls
      .map((call) => call[0] as string)
      .find((text) => text.includes("FROM office_dallas.field_scorecards sc"))!;
    expect(snapshotSql).toContain("sc.is_active = true");
    expect(snapshotSql).toContain("JOIN office_dallas.deals d");
    expect(snapshotSql).toContain("pipeline_stage_config psc");
    // The renumber must be a SINGLE pass: $1 stays the scorecard, the slug arrays land on $2/$3. A cascading
    // replace would collapse both arrays onto $3 and silently drop every terminal-stage card.
    expect(snapshotSql).toContain("$2::text[]");
    expect(snapshotSql).toContain("$3::text[]");
    expect(snapshotSql).not.toContain("$4::text[]");
  });

  it("sends nothing and stamps nothing for a DELETED scorecard, and completes the job", async () => {
    const { query, stampUpdates } = makeQuery({ scorecardRows: [], rowAlive: false });
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

  it("REGRESSION: THROWS for a live card whose project is merely hidden, instead of losing the notice", async () => {
    // A deleted card and a temporarily-hidden project look identical at the browsable gate but are opposites
    // for the queue. Returning in both cases completes the job with the phase stamp still null — and NOTHING
    // re-enqueues it, because the only enqueue sites are the corrective-action open/close transitions.
    // Restoring the deal from archive, or moving it out of Lost, fires neither. So the card that was hidden
    // for the ~120s until this job ran would lose its oversight notice permanently and silently.
    const { query, stampUpdates } = makeQuery({ scorecardRows: [], rowAlive: true });
    const sendEmail = makeSend();

    await expect(
      handleScorecardCorrectiveActionOversightEmail(payload(), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/not browsable/i);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("a marker-less job asserts the cycle is STILL marker-less before stamping", async () => {
    // Otherwise a reopen that mints a marker and clears the stamps would be stamped by this stale job on id
    // alone, and the new cycle's job would then skip its notice.
    const { query, stampUpdates } = makeQuery({ storedOversightCycle: null });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ oversightCycle: undefined }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(stampUpdates[0].sql).toContain("corrective_action_oversight_cycle IS NULL");
    expect(stampUpdates[0].params).toEqual([SCORECARD]);
  });

  it("names who was asked to respond in the opened notice", async () => {
    const { query } = makeQuery({}, [
      { email: "sam@trock.com", name: "Sam Super", role: "superintendent" } as never,
    ]);
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
    expect(html).toContain("Sam Super");
    expect(html).toContain("Superintendent");
    expect(options.text).toContain("Sam Super");
    // Names only — never a token or a responder link.
    expect(html).not.toMatch(/token=/i);
  });

  it("refuses to SEND when a newer cycle superseded this job, even if it was already claimed", async () => {
    // Retiring queued jobs at the reopen misses a job the worker had already claimed, and the delivery stamp
    // guard blocks only the stamp — never the send. This pre-send check is what closes that window.
    const { query, stampUpdates } = makeQuery({ storedOversightCycle: "77777777-7777-7777-7777-777777777777" });
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

  it("does NOT gate on the oversight marker when either side is absent (pre-0201 rows, in-flight jobs)", async () => {
    const { query } = makeQuery({ storedOversightCycle: null });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("still sends when only the SHARED cycle nonce moved — that is responder self-repair, not supersession", async () => {
    // The distinction the dedicated marker exists to draw. Gating on the shared nonce here would strand the
    // notice; the oversight marker is unchanged, so this job is still the current one.
    const { query } = makeQuery({ storedNonce: "11111111-1111-1111-1111-111111111111" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
  });

  it("names only responders with a DELIVERABLE email", async () => {
    // The resolution query returns a row whose email is missing or malformed, but the responder handler skips
    // exactly those — naming them would tell oversight someone "has been asked" when nothing reached them.
    const { query } = makeQuery({}, [
      { email: "sam@trock.com", name: "Sam Super", role: "superintendent" } as never,
      { email: null, name: "Unreachable Pat", role: "project_manager" } as never,
      { email: "not-an-email", name: "Malformed Max", role: "project_manager" } as never,
    ]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(html).toContain("Sam Super");
    expect(html).not.toContain("Unreachable Pat");
    expect(html).not.toContain("Malformed Max");
  });

  it("revalidates the marker immediately before delivery, not just at the snapshot", async () => {
    // TOCTOU: the recipient/item queries and the R2 attachment fetch leave a real window between the
    // snapshot check and the send. A reopen landing there would otherwise be delivered against.
    const { query, stampUpdates } = makeQuery({
      revalidateOversightCycle: "77777777-7777-7777-7777-777777777777",
    });
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

  it("skips if another run stamped this phase while the notice was being prepared", async () => {
    const { query, stampUpdates } = makeQuery({ revalidatePhaseStamp: new Date("2026-07-27T12:00:00.000Z") });
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

  it("does not claim anyone was asked when NO responder is reachable", async () => {
    // The deliverable-email filter empties the list; the old fallback still asserted the super and PM "have
    // been asked", which is precisely the false assurance the filter exists to remove — in this case the
    // responder worker sends nothing at all.
    const { query } = makeQuery({}, [
      { email: null, name: "Unreachable Pat", role: "project_manager" } as never,
    ]);
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
      expect(body).not.toMatch(/have been asked to document/i);
      expect(body).toMatch(/could be reached by email/i);
      expect(body).toMatch(/nobody has been asked/i);
    }
  });

  it("skips when the card changed PHASE while the notice was being prepared", async () => {
    // The marker does not rotate on ordinary transitions — the last item being answered moves the card
    // open -> submitted. Without a status re-check an obsolete "Corrective Action Opened" still goes out.
    const { query, stampUpdates } = makeQuery({ revalidateStatus: "corrective_action_closed" });
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

  it("stamps against the OVERSIGHT marker, not the shared nonce", async () => {
    // Sending on one signal and stamping on another was self-contradictory: when self-repair rotated the
    // shared nonce the handler still sent (marker unchanged) but the stamp matched no row, leaving the
    // durable dedup guard permanently unset.
    const { query, stampUpdates } = makeQuery({ storedNonce: "11111111-1111-1111-1111-111111111111" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledOnce();
    expect(stampUpdates).toHaveLength(1);
    expect(stampUpdates[0].sql).toContain("corrective_action_oversight_cycle = $2::uuid");
    expect(stampUpdates[0].sql).not.toContain("corrective_action_cycle_nonce");
    expect(stampUpdates[0].params).toEqual([SCORECARD, OVERSIGHT_CYCLE]);
  });

  it("office-qualifies the CRM link so a cross-office watcher lands in the right tenant", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(html).toContain("tab=scorecards&amp;officeId=00000000-0000-0000-0000-0000000000f1");
  });

  it("drops the attachment when the card changed WHILE the PDF was being fetched", async () => {
    // The R2 read is the slowest step. An edit landing during it — even one that leaves the lifecycle
    // CLOSED, like a note or signature change — advances updated_at while the old key stays in place, so
    // marker, status and phase stamp all still match. Only re-reading the generation catches it.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      postFetchGeneration: new Date("2026-07-27T13:00:00.000Z"),
      updatedAt: new Date("2026-07-27T14:00:00.000Z"),
    });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 stale-by-now"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    // It still sends — the notice matters more than the attachment — but WITHOUT stale bytes.
    expect(getPdf).toHaveBeenCalled();
    expect(sendEmail).toHaveBeenCalledOnce();
    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { attachments?: unknown[] },
    ];
    expect(options.attachments).toBeUndefined();
  });

  it("drops the attachment when a REPLACEMENT artifact was published during the fetch", async () => {
    // Generations alone are not enough: if the background finalizer publishes a new artifact mid-fetch, the
    // row describes the NEW object and its generations match — while the buffer in hand came from the OLD
    // key. Content-addressed keys make this an exact test.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      postFetchKey: `sc.${"b".repeat(64)}.v3.pdf`,
    });
    const sendEmail = makeSend();
    const getPdf = vi.fn(async () => Buffer.from("%PDF-1.4 from the old key"));

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: getPdf as never,
      env,
      logger: makeLogger(),
    });

    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[], string, string, { attachments?: unknown[] },
    ];
    expect(options.attachments).toBeUndefined();
  });

  it("does not deliver when the card was DELETED during preparation", async () => {
    // Soft-deleting the scorecard or archiving its deal changes neither the lifecycle status nor the cycle
    // marker, so only re-applying the browsable predicate catches it. The CRM link would 404.
    const { query, stampUpdates } = makeQuery({ revalidateRows: [], rowAlive: false });
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

  it("throws when the card is still live but its project went non-browsable during preparation", async () => {
    // Same triage as the snapshot gate, at the delivery gate: restorable => retry, not silent completion.
    const { query, stampUpdates } = makeQuery({ revalidateRows: [], rowAlive: true });
    const sendEmail = makeSend();

    await expect(
      handleScorecardCorrectiveActionOversightEmail(payload(), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/not browsable/i);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("re-applies the active + browsable predicate in the delivery-time query", async () => {
    const { query } = makeQuery();
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const revalidateSql = query.mock.calls
      .map((call) => call[0] as string)
      .find((text) => text.includes("AS phase_stamp"))!;
    expect(revalidateSql).toContain("sc.is_active = true");
    expect(revalidateSql).toContain("pipeline_stage_config psc");
  });

  it("keeps a responder-watcher on the CLOSED notice — there is no responder-facing completion job", async () => {
    // Subtracting responders makes sense for `opened` (they already got "please fix this"). Applying it to
    // `closed` silently drops the completion notice for a watcher who happens to be a current super/PM, and
    // nothing else tells them.
    const { query } = makeQuery({ status: "corrective_action_closed" }, [
      { email: "james@trockgc.com", name: "James Helms", role: "superintendent" } as never,
    ]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).toContain("james@trockgc.com");
  });

  it("still subtracts a responder-watcher from the OPENED notice", async () => {
    const { query } = makeQuery({}, [
      { email: "james@trockgc.com", name: "James Helms", role: "superintendent" } as never,
    ]);
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

  it("REGRESSION: THROWS when the scorecard changed while the notice was being composed", async () => {
    // The BODY is built from an item snapshot taken before the recipient/item queries and the R2 read. An
    // edit removing a settled item in that window moves neither the status nor the marker, so the email
    // would describe a responder, comment and photo count for something that no longer exists.
    //
    // It must THROW, not skip. The drift that reaches this branch is typically ONE item being answered while
    // others remain open: updated_at advances, the status stays `corrective_action_open`, the marker does not
    // rotate — so nothing is enqueued. Skipping would complete the only opened-notice job with its stamp null
    // and no successor, losing the notification permanently. The retry rebuilds against the settled state.
    const { query, stampUpdates } = makeQuery({
      revalidateUpdatedAt: new Date("2026-07-27T18:00:00.000Z"),
    });
    const sendEmail = makeSend();

    await expect(
      handleScorecardCorrectiveActionOversightEmail(payload(), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env,
        logger: makeLogger(),
      }),
    ).rejects.toThrow(/went stale/i);

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("renders a response time with the TIME OF DAY, not just a UTC calendar date", async () => {
    // A SUBMITTED item — attribution for an approved one belongs to the approver, tested separately.
    // responded_at is a timestamp. Truncating it to a date made every action answered on the same day look
    // simultaneous in what is meant to be the audit trail, and ISO-slicing it silently reported UTC — so an
    // evening CT response was dated to the following day.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      items: [{ ...ITEMS[0], status: "submitted" }],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    // ITEMS carries 2026-07-28T01:30Z = 8:30 PM CDT on Jul 27. The old ISO slice printed "2026-07-28",
    // reporting the response on a day the responder had already finished.
    expect(html).toMatch(/Jul 27, 2026, 8:30\s?PM CDT/);
    expect(html).not.toContain("2026-07-28");
  });

  it("REGRESSION: orders items by the CURRENT action-item list, not the preserved item_ref", async () => {
    // Reconciliation preserves an action item's original item_ref across edits, so after a reorder the ref
    // order is the OLD order. This email sits beside the PDF it attaches and the deal thread it links to;
    // listing the same record in a contradictory sequence makes the reader distrust all three.
    const twoActionItems = [
      { ...ITEMS[0], item_ref: "0", item_label: "Item A" },
      { ...ITEMS[0], item_ref: "1", item_label: "Item B" },
    ];
    const { query } = makeQuery({
      items: twoActionItems,
      // The editor swapped them; the rows keep their original refs.
      actionItems: ["Item B", "Item A"],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    // Ordering by item_ref would list Item A first, contradicting the card.
    expect(html.indexOf("Item B")).toBeLessThan(html.indexOf("Item A"));
  });

  it("names the responder by EMAIL when they have no display name", async () => {
    // A session responder with no first/last name stores a null responder_name but a non-null email. Without
    // the fallback the notice reports when a fix landed but not who filed it.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      items: [{ ...ITEMS[0], status: "submitted", responder_name: null }],
    });
    const sendEmail = makeSend();
    ITEMS[0].responder_name = null;
    try {
      await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
        env,
        logger: makeLogger(),
      });
      const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
      expect(html).toContain("pat@trockgc.com");
    } finally {
      ITEMS[0].responder_name = "Sam Super";
    }
  });

  it("REGRESSION: bounds each quoted comment instead of pasting 5,000 characters into the body", async () => {
    // The response API accepts up to 5,000 characters per item and a card can carry 50 action items plus
    // deficiencies. Quoting every comment in full can produce hundreds of kilobytes of body before escaping
    // expands it further — and mail clients clip the END of a long body, which is where the CTA lives.
    const longComment = "We re-poured the slab and cured it under blankets overnight. ".repeat(120);
    const { query } = makeQuery({
      status: "corrective_action_closed",
      items: [{ ...ITEMS[0], response_comment: longComment }],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, , html, options] = sendEmail.mock.calls[0] as unknown as [string[], string, string, { text: string }];
    expect(html).toContain("full comment in the CRM");
    expect(options.text).toContain("full comment in the CRM");
    // Bounded, not merely shortened: the body must not scale with the comment.
    expect(html.length).toBeLessThan(longComment.length);
    expect(options.text).not.toContain(longComment);
  });

  it("describes responders as ASSIGNED, not as already notified", async () => {
    // This job and the responder job share a delay and the queue runs a claimed batch concurrently, so this
    // notice can go out FIRST — and the responder send can dead-letter. Nothing here reads a delivery
    // record, so asserting they "have been asked" is an assurance the handler cannot support.
    const { query } = makeQuery({}, [
      { email: "sam@trockgc.com", name: "Sam Super", role: "superintendent" } as never,
    ]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload(), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(html).toContain("is assigned to document a fix");
    expect(html).not.toContain("has been asked to document a fix");
  });

  it("REGRESSION: bounds the item LABEL too, not only the comment", async () => {
    // Parsing caps the NUMBER of action items (50), never each item's length. Bounding only the comments
    // left a card with several long dictated labels able to produce an arbitrarily large body on its own.
    const longLabel = "Re-inspect the north elevation framing connection detail and log it. ".repeat(60);
    const { query } = makeQuery({
      status: "corrective_action_closed",
      items: [{ ...ITEMS[0], item_label: longLabel, response_comment: "Done." }],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, , html, options] = sendEmail.mock.calls[0] as unknown as [string[], string, string, { text: string }];
    expect(html).not.toContain(longLabel);
    expect(options.text).not.toContain(longLabel);
    expect(html.length).toBeLessThan(longLabel.length);
  });

  const approverEnv = { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as unknown as NodeJS.ProcessEnv;

  it("REGRESSION: an awaiting_approval job actually SENDS — it used to be dropped by the payload guard", async () => {
    // enqueueCorrectiveActionApprovalRequested has always enqueued this phase; the worker's union rejected
    // it, so the job completed successfully having notified nobody. A silently-dropped notification is worse
    // than a dead-letter, because nothing surfaces it — the queue reports success.
    const { query } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    expect(sendEmail).toHaveBeenCalledTimes(1);
    const [to, subject] = sendEmail.mock.calls[0] as unknown as [string[], string];
    expect(to).toEqual(["james@trockgc.com"]);
    expect(subject).toMatch(/awaiting your approval/i);
  });

  it("addresses the APPROVER list, never the oversight watcher list", async () => {
    // Different question, different config. FIELD_SCORECARD_EMAIL_RECIPIENTS is who WATCHES;
    // QC_APPROVER_EMAILS is who can ACT. Asking a watcher to approve sends them to a 403.
    const { query } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).not.toContain("ops@trockgc.com");
  });

  it("does NOT subtract responders from the approver list", async () => {
    // The subtraction exists so a super does not get "someone must fix this" on top of "please fix this".
    // An approver who also happens to be a super on this card still has to be asked to approve it.
    const { query } = makeQuery({ status: "corrective_action_submitted" }, [
      { email: "james@trockgc.com", name: "James Helms", role: "superintendent" } as never,
    ]);
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    const [to] = sendEmail.mock.calls[0] as unknown as [string[]];
    expect(to).toEqual(["james@trockgc.com"]);
  });

  it("stamps its OWN column, so it cannot suppress the opened or completed notice", async () => {
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    expect(stampUpdates).toHaveLength(1);
    expect(stampUpdates[0].sql).toContain("corrective_action_approval_requested_at");
    expect(stampUpdates[0].sql).not.toContain("oversight_opened_at");
    expect(stampUpdates[0].sql).not.toContain("oversight_closed_at");
  });

  it("skips a card that has LEFT the approver queue before the job ran", async () => {
    // Same send-time state guard the other phases apply: an approver who acted within the ~120s delay must
    // not then receive "awaiting your approval" for something already approved.
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("does not re-ask an approver already told about this cycle", async () => {
    const { query, stampUpdates } = makeQuery({
      status: "corrective_action_submitted",
      approvalRequestedAt: new Date("2026-07-28T12:00:00.000Z"),
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: approverEnv,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("logs and returns when QC_APPROVER_EMAILS is unset — nobody can approve, so nobody is asked", async () => {
    // Matches the API, which 403s everyone when the list is empty. Not an error: a dead-letter here would be
    // noise about a misconfiguration the API already reports the moment anyone tries to act.
    const { query, stampUpdates } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "" } as unknown as NodeJS.ProcessEnv,
      logger: makeLogger(),
    });

    expect(sendEmail).not.toHaveBeenCalled();
    expect(stampUpdates).toHaveLength(0);
  });

  it("says APPROVED, not merely documented, on the completion notice", async () => {
    // Under the gate the card reaches this state only on the approver's acceptance. "Complete. Every flagged
    // item has been documented" describes the PRE-gate behaviour and tells oversight the wrong thing about
    // what actually happened — documented is not accepted.
    const { query } = makeQuery({ status: "corrective_action_closed" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, subject, html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(subject).toMatch(/approved/i);
    expect(html).toMatch(/has been <strong>approved<\/strong>/i);
    expect(html).not.toMatch(/Every flagged item has been documented\./i);
  });

  it("REGRESSION: renders every post-0202 item state, not a value the schema no longer has", async () => {
    // The renderer compared status against "resolved", which migration 0202 RENAMED to "submitted". Nothing
    // errored — the comparison simply never matched, so every item printed as "Open" with no responder, no
    // comment and no photo count. That strips the approval notice of exactly what the approver needs to
    // decide, and it is invisible in review because the code and the old fixture agreed on a dead string.
    const states = [
      { status: "submitted", expect: "Awaiting approval" },
      { status: "approved", expect: "Approved" },
      { status: "rejected", expect: "Sent back" },
      { status: "open", expect: "Open" },
    ];

    for (const state of states) {
      const { query } = makeQuery({
        status: "corrective_action_submitted",
        items: [{ ...ITEMS[0], status: state.status, item_label: `Item ${state.status}` }],
      });
      const sendEmail = makeSend();

      await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
        query: query as never,
        sendEmail: sendEmail as never,
        env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as unknown as NodeJS.ProcessEnv,
        logger: makeLogger(),
      });

      const [, , html, options] = sendEmail.mock.calls[0] as unknown as [
        string[],
        string,
        string,
        { text: string },
      ];
      expect(html).toContain(state.expect);
      expect(options.text).toContain(state.expect);
    }
  });

  it("shows WHO answered and what they said on an answered item, which is the point of the notice", async () => {
    const { query } = makeQuery({
      status: "corrective_action_submitted",
      items: [{ ...ITEMS[0], status: "submitted" }],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as unknown as NodeJS.ProcessEnv,
      logger: makeLogger(),
    });

    const [, , html] = sendEmail.mock.calls[0] as unknown as [string[], string, string];
    expect(html).toContain("Sam Super");
    expect(html).toContain("Re-poured and cured.");
    expect(html).toContain("2 photos");
  });

  it("REGRESSION: attributes an APPROVED item to the approver, not the responder", async () => {
    // The item row's responder columns describe the SUBMISSION. Using them for an approved item made the
    // audit-facing notice read "Approved — <responder> · <their submission time>", i.e. as though the
    // responder signed off their own work. The verdict and its actor live on the thread.
    const { query } = makeQuery({
      status: "corrective_action_closed",
      items: [
        {
          ...ITEMS[0],
          status: "approved",
          responder_name: "Sam Super",
          approved_by: "James Helms",
          approved_at: new Date("2026-07-29T15:00:00.000Z"),
        },
      ],
    });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "closed" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env,
      logger: makeLogger(),
    });

    const [, , html, options] = sendEmail.mock.calls[0] as unknown as [
      string[],
      string,
      string,
      { text: string },
    ];
    expect(html).toContain("James Helms");
    expect(options.text).toContain("James Helms");
    // The approval line carries the VERDICT time, not the submission time.
    expect(html).toMatch(/Jul 29, 2026/);
  });

  it("REGRESSION: attaches the PDF to the awaiting-approval notice, not only the completion one", async () => {
    // The approver is being asked to JUDGE documented work. A link with no record forces them into the CRM to
    // see the very thing the email is about — and the enqueue path already delays specifically so the
    // refreshed artifact exists by the time this job runs.
    const { query } = makeQuery({ status: "corrective_action_submitted" });
    const sendEmail = makeSend();

    await handleScorecardCorrectiveActionOversightEmail(payload({ phase: "awaiting_approval" }), null, {
      query: query as never,
      sendEmail: sendEmail as never,
      getPdf: (async () => Buffer.from("%PDF-1.4")) as never,
      env: { ...env, QC_APPROVER_EMAILS: "james@trockgc.com" } as unknown as NodeJS.ProcessEnv,
      logger: makeLogger(),
    });

    const [, , , options] = sendEmail.mock.calls[0] as unknown as [
      string[],
      string,
      string,
      { attachments?: unknown[] },
    ];
    expect(options.attachments).toHaveLength(1);
  });
});
