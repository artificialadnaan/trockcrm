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
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const OTHER_DEAL = "22222222-2222-2222-2222-222222222222";
const USER = "33333333-3333-3333-3333-333333333333";
const FILE1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE2 = "aaaaaaaa-0000-0000-0000-000000000002";
const FILE_OTHER = "aaaaaaaa-0000-0000-0000-000000000009";

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
function submission(over: Partial<Parameters<typeof createFieldScorecard>[1]> = {}) {
  return {
    userId: USER,
    submittedByName: "Marcus Reed",
    dealId: DEAL,
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
  // Minimal files island — only the columns the scorecard link + caption join touch.
  await pg.exec(`
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, client_upload_id text, uploaded_by uuid,
      description text, is_active boolean DEFAULT true, created_at timestamptz DEFAULT now()
    );
  `);
  // Scorecard tables from the REAL Drizzle defs — prod-accurate types/defaults, so a schema drift can't
  // pass here and break prod. The helper omits FKs/indexes, so add the unique the idempotency path needs.
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos]));
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  await pg.exec(`
    INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description) VALUES
      ('${FILE1}','${DEAL}','cu-1','${USER}','Slab crack'),
      ('${FILE2}','${DEAL}','cu-2','${USER}','Rebar'),
      ('${FILE_OTHER}','${OTHER_DEAL}','cu-other','${USER}','Other deal photo');
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  // No FK cascade in the test island — clear all three explicitly.
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
});

describe("createFieldScorecard", () => {
  it("persists a scorecard with server-computed total and rating", async () => {
    const { scorecard, created } = await createFieldScorecard(
      tdb,
      submission({ items: fullItems({ schedule: 10, quality: 15 }) }), // 100 - 10 - 5 = 85
    );
    expect(created).toBe(true);
    expect(scorecard.totalScore).toBe(85);
    expect(scorecard.rating).toBe("on_standard");
    expect(scorecard.ratingLabel).toBe("On Standard");

    const items = await tdb.execute(sql`SELECT count(*)::int AS n FROM field_scorecard_items`);
    expect(items.rows[0].n).toBe(7);
  });

  it("is idempotent on clientSubmissionId (a retried submit does not duplicate)", async () => {
    const first = await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(2) }));
    const second = await createFieldScorecard(tdb, submission({ clientSubmissionId: csid(2) }));
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.scorecard.id).toBe(first.scorecard.id);

    const cards = await tdb.execute(sql`SELECT count(*)::int AS n FROM field_scorecards`);
    expect(cards.rows[0].n).toBe(1);
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

  it("links evidence photos and rejects a photo from another deal", async () => {
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
    const detail = await getFieldScorecardDetail(tdb, ok.scorecard.id);
    expect(detail.photos.map((p) => p.fileId).sort()).toEqual([FILE1, FILE2].sort());
    expect(detail.photos.find((p) => p.fileId === FILE1)?.caption).toBe("Slab crack");

    await expect(
      createFieldScorecard(
        tdb,
        submission({ clientSubmissionId: csid(4), photos: [{ sectionKey: "schedule", clientUploadId: "cu-other" }] }),
      ),
    ).rejects.toThrow(/photo|deal/i);
  });
});

describe("reads", () => {
  it("lists a project's scorecards and returns full detail", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      submission({ clientSubmissionId: csid(5), criticalDeficiencies: ["failed_inspection"], actionItems: ["Fix it"] }),
    );

    const list = await listFieldScorecardsForProject(tdb, DEAL);
    expect(list.scorecards).toHaveLength(1);
    expect(list.scorecards[0].id).toBe(scorecard.id);
    expect(list.scorecards[0].criticalDeficiencyCount).toBe(1);

    const recent = await listRecentFieldScorecards(tdb, { limit: 10 });
    expect(recent.scorecards.map((s) => s.id)).toContain(scorecard.id);

    const detail = await getFieldScorecardDetail(tdb, scorecard.id);
    expect(detail.items).toHaveLength(7);
    expect(detail.items[0].sectionKey).toBe("planning_precon"); // canonical section order
    expect(detail.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(detail.actionItems).toEqual(["Fix it"]);
  });
});
