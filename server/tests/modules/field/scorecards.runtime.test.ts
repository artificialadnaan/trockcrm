import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  createFieldScorecard,
  listFieldScorecardsForProject,
  listRecentFieldScorecards,
  getFieldScorecardDetail,
} from "../../../src/modules/field/scorecards-service.js";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, scorecardCorrectiveActions, dealTeamMembers, contacts, fieldResponders } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "22222222-2222-2222-2222-222222222222";
const LOST_DEAL = "88888888-8888-8888-8888-888888888888";
const USER = "33333333-3333-3333-3333-333333333333";
const FILE1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE2 = "aaaaaaaa-0000-0000-0000-000000000002";
const FILE_OTHER = "aaaaaaaa-0000-0000-0000-000000000009";
const FILE_DELETED = "aaaaaaaa-0000-0000-0000-00000000000d";
const FILE_DELETED_AT = "aaaaaaaa-0000-0000-0000-00000000000e";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const STAGE_LOST = "cccccccc-0000-0000-0000-000000000002";
const RETRY_DEAL = "99999999-9999-9999-9999-999999999999";

const ACCESS = { userId: USER, userRole: "field_contractor" as const };
const csid = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

let pg: PGlite;
let tdb: any;

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
function v2Items(overrides: Record<string, number> = {}) {
  return [
    "planning_precon", "jobsite_5s", "safety", "schedule",
    "subcontractor", "quality", "communication", "financial",
  ].map((sectionKey) => ({ sectionKey, points: overrides[sectionKey] ?? 8 }));
}
function submission(over: Partial<Parameters<typeof createFieldScorecard>[1]> = {}) {
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

beforeAll(async () => {
  pg = new PGlite();
  // Deal + stage islands carry only the columns activeProjectWhere / assertActiveFieldProject read.
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
    -- createFieldScorecard resolves the deal's superintendent/PM emails from deal_team_members → user/contact
    -- at enqueue time; these islands let that read run (no members inserted → both emails resolve null). The
    -- resolver checks users.is_active, so the island carries it (defaulting active).
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  // createFieldScorecard now resolves the scorecard's super/PM NAME against the roster (assignRosterResponderToDealIfUnset),
  // so the field_responders table must exist. Left empty here → no name matches → the assignment is a no-op, preserving
  // these tests' existing behavior (the assignment path itself is covered in field-responders-service.runtime.test.ts).
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, scorecardCorrectiveActions, dealTeamMembers, contacts, fieldResponders]));
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false),
      ('${STAGE_LOST}','Lost','lost',true);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true),
      ('${OTHER_DEAL}','Oak Ave',NULL,'${STAGE_ACTIVE}', true),
      ('${RETRY_DEAL}','Retry Rd',NULL,'${STAGE_ACTIVE}', true),
      ('${LOST_DEAL}','Elm Rd',NULL,'${STAGE_LOST}', true);
    INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description, is_active, deleted_at) VALUES
      ('${FILE1}','${DEAL}','cu-1','${USER}','Slab crack', true, NULL),
      ('${FILE2}','${DEAL}','cu-2','${USER}','Rebar', true, NULL),
      ('${FILE_OTHER}','${OTHER_DEAL}','cu-other','${USER}','Other deal photo', true, NULL),
      ('${FILE_DELETED}','${DEAL}','cu-deleted','${USER}','Deleted photo', false, NULL),
      ('${FILE_DELETED_AT}','${DEAL}','cu-deleted-at','${USER}','Soft-deleted via deleted_at', true, now());
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

