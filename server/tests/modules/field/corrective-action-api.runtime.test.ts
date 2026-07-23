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
  scorecardCorrectiveActionUploads,
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
      scorecardCorrectiveActionUploads,
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
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_uploads`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

// A legitimate corrective-action response photo is created via confirmCorrectiveActionUpload, which writes a
// durable ownership ledger row (scorecard_corrective_action_uploads: file_id + scorecard_id). The freshness
// gate proves provenance off that ledger, so success-path tests must seed the ledger row(s) the confirm step
// would have written for THIS scorecard.
async function seedUploadLedger(scorecardId: string, fileIds: string[]): Promise<void> {
  for (const fileId of fileIds) {
    await tdb.execute(sql`
      INSERT INTO scorecard_corrective_action_uploads (file_id, scorecard_id)
      VALUES (${fileId}, ${scorecardId})
      ON CONFLICT (file_id) DO NOTHING
    `);
  }
}

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
    await seedUploadLedger(scorecard.id, [FILE_B]);
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

    await seedUploadLedger(scorecard.id, [FILE_A, FILE_B]);
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

  it("rejects a photo file id already linked on a SIBLING scorecard of the SAME deal (no cross-scorecard evidence recorded as fresh) (400)", async () => {
    // Two scorecards on the SAME deal. FILE_B is already a photo on the SIBLING scorecard (section evidence
    // there). Using it as a corrective-action RESPONSE photo on THIS scorecard passes the deal-membership
    // check (same deal) but must be REJECTED: it is not a fresh upload for THIS scorecard (no ledger row here),
    // so recording it as a fresh response photo would corrupt the response audit trail with foreign evidence.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const { scorecard: sibling } = await createFieldScorecard(
      tdb,
      belowBandSubmission({ clientSubmissionId: csid(101) }),
    );
    expect(sibling.id).not.toBe(scorecard.id);
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // FILE_B is an original evidence photo on the SIBLING scorecard (same deal, different scorecard).
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id, corrective_action_id)
      VALUES (${sibling.id}, 'quality', NULL, ${FILE_B}, NULL)
    `);

    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "borrowing a sibling scorecard's photo",
        photoFileIds: [FILE_B],
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).rejects.toBeInstanceOf(AppError);

    // No second link was created on THIS scorecard, and the sibling's evidence row is untouched.
    const here = await tdb.execute(
      sql`SELECT id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id} AND file_id = ${FILE_B}`,
    );
    expect(here.rows).toHaveLength(0);
    const there = await tdb.execute(
      sql`SELECT section_key, corrective_action_id FROM field_scorecard_photos WHERE scorecard_id = ${sibling.id} AND file_id = ${FILE_B}`,
    );
    expect(there.rows).toHaveLength(1);
    expect(there.rows[0].section_key).toBe("quality");
    expect(there.rows[0].corrective_action_id).toBeNull();
    // The item stayed open (rejected before resolution).
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(items.find((i) => i.id === first.id)!.status).toBe("open");
  });

  it("rejects a deal file that has NO corrective-action upload ledger row for this scorecard (not a fresh response upload) (400)", async () => {
    // FILE_A belongs to the deal and is NOT existing evidence anywhere, but it was never uploaded through the
    // corrective-action flow for THIS scorecard (no ledger row). It must be rejected — provenance is proven by
    // the ledger, not mere deal membership, so an arbitrary project file can't be laundered into the response.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "attaching an arbitrary deal file",
        photoFileIds: [FILE_A],
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).rejects.toBeInstanceOf(AppError);
    expect(await getScorecardStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("a STALE submit WITH photos after the item is already resolved 409s + inserts NO orphan photos (finding I)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // First (winning) submit resolves the item with FILE_A as its response photo.
    await seedUploadLedger(scorecard.id, [FILE_A]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the first responder",
      photoFileIds: [FILE_A],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // A SECOND (stale) submit for the SAME now-resolved item — e.g. a concurrent responder or a replayed
    // request — carries its OWN fresh photo (FILE_B). Because the item is no longer `open` AND photos were
    // supplied, this must 409 (code CORRECTIVE_ACTION_ALREADY_RESOLVED) so the caller discards the orphaned
    // upload — and the response photo must NOT be inserted (else it orphans onto the winner's response).
    let thrown: unknown;
    try {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "stale submit from a losing responder",
        photoFileIds: [FILE_B],
        respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("CORRECTIVE_ACTION_ALREADY_RESOLVED");

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

  it("a bare re-submit (NO photos) by the SAME responder of an already-resolved item is an idempotent no-op, not a 409 (finding I / P2)", async () => {
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the first responder",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // A replayed comment-only submit by the SAME responder (the winner) is an idempotent success — nothing to
    // discard, no competing response.
    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "replay with no photos",
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).resolves.toBeUndefined();

    // The winner's response is preserved.
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseComment).toBe("resolved by the first responder");
    expect(resolved.respondedByUserId).toBe(USER);
  });

  it("a bare re-submit (NO photos) by a DIFFERENT responder of an already-resolved item 409s (comment-only race loser) (finding P2)", async () => {
    // Two responders (a super and a PM) submit COMMENT-ONLY responses for the same item concurrently. The
    // winner resolves it; the LOSER hits the already-resolved branch. Because the loser is a DIFFERENT responder
    // (not a same-responder replay), the loser must get a 409 CORRECTIVE_ACTION_ALREADY_RESOLVED — NOT a 200
    // no-op that would make the loser's client clear its comment + report a phantom success.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    // The winner (session super) resolves it comment-only.
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the super",
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // The loser (a DIFFERENT, token PM) submits comment-only after the winner resolved → 409.
    let thrown: unknown;
    try {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "PM's comment that lost the race",
        respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("CORRECTIVE_ACTION_ALREADY_RESOLVED");

    // The winner's response is untouched (the loser's comment never overwrote it).
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseComment).toBe("resolved by the super");
    expect(resolved.respondedByUserId).toBe(USER);
  });

  it("an EXACT replay WITH photos of a resolved item (same responder + same linked fileIds) is idempotent success, no 409, no duplicate insert (finding P2)", async () => {
    // A lost-response retry: the FIRST submission committed (item resolved, FILE_A + FILE_B attached) but its
    // HTTP response was lost, so the client re-POSTs the SAME request. The exact files are already linked to
    // this item → the replay must return SUCCESS (the route re-reads the refreshed thread), NOT a false 409,
    // and must NOT re-insert the photo rows (which would also violate the unique (scorecard_id, file_id) index).
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await seedUploadLedger(scorecard.id, [FILE_A, FILE_B]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved with two response photos",
      photoFileIds: [FILE_A, FILE_B],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // The SAME responder retries the SAME submission (order of fileIds differs — sets, not sequences).
    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "resolved with two response photos",
        photoFileIds: [FILE_B, FILE_A],
        respondedBy: { userId: USER, name: "Sam", email: null },
      }),
    ).resolves.toBeUndefined();

    // The item keeps the ORIGINAL response (comment/responder unchanged) and its EXACT two photos — no dup rows.
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    const resolved = items.find((i) => i.id === first.id)!;
    expect(resolved.status).toBe("resolved");
    expect(resolved.responseComment).toBe("resolved with two response photos");
    expect(resolved.respondedByUserId).toBe(USER);
    expect(resolved.photos.map((p) => p.fileId).sort()).toEqual([FILE_A, FILE_B].sort());
    const links = await tdb.execute(
      sql`SELECT file_id FROM field_scorecard_photos WHERE corrective_action_id = ${first.id}`,
    );
    expect(links.rows).toHaveLength(2);
  });

  it("an EXACT replay by a TOKEN responder (matched on email) of a resolved item is idempotent success, no 409 (finding P2)", async () => {
    // The token (email-only) flow has no userId — the same-responder check falls back to responder_email.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await seedUploadLedger(scorecard.id, [FILE_A]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the external PM",
      photoFileIds: [FILE_A],
      respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
    });

    await expect(
      submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "resolved by the external PM",
        photoFileIds: [FILE_A],
        respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
      }),
    ).resolves.toBeUndefined();

    const links = await tdb.execute(
      sql`SELECT file_id FROM field_scorecard_photos WHERE corrective_action_id = ${first.id}`,
    );
    expect(links.rows).toHaveLength(1);
    expect((links.rows[0] as { file_id: string }).file_id).toBe(FILE_A);
  });

  it("a SAME-responder submit with a DIFFERENT photo set on a resolved item still 409s (not a replay) (finding P2)", async () => {
    // Same responder, but the supplied fileIds differ from what is already linked → NOT an exact replay → 409.
    // This proves the replay gate requires BOTH same-responder AND same-photo-set (the AND semantics).
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await seedUploadLedger(scorecard.id, [FILE_A, FILE_B]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved with FILE_A",
      photoFileIds: [FILE_A],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // Same responder, but a DIFFERENT fresh file (FILE_B) that did NOT attach → competing/stale submit → 409.
    let thrown: unknown;
    try {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "trying to add another photo after resolution",
        photoFileIds: [FILE_B],
        respondedBy: { userId: USER, name: "Sam", email: null },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("CORRECTIVE_ACTION_ALREADY_RESOLVED");

    // Only the winner's FILE_A is linked; FILE_B never became a row.
    const links = await tdb.execute(
      sql`SELECT file_id FROM field_scorecard_photos WHERE corrective_action_id = ${first.id}`,
    );
    expect((links.rows as { file_id: string }[]).map((r) => r.file_id)).toEqual([FILE_A]);
  });

  it("a DIFFERENT responder submitting the SAME photo set on a resolved item still 409s (not a replay) (finding P2)", async () => {
    // The linked photo set matches, but a DIFFERENT responder submitted — NOT an exact replay → 409. Proves the
    // same-photo-set alone is not enough; the responder identity must also match.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first] = await getCorrectiveActionItems(tdb, scorecard.id);

    await seedUploadLedger(scorecard.id, [FILE_A]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "resolved by the session responder",
      photoFileIds: [FILE_A],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // A token responder re-supplies the SAME already-linked FILE_A → different responder → 409, not a replay.
    let thrown: unknown;
    try {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId: scorecard.id,
        itemId: first.id,
        comment: "external PM submitting the same file",
        photoFileIds: [FILE_A],
        respondedBy: { userId: null, name: "Ext PM", email: "pm@x.com" },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    expect((thrown as AppError).statusCode).toBe(409);
    expect((thrown as AppError).code).toBe("CORRECTIVE_ACTION_ALREADY_RESOLVED");

    // The winner's response identity is untouched.
    const items = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(items.find((i) => i.id === first.id)!.respondedByUserId).toBe(USER);
  });

  it("rejects a fileId ALREADY linked as a response photo on THIS scorecard with a controlled 409 (not a 500) (finding P2)", async () => {
    // A response photo (FILE_B) is uploaded (ledgered) then submitted on item 1 → it now has a
    // field_scorecard_photos row on THIS scorecard AND its ledger row PERSISTS. Re-supplying that SAME
    // fileId on item 2 passes the deal-membership + ledger checks (ledger rows are never deleted), so the
    // insert would violate the unique (scorecard_id, file_id) index → an uncaught 500, leaving item 2 open.
    // The submit must instead reject the already-linked file with a CONTROLLED error and leave item 2 open.
    const items = await createFieldScorecard(tdb, belowBandSubmission()).then(({ scorecard }) =>
      getCorrectiveActionItems(tdb, scorecard.id).then((its) => ({ scorecardId: scorecard.id, its })),
    );
    const scorecardId = items.scorecardId;
    const [first, second] = items.its;

    // Ledger FILE_B, then submit it as first's response photo (resolves item 1, links FILE_B).
    await seedUploadLedger(scorecardId, [FILE_B]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId,
      itemId: first.id,
      comment: "resolved with a response photo",
      photoFileIds: [FILE_B],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    // Now (mis)supply the SAME already-linked FILE_B for the still-open item 2. It is still ledgered, so it
    // slips past the freshness gate; the code must catch the already-linked file BEFORE the insert.
    let thrown: unknown;
    try {
      await submitCorrectiveActionResponse(tdb, {
        scorecardId,
        itemId: second.id,
        comment: "reusing an already-linked file id",
        photoFileIds: [FILE_B],
        respondedBy: { userId: USER, name: "Sam", email: null },
      });
    } catch (err) {
      thrown = err;
    }
    expect(thrown).toBeInstanceOf(AppError);
    // A controlled 4xx (not a 500 from the unique-index violation).
    expect((thrown as AppError).statusCode).toBeLessThan(500);

    // Item 2 is unaffected (still open); FILE_B is still linked ONCE (to item 1), never duplicated.
    const after = await getCorrectiveActionItems(tdb, scorecardId);
    expect(after.find((i) => i.id === second.id)!.status).toBe("open");
    const links = await tdb.execute(
      sql`SELECT corrective_action_id FROM field_scorecard_photos WHERE scorecard_id = ${scorecardId} AND file_id = ${FILE_B}`,
    );
    expect(links.rows).toHaveLength(1);
    expect(links.rows[0].corrective_action_id).toBe(first.id);
  });

  it("a genuinely FRESH ledgered file still resolves after another item was resolved with a different file (finding P2 regression)", async () => {
    // Guard the finding-P2 fix doesn't over-reject: a DISTINCT fresh ledgered file on a second item must
    // still link + resolve normally.
    const { scorecard } = await createFieldScorecard(tdb, belowBandSubmission());
    const [first, second] = await getCorrectiveActionItems(tdb, scorecard.id);

    await seedUploadLedger(scorecard.id, [FILE_A, FILE_B]);
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: first.id,
      comment: "item 1 done",
      photoFileIds: [FILE_A],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });
    await submitCorrectiveActionResponse(tdb, {
      scorecardId: scorecard.id,
      itemId: second.id,
      comment: "item 2 done with a different fresh file",
      photoFileIds: [FILE_B],
      respondedBy: { userId: USER, name: "Sam", email: null },
    });

    const after = await getCorrectiveActionItems(tdb, scorecard.id);
    expect(after.find((i) => i.id === first.id)!.photos.map((p) => p.fileId)).toEqual([FILE_A]);
    expect(after.find((i) => i.id === second.id)!.photos.map((p) => p.fileId)).toEqual([FILE_B]);
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

    // FILE_B is fresh (no field_scorecard_photos row yet, ledger-backed) → inserted as a NEW response photo row.
    await seedUploadLedger(scorecard.id, [FILE_B]);
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
