import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  createFieldScorecard,
  getFieldScorecardDetail,
  listFieldScorecardsForProject,
} from "../../../src/modules/field/scorecards-service.js";
import { fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, dealTeamMembers, contacts } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// Leadership scorecard: a distinct KIND in the SAME tables — 4 categories rated 1-10 (average out of 10,
// V2 bands), a free-text summary + Project Summary photos, NO deficiencies/action-items/signatures. These
// runtime tests prove the create path persists kind + summary + the 4 items and the same durable email
// job is enqueued (Phase B routing), and the detail read returns the leadership items in canonical order.

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const FILE1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE2 = "aaaaaaaa-0000-0000-0000-000000000002";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";

const ACCESS = { userId: USER, userRole: "field_contractor" as const };
const csid = (n: number) => `66666666-6666-6666-6666-${String(n).padStart(12, "0")}`;

let pg: PGlite;
let tdb: any;

const LEADERSHIP_KEYS = ["quality_control", "safety", "schedule_adherence", "site_staff_feedback"] as const;

function leadershipItems(overrides: Record<string, number> = {}) {
  return LEADERSHIP_KEYS.map((sectionKey) => ({ sectionKey, points: overrides[sectionKey] ?? 8 }));
}

function leadershipSubmission(over: Partial<Parameters<typeof createFieldScorecard>[1]> = {}) {
  return {
    userId: USER,
    userRole: "field_contractor" as const,
    submittedByName: "Marcus Reed",
    dealId: DEAL,
    office: { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" },
    clientSubmissionId: csid(1),
    weekOf: "2026-06-30",
    kind: "leadership" as const,
    superintendentName: "Sam Super",
    pmName: "Dana Cole",
    projectNumber: "DFW-10432",
    items: leadershipItems(),
    criticalDeficiencies: [] as string[],
    actionItems: [] as string[],
    photos: [] as { sectionKey: string; clientUploadId: string }[],
    summary: "Strong week overall; keep the housekeeping cadence up.",
    ...over,
  };
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
    -- resolveScorecardTeamEmails checks users.is_active, so the island carries it (defaulting active).
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
  `);
  await pg.exec(tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, dealTeamMembers, contacts]));
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true);
    INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description, is_active, deleted_at) VALUES
      ('${FILE1}','${DEAL}','cu-1','${USER}','Site walk', true, NULL),
      ('${FILE2}','${DEAL}','cu-2','${USER}','Crew photo', true, NULL);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

describe("createFieldScorecard (leadership)", () => {
  it("persists kind='leadership', the summary, and the 4 category items with the average score", async () => {
    const { scorecard, created } = await createFieldScorecard(
      tdb,
      leadershipSubmission({ items: leadershipItems({ quality_control: 10, safety: 6 }) }), // (10+6+8+8)/4 = 8
    );
    expect(created).toBe(true);
    expect(scorecard.kind).toBe("leadership");
    expect(scorecard.formVersion).toBe(2);
    expect(scorecard.averageScore).toBe(8);
    expect(scorecard.totalScore).toBe(80);
    expect(scorecard.ratingLabel).toBe("Meets Standard");

    const row = await tdb.execute(sql`SELECT kind, summary FROM field_scorecards WHERE id = ${scorecard.id}`);
    expect(row.rows[0].kind).toBe("leadership");
    expect(row.rows[0].summary).toBe("Strong week overall; keep the housekeeping cadence up.");

    const items = await tdb.execute(sql`SELECT count(*)::int AS n FROM field_scorecard_items`);
    expect(items.rows[0].n).toBe(4);
  });

  it("returns leadership detail with the 4 items in canonical order and the summary", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      leadershipSubmission({ clientSubmissionId: csid(2), items: leadershipItems({ safety: 10, quality_control: 9, schedule_adherence: 9, site_staff_feedback: 8 }) }),
    );
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS);
    expect(detail.kind).toBe("leadership");
    expect(detail.items).toHaveLength(4);
    expect(detail.items.map((i) => i.sectionKey)).toEqual([...LEADERSHIP_KEYS]); // canonical order
    expect(detail.summary).toBe("Strong week overall; keep the housekeeping cadence up.");
    expect(detail.criticalDeficiencies).toEqual([]);
    expect(detail.actionItems).toEqual([]);
  });

  it("attaches Project Summary photos and rejects a below-1 category point", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      leadershipSubmission({
        clientSubmissionId: csid(3),
        photos: [
          { sectionKey: "project_summary", clientUploadId: "cu-1" },
          { sectionKey: "project_summary", clientUploadId: "cu-2" },
        ],
      }),
    );
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, ACCESS);
    expect(detail.photos).toHaveLength(2);
    expect(detail.photos.every((p) => p.sectionKey === "project_summary")).toBe(true);

    await expect(
      createFieldScorecard(tdb, leadershipSubmission({ clientSubmissionId: csid(4), items: leadershipItems({ safety: 0 }) })),
    ).rejects.toThrow(/point|safety/i);
  });

  it("rejects a leadership submission missing a category and rejects a non-summary photo section", async () => {
    await expect(
      createFieldScorecard(tdb, leadershipSubmission({ clientSubmissionId: csid(5), items: leadershipItems().slice(0, 3) })),
    ).rejects.toThrow(/section/i);

    await expect(
      createFieldScorecard(
        tdb,
        leadershipSubmission({ clientSubmissionId: csid(6), photos: [{ sectionKey: "safety", clientUploadId: "cu-1" }] }),
      ),
    ).rejects.toThrow(/section/i);
  });

  it("enqueues the same durable field_scorecard_email job for a leadership card", async () => {
    await createFieldScorecard(tdb, leadershipSubmission({ clientSubmissionId: csid(7) }));
    const jobs = await tdb.execute(
      sql`SELECT job_type, payload FROM public.job_queue WHERE job_type = 'field_scorecard_email'`,
    );
    expect(jobs.rows).toHaveLength(1);
    expect(jobs.rows[0].payload.kind).toBe("leadership");
    expect(jobs.rows[0].payload.ratingLabel).toBe("Meets Standard");
  });

  it("lists a leadership card alongside the project's scorecards", async () => {
    const { scorecard } = await createFieldScorecard(tdb, leadershipSubmission({ clientSubmissionId: csid(8) }));
    const list = await listFieldScorecardsForProject(tdb, ACCESS, DEAL);
    expect(list.scorecards).toHaveLength(1);
    expect(list.scorecards[0].id).toBe(scorecard.id);
    expect(list.scorecards[0].kind).toBe("leadership");
  });
});
