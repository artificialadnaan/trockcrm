import { beforeEach, describe, expect, it, vi } from "vitest";

const query = vi.fn();
const release = vi.fn();

vi.mock("../../../src/db.js", () => ({
  pool: {
    connect: vi.fn(async () => ({ query, release })),
  },
}));

const { ingestBidBoardRows } = await import("../../../src/modules/bid-board-sync/service.js");

describe("Bid Board sync — empties-only estimator preservation (Codex #741 P2)", () => {
  beforeEach(() => {
    query.mockReset();
    release.mockReset();
    delete process.env.BID_BOARD_ESTIMATOR_USER_MAP;
  });

  it("logs the preserved estimator id (and the ignored incoming id) when the COALESCE keeps the existing value", async () => {
    const OLD_ID = "11111111-1111-4111-8111-111111111111"; // already on the deal (manual correction)
    const NEW_ID = "22222222-2222-4222-8222-222222222222"; // resolved-but-ignored Bid Board mapping

    // Configure the map so "Alex Koch" resolves to NEW_ID, and make NEW_ID an active user so it is
    // the value sync WOULD have written (not a null degrade). The matched deal already has OLD_ID,
    // so the SET ... = COALESCE(estimator_user_id, $16) keeps OLD_ID and drops NEW_ID on the floor.
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": NEW_ID });

    query.mockImplementation(async (sql: string) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback") return { rows: [], rowCount: 0 };
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      // System actor lookup (joins offices) vs the active-user set (plain users select).
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [{ id: NEW_ID }], rowCount: 1 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas",
              estimator_user_id: OLD_ID,
              bid_board_estimator: "Someone Else",
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      // No target stage -> stage writeback is skipped; the deal UPDATE is a no-op. The preserve
      // log fires at resolution time, before either of those run.
      return { rows: [], rowCount: 0 };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ingestBidBoardRows({
        office_slug: "dallas",
        rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
      });
      const logged = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(
        logged.some(
          (m) => m.includes("Preserved existing estimator_user_id") && m.includes(OLD_ID) && m.includes(NEW_ID)
        )
      ).toBe(true);
    } finally {
      warnSpy.mockRestore();
    }
  });

  it("does NOT log a preserved estimator when the deal had no estimator (sync writes the incoming id)", async () => {
    const NEW_ID = "22222222-2222-4222-8222-222222222222";
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": NEW_ID });

    query.mockImplementation(async (sql: string) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback") return { rows: [], rowCount: 0 };
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [{ id: NEW_ID }], rowCount: 1 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas",
              estimator_user_id: null, // empty -> sync fills it; nothing is preserved/ignored
              bid_board_estimator: null,
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      await ingestBidBoardRows({
        office_slug: "dallas",
        rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
      });
      const logged = warnSpy.mock.calls.map((c) => String(c[0]));
      expect(logged.some((m) => m.includes("Preserved existing estimator_user_id"))).toBe(false);
    } finally {
      warnSpy.mockRestore();
    }
  });

  // The audit mirror must reflect the EFFECTIVE post-COALESCE estimator value, not the ignored
  // incoming one. Without the fix the mirror logged {from: A, to: B} for a value that was preserved,
  // i.e. it falsely claimed the manual estimator A was overwritten by B (Codex #741 audit corruption).
  it("does NOT record an estimator overwrite in the audit field-changes when an existing estimator is preserved", async () => {
    const OLD_ID = "11111111-1111-4111-8111-111111111111"; // manual estimator already on the deal
    const NEW_ID = "22222222-2222-4222-8222-222222222222"; // Bid Board mapping that is resolved-but-dropped
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": NEW_ID });

    const auditMirrorChanges: Array<Record<string, { from: unknown; to: unknown }>> = [];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback" || s.startsWith("savepoint") || s.startsWith("release") || s.startsWith("rollback to")) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [{ id: NEW_ID }], rowCount: 1 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas (old name)", // differs from incoming -> the deal UPDATE fires
              estimator_user_id: OLD_ID,
              bid_board_estimator: "Someone Else",
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      // Deal mirror UPDATE: report a real change (name) so the audit mirror runs. The RETURNING
      // estimator_user_id is OLD_ID — the empties-only COALESCE preserved the manual estimator.
      if (s.includes("update office_dallas.deals")) {
        return { rows: [{ id: "deal-9", name: "Palm Villas", deal_number: "D-1", project_number: null, estimator_user_id: OLD_ID }], rowCount: 1 };
      }
      // Capture the mirror audit field-changes ($12 = filtered field changes, $14 = metadata).
      if (s.includes("insert into") && s.includes("audit_log")) {
        const changes = params?.[11] ? JSON.parse(String(params[11])) : null;
        const meta = params?.[13] ? JSON.parse(String(params[13])) : null;
        if (changes && meta?.source === "bid_board_mirror") auditMirrorChanges.push(changes);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
    });

    // A mirror audit row was written (the name changed), but it must NOT claim an estimator overwrite.
    expect(auditMirrorChanges.length).toBeGreaterThan(0);
    for (const changes of auditMirrorChanges) {
      // No {from: OLD, to: NEW} overwrite, and the preserved field collapses to from==to so it is
      // filtered out of the audit entirely.
      expect(changes.estimatorUserId).toBeUndefined();
    }
  });

  it("DOES record the estimator fill in the audit field-changes when the existing estimator was null", async () => {
    const NEW_ID = "22222222-2222-4222-8222-222222222222";
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": NEW_ID });

    const auditMirrorChanges: Array<Record<string, { from: unknown; to: unknown }>> = [];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback" || s.startsWith("savepoint") || s.startsWith("release") || s.startsWith("rollback to")) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [{ id: NEW_ID }], rowCount: 1 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas (old name)",
              estimator_user_id: null, // empty -> sync fills it; the audit must record the fill
              bid_board_estimator: null,
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      // RETURNING estimator_user_id is NEW_ID — the deal had no estimator so the COALESCE wrote the
      // resolved incoming id.
      if (s.includes("update office_dallas.deals")) {
        return { rows: [{ id: "deal-9", name: "Palm Villas", deal_number: "D-1", project_number: null, estimator_user_id: NEW_ID }], rowCount: 1 };
      }
      if (s.includes("insert into") && s.includes("audit_log")) {
        const changes = params?.[11] ? JSON.parse(String(params[11])) : null;
        const meta = params?.[13] ? JSON.parse(String(params[13])) : null;
        if (changes && meta?.source === "bid_board_mirror") auditMirrorChanges.push(changes);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
    });

    const estimatorChange = auditMirrorChanges
      .map((c) => c.estimatorUserId)
      .find((c) => c !== undefined);
    expect(estimatorChange).toEqual({ from: null, to: NEW_ID });
  });

  // FINDING 1 (TOCTOU): the audit `to` must come from the UPDATE's RETURNING estimator_user_id (the
  // LIVE row), not the pre-update findDealMatches snapshot. If a director edits the estimator between
  // the snapshot and the UPDATE, the COALESCE keeps the director's value and RETURNING surfaces it;
  // the mirror must record THAT, not the snapshot-derived effective value the old code passed.
  it("audits the RETURNING-written estimator, not the snapshot, when a concurrent edit diverges (TOCTOU)", async () => {
    const SNAPSHOT_ID = "11111111-1111-4111-8111-111111111111"; // value at findDealMatches time
    const DIRECTOR_ID = "33333333-3333-4333-8333-333333333333"; // a director sets this before the UPDATE
    const NEW_ID = "22222222-2222-4222-8222-222222222222"; // Bid Board mapping (active, would-be incoming)
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": NEW_ID });

    const auditMirrorChanges: Array<Record<string, { from: unknown; to: unknown }>> = [];
    query.mockImplementation(async (sql: string, params?: unknown[]) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback" || s.startsWith("savepoint") || s.startsWith("release") || s.startsWith("rollback to")) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [{ id: NEW_ID }], rowCount: 1 };
      if (s.includes("from office_dallas.deals")) {
        // The findDealMatches snapshot still shows SNAPSHOT_ID...
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas (old name)", // differs from incoming -> the UPDATE fires
              estimator_user_id: SNAPSHOT_ID,
              bid_board_estimator: "Someone Else",
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      if (s.includes("update office_dallas.deals")) {
        // ...but a director changed the estimator to DIRECTOR_ID between snapshot and UPDATE, so the
        // live-row COALESCE keeps DIRECTOR_ID and RETURNING surfaces it (NOT SNAPSHOT_ID, NOT NEW_ID).
        return { rows: [{ id: "deal-9", name: "Palm Villas", deal_number: "D-1", project_number: null, estimator_user_id: DIRECTOR_ID }], rowCount: 1 };
      }
      if (s.includes("insert into") && s.includes("audit_log")) {
        const changes = params?.[11] ? JSON.parse(String(params[11])) : null;
        const meta = params?.[13] ? JSON.parse(String(params[13])) : null;
        if (changes && meta?.source === "bid_board_mirror") auditMirrorChanges.push(changes);
        return { rows: [], rowCount: 1 };
      }
      return { rows: [], rowCount: 0 };
    });

    await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
    });

    const estimatorChange = auditMirrorChanges.map((c) => c.estimatorUserId).find((c) => c !== undefined);
    // `to` is the RETURNING value (DIRECTOR_ID). The old snapshot logic produced
    // effectiveEstimatorUserId = SNAPSHOT_ID, which collapsed from==to and dropped the field entirely —
    // silently hiding that the row's estimator is now DIRECTOR_ID. The RETURNING value exposes the truth.
    expect(estimatorChange).toEqual({ from: SNAPSHOT_ID, to: DIRECTOR_ID });
  });

  // FINDING 2: when the env map resolves to an INACTIVE user but the deal already has an estimator, the
  // empties-only COALESCE preserves the existing one — so the warning must say the incoming id was
  // ignored, NOT that the field was "left null" (which was false for every manually-set deal).
  it("warns 'incoming id ignored' (not 'left null') for an inactive map id when an estimator is preserved", async () => {
    const OLD_ID = "11111111-1111-4111-8111-111111111111"; // manual estimator already on the deal
    const INACTIVE_ID = "44444444-4444-4444-8444-444444444444"; // in the map, but NOT an active user
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": INACTIVE_ID });

    query.mockImplementation(async (sql: string) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback" || s.startsWith("savepoint") || s.startsWith("release") || s.startsWith("rollback to")) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      // Active-user set does NOT include INACTIVE_ID -> the resolved id is degraded to null.
      if (s.includes("from public.users")) return { rows: [], rowCount: 0 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas",
              estimator_user_id: OLD_ID, // existing estimator -> COALESCE preserves it, field is NOT null
              bid_board_estimator: "Someone Else",
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
    });

    expect(result.warnings.some((w) => w.includes("incoming id ignored") && w.includes(OLD_ID))).toBe(true);
    expect(result.warnings.some((w) => w.includes("estimator_user_id left null"))).toBe(false);
  });

  // FINDING 2 (the genuine case is still reported): an inactive map id on a deal with NO existing
  // estimator does leave the field null, so "left null" must still fire there.
  it("still warns 'left null' for an inactive map id when the deal had no estimator", async () => {
    const INACTIVE_ID = "44444444-4444-4444-8444-444444444444";
    process.env.BID_BOARD_ESTIMATOR_USER_MAP = JSON.stringify({ "Alex Koch": INACTIVE_ID });

    query.mockImplementation(async (sql: string) => {
      const s = sql.toLowerCase();
      if (s === "begin" || s === "commit" || s === "rollback" || s.startsWith("savepoint") || s.startsWith("release") || s.startsWith("rollback to")) {
        return { rows: [], rowCount: 0 };
      }
      if (s.includes("app.skip_stage_history_trigger")) return { rows: [] };
      if (s.includes("insert into office_dallas.bid_board_sync_runs")) return { rows: [{ id: "run-1" }], rowCount: 1 };
      if (s.includes("update office_dallas.bid_board_sync_runs")) return { rows: [], rowCount: 1 };
      if (s.includes("from public.users") && s.includes("public.offices")) return { rows: [{ id: "sys" }], rowCount: 1 };
      if (s.includes("from public.users")) return { rows: [], rowCount: 0 };
      if (s.includes("from office_dallas.deals")) {
        return {
          rows: [
            {
              id: "deal-9",
              name: "Palm Villas",
              estimator_user_id: null, // no existing estimator -> the field really IS left null
              bid_board_estimator: null,
              workflow_route: null,
              stage_slug: "estimating",
              stage_is_terminal: false,
            },
          ],
          rowCount: 1,
        };
      }
      return { rows: [], rowCount: 0 };
    });

    const result = await ingestBidBoardRows({
      office_slug: "dallas",
      rows: [{ Name: "Palm Villas", Status: "Estimate in Progress", "Project #": "DFW-4-11826-ab", Estimator: "Alex Koch" }],
    });

    expect(result.warnings.some((w) => w.includes("estimator_user_id left null"))).toBe(true);
    expect(result.warnings.some((w) => w.includes("incoming id ignored"))).toBe(false);
  });
});
