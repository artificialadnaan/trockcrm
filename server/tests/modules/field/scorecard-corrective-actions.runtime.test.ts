import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createFieldScorecard } from "../../../src/modules/field/scorecards-service.js";
import {
  reconcileScorecardCorrectiveActions,
  resolveCorrectiveActionItem,
  restartCorrectiveActionNotificationCycleForDeal,
} from "../../../src/modules/field/corrective-actions-service.js";
import { submitCorrectiveActionResponse } from "../../../src/modules/field/corrective-action-api.js";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
  dealTeamMembers,
  contacts,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };

const csid = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

let pg: PGlite;
let tdb: any;

// V1 100-point section maxima (matches the seven canonical sections).
const MAX: Record<string, number> = {
  planning_precon: 10,
  jobsite_5s: 15,
  schedule: 20,
  subcontractor: 15,
  quality: 20,
  communication: 10,
  financial: 10,
};
function fullItems(overrides: Record<string, number> = {}) {
  return Object.entries(MAX).map(([sectionKey, m]) => ({ sectionKey, points: overrides[sectionKey] ?? m }));
}

function submission(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    userRole: "field_contractor" as const,
    submittedByName: "Marcus Reed",
    dealId: DEAL,
    office: { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" },
    clientSubmissionId: csid(1),
    weekOf: "2026-06-30",
    superintendentName: "Marcus Reed",
    pmName: "Dana Cole",
    projectNumber: "DFW-10432",
    items: fullItems(),
    criticalDeficiencies: [] as string[],
    actionItems: [] as string[],
    photos: [] as { sectionKey: string; clientUploadId: string }[],
    ...over,
  };
}

// A below-band (corrective_action) submission: drop schedule+quality to 0 → total 60 (< 75), with two
// action items + one critical deficiency to flag.
function belowBandSubmission(over: Record<string, unknown> = {}) {
  return submission({
    clientSubmissionId: csid(100),
    items: fullItems({ schedule: 0, quality: 0 }), // total = 60 → corrective_action
    criticalDeficiencies: ["missed_hold_point"],
    actionItems: ["Re-inspect slab 2", "Verify hold points"],
    ...over,
  });
}

// A passing (above-band) submission: full marks, no deficiencies.
function passingSubmission(over: Record<string, unknown> = {}) {
  return submission({ clientSubmissionId: csid(200), items: fullItems(), ...over });
}

