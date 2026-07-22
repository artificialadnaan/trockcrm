import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createFieldScorecard } from "../../../src/modules/field/scorecards-service.js";
import { resolveCorrectiveActionItem } from "../../../src/modules/field/corrective-actions-service.js";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  dealTeamMembers,
  contacts,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";

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
      dealTeamMembers,
      contacts,
    ]),
  );
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
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
    // Delayed a short while so the notification email doesn't race an immediate poll (mirrors the
    // field_scorecard_email job). run_after is strictly in the future.
    expect(new Date(job.run_after).getTime()).toBeGreaterThan(Date.now());
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