describe("createFieldScorecard", () => {
  it("persists the V2 eight-category average and electronic signatures", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(99),
        formVersion: 2,
        items: v2Items({ safety: 10, quality: 6 }),
        superintendentSignature: "Marcus Reed",
        pmSignature: "Dana Cole",
      }),
    );
    expect(scorecard.formVersion).toBe(2);
    expect(scorecard.averageScore).toBe(8);
    expect(scorecard.totalScore).toBe(80);
    expect(scorecard.ratingLabel).toBe("Meets Standard");
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS);
    expect(detail.items).toHaveLength(8);
    expect(detail.superintendentSignature).toBe("Marcus Reed");
    expect(detail.pmSignature).toBe("Dana Cole");
  });

  it("persists a scorecard with server-computed total and rating", async () => {
    const { scorecard, created } = await createFieldScorecard(
      tdb,
      submission({ items: fullItems({ schedule: 10, quality: 15 }) }), // 100 - 10 - 5 = 85
    );
    expect(created).toBe(true);
    expect(scorecard.totalScore).toBe(85);
    expect(scorecard.rating).toBe("on_standard");
    expect(scorecard.ratingLabel).toBe("On Standard");
    expect(scorecard.projectName).toBe("Maple St");

    const items = await tdb.execute(sql`SELECT count(*)::int AS n FROM field_scorecard_items`);
    expect(items.rows[0].n).toBe(7);
  });

  it("snapshots the server-resolved project number, ignoring the client-sent value", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({ clientSubmissionId: csid(30), projectNumber: "CLIENT-SPOOFED-999" }),
    );
    expect(scorecard.projectNumber).toBe("DFW-10432"); // the deal's number, not the client body's
  });

  it("is idempotent on clientSubmissionId (a retried submit does not duplicate)", async () => {
    const first = await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(2) }));
    const second = await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(2) }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.scorecard.id).toBe(first.scorecard.id);
    expect(second.scorecard.projectName).toBe("Maple St");

    const cards = await tdb.execute(sql`SELECT count(*)::int AS n FROM field_scorecards`);
    expect(cards.rows[0].n).toBe(1);
  });

  it("rejects a submission for a non-browsable (Lost) project", async () => {
    await expect(
      createFieldScorecard(tdb, submission({ dealId: LOST_DEAL, clientSubmissionId: csid(10) })),
    ).rejects.toThrow(/project not found/i);
  });

  it("rejects a submission missing action items when the gate requires them", async () => {
    await expect(
      createFieldScorecard(tdb, submission({ items: fullItems({ schedule: 0 }), actionItems: [] })), // total 80 < 85
    ).rejects.toThrow(/action item/i);
  });

  it("accepts a below-85 submission when action items are provided", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({ items: fullItems({ schedule: 0 }), actionItems: ["Re-sequence the slab pour"] }),
    );
    expect(scorecard.totalScore).toBe(80);
    expect(scorecard.rating).toBe("needs_improvement");
  });

  it("requires action items when a critical deficiency is flagged even at a high score", async () => {
    await expect(
      createFieldScorecard(tdb, submission({ criticalDeficiencies: ["failed_inspection"], actionItems: [] })),
    ).rejects.toThrow(/action item/i);
  });

  it("rejects an illegal point value for a section", async () => {
    await expect(
      createFieldScorecard(tdb, submission({ items: fullItems({ schedule: 7 }) })),
    ).rejects.toThrow(/point|schedule/i);
  });

  it("rejects a submission that is missing a section", async () => {
    await expect(
      createFieldScorecard(tdb, submission({ items: fullItems().slice(0, 6) })),
    ).rejects.toThrow(/section/i);
  });

  it("links active evidence photos, rejects other-deal and soft-deleted photos", async () => {
    const ok = await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(3),
        photos: [
          { sectionKey: "schedule", clientUploadId: "cu-1" },
          { sectionKey: "quality", clientUploadId: "cu-2" },
        ],
      }),
    );
    const detail = await getFieldScorecardDetail(tdb, ok.scorecard.id, ACCESS);
    expect(detail.photos.map((p) => p.fileId).sort()).toEqual([FILE1, FILE2].sort());
    expect(detail.photos.find((p) => p.fileId === FILE1)?.caption).toBe("Slab crack");

    await expect(
      createFieldScorecard(
        tdb,
        submission({ clientSubmissionId: csid(4), photos: [{ sectionKey: "schedule", clientUploadId: "cu-other" }] }),
      ),
    ).rejects.toThrow(/photo|deal/i);

    await expect(
      createFieldScorecard(
        tdb,
        submission({ clientSubmissionId: csid(5), photos: [{ sectionKey: "schedule", clientUploadId: "cu-deleted" }] }),
      ),
    ).rejects.toThrow(/photo/i);

    // Soft-deleted via deleted_at (is_active still true) must ALSO be rejected — both halves of the filter.
    await expect(
      createFieldScorecard(
        tdb,
        submission({ clientSubmissionId: csid(11), photos: [{ sectionKey: "schedule", clientUploadId: "cu-deleted-at" }] }),
      ),
    ).rejects.toThrow(/photo/i);
  });

  it("a retry of an already-submitted card succeeds even after its project moved to Lost", async () => {
    const first = await createFieldScorecard(tdb, submission({ dealId: RETRY_DEAL, clientSubmissionId: csid(14) }));
    expect(first.created).toBe(true);
    await tdb.execute(sql`UPDATE deals SET stage_id = ${STAGE_LOST} WHERE id = ${RETRY_DEAL}`);
    // A brand-new card for the now-Lost project is blocked by the gate...
    await expect(
      createFieldScorecard(tdb, submission({ dealId: RETRY_DEAL, clientSubmissionId: csid(15) })),
    ).rejects.toThrow(/project not found/i);
    // ...but the retry of the already-submitted card still returns it (idempotency runs before the gate).
    const retry = await createFieldScorecard(tdb, submission({ dealId: RETRY_DEAL, clientSubmissionId: csid(14) }));
    expect(retry.created).toBe(false);
    expect(retry.scorecard.id).toBe(first.scorecard.id);
    expect(retry.scorecard.projectName).toBe("Retry Rd");
    await tdb.execute(sql`UPDATE deals SET stage_id = ${STAGE_ACTIVE} WHERE id = ${RETRY_DEAL}`); // restore for isolation
  });
});