async function getScorecardRow(id: string): Promise<{ status: string }> {
  const res = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${id}`);
  return res.rows[0] as { status: string };
}

interface CorrectiveActionRow {
  id: string;
  item_type: string;
  item_ref: string;
  item_label: string;
  status: string;
}
async function getCorrectiveActions(scorecardId: string): Promise<CorrectiveActionRow[]> {
  const res = await tdb.execute(sql`
    SELECT id, item_type, item_ref, item_label, status
    FROM scorecard_corrective_actions
    WHERE scorecard_id = ${scorecardId}
    ORDER BY item_type, item_ref
  `);
  return res.rows as CorrectiveActionRow[];
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text, is_terminal boolean DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text, stage_id uuid,
      is_active boolean DEFAULT true, bid_board_stage_slug text,
      property_address text, property_city text, property_state text, property_zip text,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, client_upload_id text, uploaded_by uuid,
      description text, is_active boolean DEFAULT true, deleted_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      fieldScorecards,
      fieldScorecardItems,
      fieldScorecardPhotos,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionTokens,
      dealTeamMembers,
      contacts,
    ]),
  );
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  // tenantSchemaSql omits FOREIGN KEYS (it reproduces column types/PKs only), so add migration 0192's
  // field_scorecard_photos.corrective_action_id -> scorecard_corrective_actions(id) ON DELETE CASCADE here to
  // exercise the cascade: deleting a corrective-action row must delete its response-photo LINK rows.
  await pg.exec(
    `ALTER TABLE public.field_scorecard_photos
       ADD CONSTRAINT field_scorecard_photos_corrective_action_fk
       FOREIGN KEY (corrective_action_id)
       REFERENCES public.scorecard_corrective_actions(id) ON DELETE CASCADE;`,
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

describe("createFieldScorecard corrective-action trigger", () => {
  it("opens the corrective-action stage and seeds one row per flagged item on a below-band submit", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    expect(scorecard.rating).toBe("corrective_action");

    const row = await getScorecardRow(scorecard.id);
    expect(row.status).toBe("corrective_action_open");

    const items = await getCorrectiveActions(scorecard.id);
    expect(items).toHaveLength(3);
    expect(items.filter((i) => i.status === "open")).toHaveLength(3);
    expect(items.map((i) => i.item_type).sort()).toEqual([
      "action_item",
      "action_item",
      "critical_deficiency",
    ]);
    const actionItems = items.filter((i) => i.item_type === "action_item");
    expect(actionItems.map((i) => i.item_ref).sort()).toEqual(["0", "1"]);
    expect(actionItems.map((i) => i.item_label).sort()).toEqual([
      "Re-inspect slab 2",
      "Verify hold points",
    ]);
    const deficiency = items.find((i) => i.item_type === "critical_deficiency");
    expect(deficiency?.item_ref).toBe("missed_hold_point");
    expect(deficiency?.item_label).toBe("Missed hold point");
  });

  it("RETURNS the reconciled status (corrective_action_open), not the pre-reconcile 'submitted' (finding 1)", async () => {
    // The summary is built from the reconciled row, so a below-band create surfaces corrective_action_open
    // immediately — the freshly-inserted row was 'submitted' before the reconcile walked it open.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    expect(scorecard.status).toBe("corrective_action_open");
  });

  it("leaves a passing scorecard as 'submitted' with no corrective-action rows", async () => {
    const { scorecard } = await createFieldScorecard(tdb, passingSubmission());
    expect(scorecard.rating).toBe("elite");
    expect((await getScorecardRow(scorecard.id)).status).toBe("submitted");
    expect(await getCorrectiveActions(scorecard.id)).toHaveLength(0);
  });

  it("leaves a below-band scorecard with NO flagged items as 'submitted' (nothing to correct)", async () => {
    // Below 85 but no action items and no deficiencies is only reachable for V2 (no V1 action-item gate).
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(300),
        formVersion: 2,
        items: [
          "planning_precon",
          "jobsite_5s",
          "safety",
          "schedule",
          "subcontractor",
          "quality",
          "communication",
          "financial",
        ].map((sectionKey) => ({ sectionKey, points: 5 })), // avg 5 → corrective_action
        criticalDeficiencies: [],
        actionItems: [],
      }),
    );
    expect(scorecard.rating).toBe("corrective_action");
    expect((await getScorecardRow(scorecard.id)).status).toBe("submitted");
    expect(await getCorrectiveActions(scorecard.id)).toHaveLength(0);
  });
});

describe("createFieldScorecard corrective-action email enqueue", () => {
  async function correctiveEmailJobs(): Promise<
    { payload: any; max_attempts: number; run_after: string; office_id: string | null }[]
  > {
    const res = await tdb.execute(sql`
      SELECT payload, max_attempts, run_after, office_id
      FROM public.job_queue
      WHERE job_type = 'scorecard_corrective_action_email'
      ORDER BY id
    `);
    return res.rows as any[];
  }

  it("enqueues ONE corrective-action email job on a below-band submit", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const jobs = await correctiveEmailJobs();
    expect(jobs).toHaveLength(1);
    const [job] = jobs;
    expect(job.payload.scorecardId).toBe(scorecard.id);
    expect(job.payload.dealId).toBe(DEAL);
    expect(job.payload.tenantSchema).toBe("office_test");
    expect(job.payload.officeId).toBe("00000000-0000-0000-0000-0000000000f1");
    expect(job.office_id).toBe("00000000-0000-0000-0000-0000000000f1");
    expect(job.max_attempts).toBe(6);
    // A stable, persisted per-cycle nonce is on the payload so the worker keys its CRM (no-token) Resend
    // idempotency dedup off it (immutable across a genuine retry) instead of hashing the currently-open
    // corrective-action rows (whose ids shift if an item is resolved between the send attempt and a retry).
    expect(typeof job.payload.cycleNonce).toBe("string");
    expect(job.payload.cycleNonce).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    // Delayed a short while so the notification email doesn't race an immediate poll (mirrors the
    // field_scorecard_email job). run_after is strictly in the future.
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now());
  });

  it("gives two separate corrective-action cycles DIFFERENT cycleNonce values", async () => {
    // A fresh below-band submit enqueues one job (cycle 1). A second, distinct below-band submit enqueues
    // another (cycle 2). Each enqueue mints its own nonce, so the two cycles' nonces differ — the dimension
    // that lets the worker distinguish cycles when the flagged-item set (and thus the email payload) changed.
    const { scorecard: a } = await createFieldScorecard(tdb, belowBandSubmission());
    const { scorecard: b } = await createFieldScorecard(
      tdb,
      belowBandSubmission({ clientSubmissionId: csid(410) }),
    );
    expect(a.id).not.toBe(b.id);
    const jobs = await correctiveEmailJobs();
    expect(jobs).toHaveLength(2);
    const nonces = jobs.map((j) => j.payload.cycleNonce);
    expect(nonces[0]).toBeTruthy();
    expect(nonces[1]).toBeTruthy();
    expect(nonces[0]).not.toBe(nonces[1]);
  });

  it("persists the enqueued cycleNonce on the scorecard as corrective_action_cycle_nonce (P1 cycle guard)", async () => {
    // The worker's delivery stamp requires the job's payload.cycleNonce to still match the scorecard's stored
    // corrective_action_cycle_nonce (the ACTIVE cycle). So a fresh below-band submit must persist THAT SAME
    // nonce on the scorecard in the same transaction — otherwise the notification job could never stamp.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const jobs = await correctiveEmailJobs();
    expect(jobs).toHaveLength(1);
    const enqueuedNonce = jobs[0].payload.cycleNonce as string;
    expect(enqueuedNonce).toBeTruthy();

    const res = await tdb.execute(
      sql`SELECT corrective_action_cycle_nonce AS n FROM field_scorecards WHERE id = ${scorecard.id}`,
    );
    const storedNonce = (res.rows[0] as { n: string | null }).n;
    // The scorecard's stored active-cycle nonce equals the enqueued job's nonce.
    expect(storedNonce).toBe(enqueuedNonce);
  });

  it("enqueues NO corrective-action email job on a passing submit", async () => {
    await createFieldScorecard(tdb, passingSubmission());
    expect(await correctiveEmailJobs()).toHaveLength(0);
  });

  it("enqueues NO corrective-action email job for a below-band card with no flagged items", async () => {
    await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(301),
        formVersion: 2,
        items: [
          "planning_precon",
          "jobsite_5s",
          "safety",
          "schedule",
          "subcontractor",
          "quality",
          "communication",
          "financial",
        ].map((sectionKey) => ({ sectionKey, points: 5 })),
        criticalDeficiencies: [],
        actionItems: [],
      }),
    );
    expect(await correctiveEmailJobs()).toHaveLength(0);
  });
});

describe("resolveCorrectiveActionItem closure", () => {
  // NOTE: these resolves run sequentially. True concurrency isn't reproducible in PGlite (single
  // connection), but a FOR UPDATE row lock on the parent scorecard serializes concurrent resolves for the
  // same scorecard in production so two responders closing out the last open items can't each miss the
  // other's uncommitted resolve and leave the scorecard stuck `corrective_action_open`.
  it("resolving the LAST open item auto-closes the scorecard; resolving a non-last item does not", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    expect(items).toHaveLength(3);

    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: items[0].id,
      responseComment: "fixed",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_open");

    for (const it of items.slice(1)) {
      await resolveCorrectiveActionItem(tdb, {
        scorecardId: scorecard.id,
        itemId: it.id,
        responseComment: "fixed",
        respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
      });
    }
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_closed");

    const resolved = await getCorrectiveActions(scorecard.id);
    expect(resolved.every((i) => i.status === "resolved")).toBe(true);
  });

  it("stamps the responder identity + comment on the resolved item", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActions(scorecard.id);
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      responseComment: "Slab re-inspected, hold point cleared",
      respondedBy: { userId: USER, name: "Sam Field", email: null },
    });
    const res = await tdb.execute(sql`
      SELECT status, response_comment, responded_by_user_id, responder_name, responder_email, responded_at
      FROM scorecard_corrective_actions WHERE id = ${first.id}
    `);
    const row = res.rows[0];
    expect(row.status).toBe("resolved");
    expect(row.response_comment).toBe("Slab re-inspected, hold point cleared");
    expect(row.responded_by_user_id).toBe(USER);
    expect(row.responder_name).toBe("Sam Field");
    expect(row.responder_email).toBeNull();
    expect(row.responded_at).not.toBeNull();
  });

  it("re-resolving an already-resolved item is a no-op (idempotent) and keeps it closed", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    for (const it of items) {
      await resolveCorrectiveActionItem(tdb, {
        scorecardId: scorecard.id,
        itemId: it.id,
        responseComment: "fixed",
        respondedBy: { userId: USER, name: "Sam", email: null },
      });
    }
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_closed");

    // Re-resolving the first item again is a no-op — no throw, still closed.
    await expect(
      resolveCorrectiveActionItem(tdb, {
        scorecardId: scorecard.id,
        itemId: items[0].id,
        responseComment: "second attempt",
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).resolves.toBeUndefined();
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_closed");

    // The original responder/comment on item 0 is untouched (guarded update skipped it).
    const after = await tdb.execute(
      sql`SELECT response_comment FROM scorecard_corrective_actions WHERE id = ${items[0].id}`,
    );
    expect(after.rows[0].response_comment).toBe("fixed");
  });

  it("resolving an unknown item id is a no-op that does not close the scorecard", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: "00000000-0000-0000-0000-0000000000ff",
      responseComment: "nope",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_open");
  });
});

describe("corrective_action_id FK ON DELETE CASCADE (finding 3)", () => {
  it("deleting a corrective-action row cascades away its field_scorecard_photos LINK rows; files remain", async () => {
    // Migration 0192's FK is ON DELETE CASCADE (not SET NULL): when a resolved corrective-action row is purged
    // (a removed flag on edit — round 8), its attached RESPONSE-photo LINK rows must be deleted too. SET NULL
    // would leave each link with BOTH corrective_action_id AND section_key null → the detail/PDF evidence
    // queries mis-read it as ORIGINAL section evidence and the removed response could land in the PDF.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [item] = await getCorrectiveActions(scorecard.id);

    // A backing gallery file (the underlying files row is NOT owned by the FK — it's keyed on corrective_action_id).
    const fileId = "77777777-7777-7777-7777-777777777701";
    await tdb.execute(sql`
      INSERT INTO files (id, deal_id, uploaded_by, is_active)
      VALUES (${fileId}, ${DEAL}, ${USER}, true)
    `);
    // A RESPONSE-photo LINK row: corrective_action_id set, section_key/deficiency_key null (spec §4.3).
    const photoId = "88888888-8888-8888-8888-888888888801";
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (id, scorecard_id, corrective_action_id, file_id)
      VALUES (${photoId}, ${scorecard.id}, ${item.id}, ${fileId})
    `);

    // Deleting the corrective-action row cascades the LINK row away.
    await tdb.execute(sql`DELETE FROM scorecard_corrective_actions WHERE id = ${item.id}`);

    const links = await tdb.execute(
      sql`SELECT id FROM field_scorecard_photos WHERE id = ${photoId}`,
    );
    expect(links.rows).toHaveLength(0);
    // The underlying gallery file is untouched (the FK is on corrective_action_id, not file_id).
    const remaining = await tdb.execute(sql`SELECT id FROM files WHERE id = ${fileId}`);
    expect(remaining.rows).toHaveLength(1);
  });
});

