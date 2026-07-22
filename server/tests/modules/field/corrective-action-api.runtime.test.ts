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

  it("orders action items NUMERICALLY by ref, not lexically (finding 5)", async () => {
    // 12 action items → numeric-string refs "0".."11". A lexical sort would interleave 0,1,10,11,2,…; the
    // query must return them in numeric (== seed/input) order so the responder surfaces show the real sequence.
    const actionItems = Array.from({ length: 12 }, (_, i) => `Fix ${i}`);
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission({ actionItems }));
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const actionLabels = items.filter((i) => i.itemType === "action_item").map((i) => i.itemLabel);
    expect(actionLabels).toEqual(actionItems);
  });

  it("throws 404 when the scorecard has no corrective-action items (or does not exist)", async () => {
    await expect(getCorrectiveActionItems(tdb, "00000000-0000-0000-0000-0000000000ff")).rejects.toBeInstanceOf(
      AppError,
    );
  });

  it("resolves a non-null url for each response photo via resolvePhotoUrl", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);
    // Attach a fresh response photo (FILE_B) to the first item.
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "corrective action documented",
      photoFileIds: [FILE_B],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // WITH a resolver: the response photo carries a resolvable url (same shape the evidence read uses).
    const withUrl = await getCorrectiveActionItems(tdb, scorecard.id, {
      resolvePhotoUrl: async (fileId) => `https://r2.example/${fileId}`,
    });
    const resolved = withUrl.find((i) => i.id === first.id)!;
    expect(resolved.photos).toHaveLength(1);
    expect(resolved.photos[0].fileId).toBe(FILE_B);
    expect(resolved.photos[0].url).toBe(`https://r2.example/${FILE_B}`);

    // WITHOUT a resolver: url is null (older deployments / no presigner) — the client falls back to "Unavailable".
    const withoutUrl = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(withoutUrl.find((i) => i.id === first.id)!.photos[0].url).toBeNull();
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

  it("rejects a photo file id that is EXISTING scorecard evidence (no hijack of original evidence) (400)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // FILE_A is already an ORIGINAL evidence photo on this scorecard (section-keyed, no corrective action).
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id, corrective_action_id)
      VALUES (${scorecard.id}, 'quality', NULL, ${FILE_A}, NULL)
    `);

    // Attempting to attach that existing-evidence file id as a RESPONSE photo must be rejected — otherwise
    // it would stamp corrective_action_id and drop it from the PDF/evidence grid (evidence erased).
    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "trying to hijack evidence",
        photoFileIds: [FILE_A],
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).rejects.toBeInstanceOf(AppError);

    // The original evidence row is untouched: still section-keyed, still corrective_action_id NULL (visible).
    const rows = await tdb.execute(
      sql`SELECT section_key, corrective_action_id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id} AND file_id = ${FILE_A}`,
    );
    expect(rows.rows).toHaveLength(1);
    expect(rows.rows[0].section_key).toBe("quality");
    expect(rows.rows[0].corrective_action_id).toBeNull();
    // And the item stayed open (the reject aborted before resolution).
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(items.find((i) => i.id === first.id)!.status).toBe("open");
  });

  it("a STALE submit after the item is already resolved inserts NO orphan photos (losing-path no-op)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // First (winning) submit resolves the item with FILE_A as its response photo.
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the first responder",
      photoFileIds: [FILE_A],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // A SECOND (stale) submit for the SAME now-resolved item — e.g. a concurrent responder or a replayed
    // request — carries its OWN fresh photo (FILE_B). Because the item is no longer `open`, the resolve is a
    // no-op AND the response photo must NOT be inserted (else it orphans onto the winner's finalized response).
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "stale submit from a losing responder",
      photoFileIds: [FILE_B],
      respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
    });

    // The item keeps the WINNER's comment/responder (the stale resolve did not overwrite it).
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseComment).toBe("resolved by the first responder");
    expect(resolved.respondedByUserId).toBe(USER);

    // Only the WINNER's photo (FILE_A) is linked — the loser's FILE_B never became a response-photo row.
    expect(resolved.photos.map((p) => p.fileId)).toEqual([FILE_A]);
    const orphan = await tdb.execute(
      sql`SELECT id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id} AND file_id = ${FILE_B}`,
    );
    expect(orphan.rows).toHaveLength(0);
  });

  it("inserts a FRESH file as a NEW response photo (corrective_action_id set) that never appears as evidence", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // Seed an original evidence photo (FILE_A) so we can prove the evidence query still surfaces it while
    // excluding the fresh response photo (FILE_B).
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id, corrective_action_id)
      VALUES (${scorecard.id}, 'quality', NULL, ${FILE_A}, NULL)
    `);

    // FILE_B is fresh (no field_scorecard_photos row yet) → inserted as a NEW response photo row.
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "corrective action documented",
      photoFileIds: [FILE_B],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // The response photo is attached to the item (corrective_action_id set, section_key null).
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.photos.map((p) => p.fileId)).toEqual([FILE_B]);

    const responseRow = await tdb.execute(
      sql`SELECT section_key, corrective_action_id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id} AND file_id = ${FILE_B}`,
    );
    expect(responseRow.rows).toHaveLength(1);
    expect(responseRow.rows[0].section_key).toBeNull();
    expect(responseRow.rows[0].corrective_action_id).toBe(first.id);

    // The evidence/PDF query (corrective_action_id IS NULL) surfaces ONLY the original evidence (FILE_A),
    // never the response photo (FILE_B).
    const evidence = await tdb.execute(
      sql`SELECT file_id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id} AND corrective_action_id IS NULL`,
    );
    const evidenceFileIds = (evidence.rows as { file_id: string }[]).map((r) => r.file_id);
    expect(evidenceFileIds).toContain(FILE_A);
    expect(evidenceFileIds).not.toContain(FILE_B);
  });
});
