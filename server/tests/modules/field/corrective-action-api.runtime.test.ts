import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createFieldScorecard } from "../../../src/modules/field/scorecards-service.js";
import {
  getCorrectiveActionItems,
  submitCorrectiveActionResponse,
} from "../../../src/modules/field/corrective-action-api.js";
import { AppError } from "../../../src/middleware/error-handler.js";
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
const FILE_A = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE_B = "aaaaaaaa-0000-0000-0000-000000000002";

const csid = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

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
function belowBandSubmission(over: Record<string, unknown> = {}) {
  return {
    userId: USER,
    userRole: "field_contractor" as const,
    submittedByName: "Marcus Reed",
    dealId: DEAL,
    office: { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" },
    clientSubmissionId: csid(100),
    weekOf: "2026-06-30",
    superintendentName: "Marcus Reed",
    pmName: "Dana Cole",
    projectNumber: "DFW-10432",
    items: fullItems({ schedule: 0, quality: 0 }),
    criticalDeficiencies: ["missed_hold_point"],
    actionItems: ["Re-inspect slab 2", "Verify hold points"],
    photos: [] as { sectionKey: string; clientUploadId: string }[],
    ...over,
  };
}

let pg: PGlite;
let tdb: any;

async function getScorecardStatus(id: string): Promise<string> {
  const res = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${id}`);
  return (res.rows[0] as { status: string }).status;
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
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true);
    INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, is_active) VALUES
      ('${FILE_A}','${DEAL}','up-a','${USER}', true),
      ('${FILE_B}','${DEAL}','up-b','${USER}', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`UPDATE field_scorecard_photos SET corrective_action_id = NULL`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

describe("getCorrectiveActionItems", () => {
  it("returns the scorecard's items with their (empty then filled) response fields", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(items).toHaveLength(3);
    expect(items.every((i) => i.status === "open")).toBe(true);
    expect(items.every((i) => i.responseComment === null)).toBe(true);
    // Shape: id, itemType, itemRef, itemLabel, status, responseComment, responder fields, respondedAt.
    expect(Object.keys(items[0]).sort()).toEqual(
      [
        "id",
        "itemLabel",
        "itemRef",
        "itemType",
        "photos",
        "respondedAt",
        "responderEmail",
        "responderName",
        "respondedByUserId",
        "responseComment",
        "status",
      ].sort(),
    );
  });

  it("throws 404 when the scorecard has no corrective-action items (or does not exist)", async () => {
    await expect(getCorrectiveActionItems(tdb, "00000000-0000-0000-0000-0000000000ff")).rejects.toBeInstanceOf(
      AppError,
    );
  });
});

describe("submitCorrectiveActionResponse", () => {
  it("resolves an item, stamps the session responder, and links the photos", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "Slab re-inspected",
      photoFileIds: [FILE_A, FILE_B],
      respondedBy: { userId: USER, name: "Sam Field", email: null },
    });

    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseComment).toBe("Slab re-inspected");
    expect(resolved.respondedByUserId).toBe(USER);
    expect(resolved.photos.map((p) => p.fileId).sort()).toEqual([FILE_A, FILE_B].sort());

    // The scorecard stays open (2 items remain).
    expect(await getScorecardStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("closes the scorecard when the LAST item is resolved (either responder)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    for (const [idx, item] of items.entries()) {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: item.id,
        comment: "fixed",
        // Alternate responder identity: last is an email-only (token) responder.
        respondedBy:
          idx === items.length - 1
            ? { userId: null, name: "Ext PM", email: "pm@x.com" }
            : { userId: USER, name: "Sam", email: null },
      });
    }
    expect(await getScorecardStatus(scorecard.id)).toBe("corrective_action_closed");
  });

  it("rejects a photo file id that does not belong to the deal (400)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);
    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "x",
        photoFileIds: ["bbbbbbbb-0000-0000-0000-0000000000ff"],
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });

  it("rejects an item that does not belong to the scorecard (404)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: "00000000-0000-0000-0000-0000000000ee",
        comment: "x",
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).rejects.toBeInstanceOf(AppError);
  });
});