describe("resolve advances the scorecard content generation", () => {
  async function getUpdatedAt(id: string): Promise<Date> {
    const res = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${id}`);
    return new Date((res.rows[0] as { updated_at: string | Date }).updated_at);
  }

  it("advances updated_at when a NON-final item is resolved", async () => {
    // The reported bug: resolving item 1 of N left updated_at untouched, so the download path still
    // considered the submit-time PDF current and served a scorecard with no corrective action on it.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    expect(items.length).toBeGreaterThan(1);
    const before = await getUpdatedAt(scorecard.id);

    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: items[0].id,
      responseComment: "fixed",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    expect((await getUpdatedAt(scorecard.id)).getTime()).toBeGreaterThan(before.getTime());
    // Still open — only one of several items answered.
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_open");
  });

  it("advances updated_at on the final item alongside the auto-close", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    for (const item of items.slice(0, -1)) {
      await resolveCorrectiveActionItem(tdb, {
        scorecardId: scorecard.id,
        itemId: item.id,
        responseComment: "fixed",
        respondedBy: { userId: USER, name: "Sam", email: null },
      });
    }
    const before = await getUpdatedAt(scorecard.id);

    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: items[items.length - 1].id,
      responseComment: "fixed",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    expect((await getUpdatedAt(scorecard.id)).getTime()).toBeGreaterThan(before.getTime());
    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_closed");
  });

  it("does NOT advance updated_at on an idempotent re-resolve", async () => {
    // A no-op must not invalidate the artifact — otherwise a duplicate submit re-renders the PDF for free.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: items[0].id,
      responseComment: "fixed",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });
    const afterFirst = await getUpdatedAt(scorecard.id);

    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: items[0].id,
      responseComment: "again",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    expect((await getUpdatedAt(scorecard.id)).getTime()).toBe(afterFirst.getTime());
  });
});

describe("corrective-action oversight email enqueue", () => {
  async function oversightJobs(): Promise<{ payload: any; max_attempts: number; office_id: string | null }[]> {
    const res = await tdb.execute(sql`
      SELECT payload, max_attempts, office_id
      FROM public.job_queue
      WHERE job_type = 'scorecard_corrective_action_oversight_email'
      ORDER BY id
    `);
    return res.rows as any[];
  }

  async function responderJobNonce(scorecardId: string): Promise<string> {
    const res = await tdb.execute(sql`
      SELECT payload FROM public.job_queue
      WHERE job_type = 'scorecard_corrective_action_email'
        AND payload->>'scorecardId' = ${scorecardId}
      ORDER BY id DESC LIMIT 1
    `);
    return (res.rows[0] as any).payload.cycleNonce;
  }

  it("enqueues an 'opened' oversight job alongside the responder job when a cycle starts", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());

    const jobs = await oversightJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.phase).toBe("opened");
    expect(jobs[0].payload.scorecardId).toBe(scorecard.id);
    expect(jobs[0].payload.dealId).toBe(DEAL);
    expect(jobs[0].payload.tenantSchema).toBe("office_test");
    expect(jobs[0].max_attempts).toBe(6);
    // Same cycle as the responder job — both notifications must agree on which cycle they describe.
    expect(jobs[0].payload.cycleNonce).toBe(await responderJobNonce(scorecard.id));
  });

  it("enqueues a 'closed' oversight job when the LAST item is answered", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    await tdb.execute(sql`DELETE FROM public.job_queue`);

    for (const item of items) {
      await tdb.transaction(async (tx) => {
        await submitCorrectiveActionResponse(tx as any, {
          scorecardId: scorecard.id,
          itemId: item.id,
          comment: "fixed",
          respondedBy: { userId: USER, name: "Sam", email: null },
          office: OFFICE,
        });
      });
    }

    expect((await getScorecardRow(scorecard.id)).status).toBe("corrective_action_closed");
    const jobs = await oversightJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.phase).toBe("closed");
    expect(jobs[0].payload.scorecardId).toBe(scorecard.id);
    expect(jobs[0].payload.dealId).toBe(DEAL);
  });

  it("does NOT enqueue a 'closed' job while items remain open", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActions(scorecard.id);
    expect(items.length).toBeGreaterThan(1);
    await tdb.execute(sql`DELETE FROM public.job_queue`);

    await tdb.transaction(async (tx) => {
      await submitCorrectiveActionResponse(tx as any, {
        scorecardId: scorecard.id,
        itemId: items[0].id,
        comment: "fixed",
        respondedBy: { userId: USER, name: "Sam", email: null },
        office: OFFICE,
      });
    });

    expect(await oversightJobs()).toHaveLength(0);
  });

  it("does NOT enqueue a second 'closed' job on an idempotent replay of the closing response", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission({ actionItems: ["Only item"], criticalDeficiencies: [] }));
    const items = await getCorrectiveActions(scorecard.id);
    expect(items).toHaveLength(1);
    await tdb.execute(sql`DELETE FROM public.job_queue`);

    for (let attempt = 0; attempt < 2; attempt += 1) {
      await tdb.transaction(async (tx) => {
        await submitCorrectiveActionResponse(tx as any, {
          scorecardId: scorecard.id,
          itemId: items[0].id,
          comment: "fixed",
          respondedBy: { userId: USER, name: "Sam", email: null },
          office: OFFICE,
        });
      });
    }

    expect(await oversightJobs()).toHaveLength(1);
  });

  it("clears BOTH oversight stamps when a card REOPENS, so oversight is re-notified", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    await tdb.execute(sql`
      UPDATE field_scorecards
         SET corrective_action_oversight_opened_at = NOW(),
             corrective_action_oversight_closed_at = NOW(),
             status = 'corrective_action_closed'
       WHERE id = ${scorecard.id}
    `);
    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'resolved' WHERE scorecard_id = ${scorecard.id}`);
    await tdb.execute(sql`DELETE FROM public.job_queue`);

    // An edit adding a NEW flag walks the closed card back into corrective_action_open — a genuinely new
    // cycle. (Re-submitting the SAME already-resolved flags correctly does NOT reopen it.)
    await tdb.transaction(async (tx) => {
      await reconcileScorecardCorrectiveActions(tx as any, {
        scorecardId: scorecard.id,
        dealId: DEAL,
        office: OFFICE,
        rating: "corrective_action",
        currentStatus: "corrective_action_closed",
        deficiencies: ["missed_hold_point"],
        actionItems: ["Re-inspect slab 2", "Verify hold points", "NEW: re-torque anchors"],
      } as any);
    });

    const row = await tdb.execute(sql`
      SELECT corrective_action_oversight_opened_at, corrective_action_oversight_closed_at
      FROM field_scorecards WHERE id = ${scorecard.id}
    `);
    expect(row.rows[0]).toMatchObject({
      corrective_action_oversight_opened_at: null,
      corrective_action_oversight_closed_at: null,
    });
    const jobs = await oversightJobs();
    expect(jobs).toHaveLength(1);
    expect(jobs[0].payload.phase).toBe("opened");
  });

  it("does NOT re-notify oversight when a responder reassignment restarts the RESPONDER cycle", async () => {
    // The card never left corrective_action_open — a super/PM was swapped. Oversight was already told it
    // opened and will be told when it completes; re-sending here is exactly the inbox noise to avoid.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const stampedAt = new Date("2026-07-27T12:00:00.000Z");
    await tdb.execute(sql`
      UPDATE field_scorecards SET corrective_action_oversight_opened_at = ${stampedAt} WHERE id = ${scorecard.id}
    `);
    await tdb.execute(sql`DELETE FROM public.job_queue`);

    await tdb.transaction(async (tx) => {
      await restartCorrectiveActionNotificationCycleForDeal(tx as any, { dealId: DEAL, office: OFFICE } as any);
    });

    expect(await oversightJobs()).toHaveLength(0);
    const row = await tdb.execute(sql`
      SELECT corrective_action_oversight_opened_at FROM field_scorecards WHERE id = ${scorecard.id}
    `);
    expect(new Date((row.rows[0] as any).corrective_action_oversight_opened_at).getTime()).toBe(stampedAt.getTime());
  });
});