describe("reads", () => {
  // Insert a card directly on the Lost deal (bypassing the create gate) to prove reads also gate it.
  async function insertLostCard(id: string) {
    await tdb.execute(sql`
      INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, total_score, rating, submitted_by)
      VALUES (${id}, ${csid(900)}, ${LOST_DEAL}, '2026-06-30', 90, 'elite', ${USER})
    `);
  }

  it("lists a project's scorecards and returns full detail", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({ clientSubmissionId: csid(6), criticalDeficiencies: ["failed_inspection"], actionItems: ["Fix it"] }),
    );

    const list = await listFieldScorecardsForProject(tdb, ACCESS, DEAL);
    expect(list.scorecards).toHaveLength(1);
    expect(list.scorecards[0].id).toBe(scorecard.id);
    expect(list.scorecards[0].criticalDeficiencyCount).toBe(1);
    expect(list.scorecards[0].projectName).toBe("Maple St");

    const detail = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS);
    expect(detail.projectName).toBe("Maple St");
    expect(detail.items).toHaveLength(7);
    expect(detail.items[0].sectionKey).toBe("planning_precon"); // canonical section order
    expect(detail.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(detail.actionItems).toEqual(["Fix it"]);
  });

  it("recent list surfaces browsable-project cards and excludes Lost-project cards", async () => {
    const active = await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(7) }));
    const lostCard = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await insertLostCard(lostCard);

    const recent = await listRecentFieldScorecards(tdb, { limit: 10 });
    const ids = recent.scorecards.map((s) => s.id);
    expect(ids).toContain(active.scorecard.id);
    expect(ids).not.toContain(lostCard);
    expect(recent.scorecards.find((s) => s.id === active.scorecard.id)?.projectName).toBe("Maple St");
  });

  it("404s a detail read for a card whose project is no longer browsable", async () => {
    const lostCard = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await insertLostCard(lostCard);
    await expect(getFieldScorecardDetail(tdb, lostCard, ACCESS)).rejects.toThrow(/project not found/i);
  });

  it("404s a per-project list for a non-browsable project", async () => {
    await expect(listFieldScorecardsForProject(tdb, ACCESS, LOST_DEAL)).rejects.toThrow(/project not found/i);
  });

  it("resolves evidence photo URLs concurrently and falls back to null without a resolver", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(20),
        photos: [
          { sectionKey: "schedule", clientUploadId: "cu-1" },
          { sectionKey: "quality", clientUploadId: "cu-2" },
        ],
      }),
    );
    const withUrls = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS, {
      resolvePhotoUrl: async (fileId) => `https://cdn/${fileId}`,
    });
    expect(withUrls.photos).toHaveLength(2);
    expect(withUrls.photos.every((p) => p.url === `https://cdn/${p.fileId}`)).toBe(true);
    const noUrls = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS);
    expect(noUrls.photos.every((p) => p.url === null)).toBe(true);
  });

  it("excludes corrective-action RESPONSE photos from detail evidence (finding #8)", async () => {
    // One ORIGINAL section-evidence photo + one corrective-action RESPONSE photo (corrective_action_id set,
    // section_key null). getFieldScorecardDetail must return ONLY the section evidence — response photos load
    // through their own corrective-action thread, and their null-section rows are DTO-invalid here.
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({
        clientSubmissionId: csid(30),
        photos: [{ sectionKey: "quality", clientUploadId: "cu-1" }],
      }),
    );
    // A corrective-action item to hang the response photo off of.
    const caId = "eeeeeeee-0000-0000-0000-0000000000ca";
    await tdb.execute(sql`
      INSERT INTO scorecard_corrective_actions (id, scorecard_id, item_type, item_ref, item_label, status)
      VALUES (${caId}, ${scorecard.id}, 'action_item', '0', 'Re-inspect', 'resolved')
    `);
    // A fresh response-photo file + link (section_key NULL, corrective_action_id set).
    const respFile = "aaaaaaaa-0000-0000-0000-0000000000ca";
    await tdb.execute(sql`
      INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description, is_active, deleted_at)
      VALUES (${respFile}, ${DEAL}, 'cu-response', ${USER}, 'Fixed', true, NULL)
    `);
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id, corrective_action_id)
      VALUES (${scorecard.id}, NULL, NULL, ${respFile}, ${caId})
    `);

    const presigned: string[] = [];
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS, {
      resolvePhotoUrl: async (fileId) => {
        presigned.push(fileId);
        return `https://cdn/${fileId}`;
      },
    });
    // Only the ORIGINAL section-evidence photo — never the response photo.
    expect(detail.photos).toHaveLength(1);
    expect(detail.photos[0].fileId).not.toBe(respFile);
    expect(detail.photos.map((p) => p.fileId)).not.toContain(respFile);
    // The response photo is never presigned (no wasted work).
    expect(presigned).not.toContain(respFile);
  });

  it("returns weekOf as a YYYY-MM-DD string from the recent list", async () => {
    await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(21), weekOf: "2026-06-30" }));
    const recent = await listRecentFieldScorecards(tdb, { limit: 10 });
    expect(recent.scorecards[0]?.weekOf).toBe("2026-06-30");
  });
});
