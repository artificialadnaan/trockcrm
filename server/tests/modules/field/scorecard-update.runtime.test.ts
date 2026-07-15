import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  createFieldScorecard,
  getFieldScorecardDetail,
  listFieldScorecardsForProject,
  listRecentFieldScorecards,
  updateFieldScorecard,
  type UpdateFieldScorecardInput,
} from "../../../src/modules/field/scorecards-service.js";
import {
  authorizeScorecardEditEvidenceUpload,
  discardScorecardEditEvidence,
  lockScorecardEditEvidenceUploadForConfirm,
} from "../../../src/modules/field/scorecard-evidence-upload.js";
import {
  contacts,
  dealTeamMembers,
  fieldScorecardEditUploads,
  fieldScorecardItems,
  fieldScorecardPhotos,
  fieldScorecards,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };
const DEAL = "11111111-1111-1111-1111-111111111111";
const OWNER = "33333333-3333-3333-3333-333333333333";
const OTHER_USER = "44444444-4444-4444-4444-444444444444";
const FILE_1 = "aaaaaaaa-0000-0000-0000-000000000001";
const FILE_2 = "aaaaaaaa-0000-0000-0000-000000000002";
const FILE_3 = "aaaaaaaa-0000-0000-0000-000000000003";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const OWNER_ACCESS = { userId: OWNER, userRole: "field_contractor" as const };
const OTHER_ACCESS = { userId: OTHER_USER, userRole: "admin" as const };
const csid = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

const PROJECT_KEYS = [
  "planning_precon",
  "jobsite_5s",
  "safety",
  "schedule",
  "subcontractor",
  "quality",
  "communication",
  "financial",
] as const;
const LEADERSHIP_KEYS = ["quality_control", "safety", "schedule_adherence", "site_staff_feedback"] as const;

let pg: PGlite;
let tdb: any;

function projectItems(points = 8, note?: string) {
  return PROJECT_KEYS.map((sectionKey) => ({
    sectionKey,
    points,
    note: sectionKey === "planning_precon" ? note : undefined,
  }));
}

function leadershipItems(points = 8) {
  return LEADERSHIP_KEYS.map((sectionKey) => ({ sectionKey, points, note: `${sectionKey} note` }));
}

function projectSubmission(overrides: Record<string, unknown> = {}) {
  return {
    userId: OWNER,
    userRole: "field_contractor" as const,
    submittedByName: "Original Evaluator",
    dealId: DEAL,
    office: OFFICE,
    clientSubmissionId: csid(1),
    weekOf: "2026-07-14",
    formVersion: 2 as const,
    kind: "project" as const,
    superintendentName: "Original Superintendent",
    pmName: "Original PM",
    projectNumber: "CLIENT-SPOOFED",
    items: projectItems(),
    criticalDeficiencies: [] as string[],
    criticalDeficiencyNotes: {},
    actionItems: [] as string[],
    photos: [] as Array<{ sectionKey: string; deficiencyKey?: string | null; clientUploadId: string }>,
    superintendentSignature: "Original superintendent signature",
    pmSignature: "Original PM signature",
    ...overrides,
  };
}

function updateInput(
  scorecardId: string,
  expectedUpdatedAt: string,
  overrides: Partial<UpdateFieldScorecardInput> = {},
): UpdateFieldScorecardInput {
  return {
    userId: OWNER,
    userRole: "field_contractor",
    scorecardId,
    expectedUpdatedAt,
    superintendentName: "Updated Superintendent",
    pmName: "Updated PM",
    items: projectItems(10, "Updated plan"),
    criticalDeficiencies: [],
    criticalDeficiencyNotes: {},
    actionItems: ["Close the remaining punch items"],
    photos: [],
    superintendentSignature: "data:image/png;base64,new-superintendent-signature",
    pmSignature: "Updated PM typed signature",
    summary: null,
    ...overrides,
  };
}

async function bindConfirmedEditUpload(
  scorecardId: string,
  clientUploadId = "upload-3",
  fileId = FILE_3,
) {
  await tdb.insert(fieldScorecardEditUploads).values({
    scorecardId,
    dealId: DEAL,
    clientUploadId,
    uploadedBy: OWNER,
    fileId,
    state: "confirmed",
  });
}

async function expectAppError(promise: Promise<unknown>, statusCode: number, code?: string) {
  try {
    await promise;
    expect.fail("Expected AppError");
  } catch (error) {
    expect(error).toMatchObject({ statusCode, ...(code ? { code } : {}) });
  }
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, name text, slug text, is_terminal boolean DEFAULT false
    );
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, project_number text, stage_id uuid,
      is_active boolean DEFAULT true, bid_board_stage_slug text,
      property_address text, property_city text, property_state text, property_zip text,
      last_activity_at timestamptz, updated_at timestamptz, created_at timestamptz DEFAULT now()
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, client_upload_id text, uploaded_by uuid,
      description text, tags text[] DEFAULT ARRAY['scorecard']::text[],
      is_active boolean DEFAULT true, deleted_at timestamptz, deleted_by_user_id uuid,
      created_at timestamptz DEFAULT now()
    );
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE TABLE public.users (
      id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true
    );
  `);
  await pg.exec(tenantSchemaSql("public", [
    fieldScorecards,
    fieldScorecardItems,
    fieldScorecardPhotos,
    fieldScorecardEditUploads,
    dealTeamMembers,
    contacts,
  ]));
  await pg.exec("ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id)");
  await pg.exec("ALTER TABLE public.field_scorecard_edit_uploads ADD CONSTRAINT field_scorecard_edit_uploads_client_uniq UNIQUE (client_upload_id)");
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal)
    VALUES ('${STAGE_ACTIVE}', 'Estimating', 'estimating', false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active)
    VALUES ('${DEAL}', 'Riverwalk Apartments', 'DFW-1-10000-aa', '${STAGE_ACTIVE}', true);
    INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description, is_active, deleted_at) VALUES
      ('${FILE_1}', '${DEAL}', 'upload-1', '${OWNER}', 'Original first photo', true, NULL),
      ('${FILE_2}', '${DEAL}', 'upload-2', '${OWNER}', 'Original second photo', true, NULL),
      ('${FILE_3}', '${DEAL}', 'upload-3', '${OWNER}', 'New edit photo', true, NULL);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM field_scorecard_edit_uploads`);
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
  await tdb.execute(sql`DELETE FROM files WHERE id NOT IN (${FILE_1}, ${FILE_2}, ${FILE_3})`);
  await tdb.execute(sql`
    UPDATE files
    SET is_active = true, deleted_at = NULL, deleted_by_user_id = NULL,
        tags = ARRAY['scorecard']::text[]
  `);
});

describe("updateFieldScorecard authorization and visibility", () => {
  it("durably binds one client upload id to the exact scorecard, deal, and submitter", async () => {
    const first = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(4) }));
    const second = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(5) }));
    const input = {
      scorecardId: first.scorecard.id,
      clientUploadId: "bound-upload-1",
      userId: OWNER,
      target: { dealId: DEAL },
    };
    await expect(authorizeScorecardEditEvidenceUpload(tdb, input)).resolves.toEqual({
      scorecardId: first.scorecard.id,
      clientUploadId: "bound-upload-1",
    });
    await expect(authorizeScorecardEditEvidenceUpload(tdb, input)).resolves.toEqual({
      scorecardId: first.scorecard.id,
      clientUploadId: "bound-upload-1",
    });
    await expectAppError(
      authorizeScorecardEditEvidenceUpload(tdb, { ...input, scorecardId: second.scorecard.id }),
      409,
      "SCORECARD_EDIT_UPLOAD_SCOPE",
    );
  });

  it("discards only exact unlinked scorecard uploads for the submitter and leaves linked/unrelated files", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(9),
      photos: [{ sectionKey: "quality", clientUploadId: "upload-2" }],
    }));
    // Registry ownership is server-only (not a gallery tag): upload-3 confirmed but never linked, while
    // upload-2 was successfully linked once and is permanently cleanup-safe. upload-1 has no edit binding.
    await tdb.insert(fieldScorecardEditUploads).values([
      {
        scorecardId: scorecard.id,
        dealId: DEAL,
        clientUploadId: "upload-2",
        uploadedBy: OWNER,
        fileId: FILE_2,
        state: "linked",
      },
      {
        scorecardId: scorecard.id,
        dealId: DEAL,
        clientUploadId: "upload-3",
        uploadedBy: OWNER,
        fileId: FILE_3,
        state: "confirmed",
      },
    ]);

    await expect(discardScorecardEditEvidence(tdb, {
      scorecardId: scorecard.id,
      userId: OWNER,
      clientUploadIds: ["upload-1", "upload-2", "upload-3", "upload-3", "unknown"],
    })).resolves.toEqual({ discarded: 1 });

    const rows = (await tdb.execute(sql`
      SELECT id, is_active, deleted_at, deleted_by_user_id
      FROM files
      ORDER BY id
    `)).rows as any[];
    expect(rows).toEqual([
      expect.objectContaining({ id: FILE_1, is_active: true, deleted_at: null, deleted_by_user_id: null }),
      expect.objectContaining({ id: FILE_2, is_active: true, deleted_at: null, deleted_by_user_id: null }),
      expect.objectContaining({ id: FILE_3, is_active: false, deleted_by_user_id: OWNER }),
    ]);
    expect(rows[2].deleted_at).toBeTruthy();
    const bindings = (await tdb.execute(sql`
      SELECT client_upload_id, state FROM field_scorecard_edit_uploads ORDER BY client_upload_id
    `)).rows;
    expect(bindings).toEqual([
      { client_upload_id: "unknown", state: "discarded" },
      { client_upload_id: "upload-2", state: "linked" },
      { client_upload_id: "upload-3", state: "discarded" },
    ]);

    // Idempotent after app termination/retry: the already-hidden row is simply absent from candidates.
    await expect(discardScorecardEditEvidence(tdb, {
      scorecardId: scorecard.id,
      userId: OWNER,
      clientUploadIds: ["upload-3"],
    })).resolves.toEqual({ discarded: 0 });
  });

  it("durably tombstones an authorized upload so a late/timed-out confirm cannot create an orphan", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(7) }));
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: scorecard.id,
      dealId: DEAL,
      clientUploadId: "late-confirm-1",
      uploadedBy: OWNER,
      state: "authorized",
    });

    await expect(discardScorecardEditEvidence(tdb, {
      scorecardId: scorecard.id,
      userId: OWNER,
      clientUploadIds: ["late-confirm-1"],
    })).resolves.toEqual({ discarded: 0 });
    const [binding] = (await tdb.execute(sql`
      SELECT state FROM field_scorecard_edit_uploads WHERE client_upload_id = 'late-confirm-1'
    `)).rows as any[];
    expect(binding.state).toBe("discarded");

    await expectAppError(
      lockScorecardEditEvidenceUploadForConfirm(tdb, {
        userId: OWNER,
        dealId: DEAL,
        scorecardId: scorecard.id,
        clientUploadId: "late-confirm-1",
        pendingScope: { scorecardId: scorecard.id, clientUploadId: "late-confirm-1" },
        pendingUploadFound: true,
      }),
      409,
      "SCORECARD_EDIT_UPLOAD_DISCARDED",
    );

    // The ledger also wins if cleanup reaches the server before an in-flight upload-url transaction.
    await expect(discardScorecardEditEvidence(tdb, {
      scorecardId: scorecard.id,
      userId: OWNER,
      clientUploadIds: ["late-authorization-1"],
    })).resolves.toEqual({ discarded: 0 });
    await expectAppError(
      authorizeScorecardEditEvidenceUpload(tdb, {
        scorecardId: scorecard.id,
        clientUploadId: "late-authorization-1",
        userId: OWNER,
        target: { dealId: DEAL },
      }),
      409,
      "SCORECARD_EDIT_UPLOAD_DISCARDED",
    );
  });

  it("rejects generic-to-scoped, swapped-scorecard, and omitted-scope confirm replays", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(6) }));
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: scorecard.id,
      dealId: DEAL,
      clientUploadId: "scope-check-1",
      uploadedBy: OWNER,
      state: "authorized",
    });

    // A generic upload token cannot be elevated into scorecard evidence at confirm time.
    await expectAppError(
      lockScorecardEditEvidenceUploadForConfirm(tdb, {
        userId: OWNER,
        dealId: DEAL,
        scorecardId: scorecard.id,
        clientUploadId: "scope-check-1",
        pendingUploadFound: true,
      }),
      400,
      "SCORECARD_EDIT_UPLOAD_SCOPE",
    );
    // A token minted for this card cannot be swapped to a different card id.
    await expectAppError(
      lockScorecardEditEvidenceUploadForConfirm(tdb, {
        userId: OWNER,
        dealId: DEAL,
        scorecardId: "99999999-9999-9999-9999-999999999999",
        clientUploadId: "scope-check-1",
        pendingScope: { scorecardId: scorecard.id, clientUploadId: "scope-check-1" },
        pendingUploadFound: true,
      }),
      400,
      "SCORECARD_EDIT_UPLOAD_SCOPE",
    );
    // Omitting scope is rejected both while the token is live and after it is consumed/restarted.
    await expectAppError(
      lockScorecardEditEvidenceUploadForConfirm(tdb, {
        userId: OWNER,
        dealId: DEAL,
        clientUploadId: "scope-check-1",
        pendingScope: { scorecardId: scorecard.id, clientUploadId: "scope-check-1" },
        pendingUploadFound: true,
      }),
      400,
      "SCORECARD_EDIT_UPLOAD_SCOPE",
    );
    await expectAppError(
      lockScorecardEditEvidenceUploadForConfirm(tdb, {
        userId: OWNER,
        dealId: DEAL,
        clientUploadId: "scope-check-1",
        pendingUploadFound: false,
      }),
      409,
      "SCORECARD_EDIT_UPLOAD_SCOPE",
    );
  });

  it("does not let another user clean up the submitter's abandoned edit evidence", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(8) }));
    await expectAppError(
      discardScorecardEditEvidence(tdb, {
        scorecardId: scorecard.id,
        userId: OTHER_USER,
        clientUploadIds: ["upload-3"],
      }),
      403,
      "SCORECARD_EDIT_FORBIDDEN",
    );
    const [row] = (await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${FILE_3}`)).rows as any[];
    expect(row.is_active).toBe(true);
  });

  it("surfaces canEdit only for the exact V2 submitter across all read shapes", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(10) }));
    expect(scorecard.canEdit).toBe(true);
    expect(scorecard.updatedAt).toBeTruthy();

    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).canEdit).toBe(true);
    expect((await getFieldScorecardDetail(tdb, scorecard.id, OTHER_ACCESS)).canEdit).toBe(false);
    expect((await listFieldScorecardsForProject(tdb, OWNER_ACCESS, DEAL)).scorecards[0]?.canEdit).toBe(true);
    expect((await listFieldScorecardsForProject(tdb, OTHER_ACCESS, DEAL)).scorecards[0]?.canEdit).toBe(false);
    expect((await listRecentFieldScorecards(tdb, { viewerUserId: OWNER })).scorecards[0]?.canEdit).toBe(true);
    expect((await listRecentFieldScorecards(tdb, { viewerUserId: OTHER_USER })).scorecards[0]?.canEdit).toBe(false);
  });

  it("denies a different UUID even when that user is an admin", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(11) }));
    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
        userId: OTHER_USER,
        userRole: "admin",
      })),
      403,
      "SCORECARD_EDIT_FORBIDDEN",
    );
    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).totalScore).toBe(80);
  });

  it("rejects historical V1 cards and never advertises them as editable", async () => {
    const { scorecard } = await createFieldScorecard(tdb, {
      ...projectSubmission({ clientSubmissionId: csid(12) }),
      formVersion: 1,
      kind: "project",
      items: [
        { sectionKey: "planning_precon", points: 10 },
        { sectionKey: "jobsite_5s", points: 15 },
        { sectionKey: "schedule", points: 20 },
        { sectionKey: "subcontractor", points: 15 },
        { sectionKey: "quality", points: 20 },
        { sectionKey: "communication", points: 10 },
        { sectionKey: "financial", points: 10 },
      ],
    } as any);
    expect(scorecard.canEdit).toBe(false);
    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!)),
      422,
      "SCORECARD_EDIT_UNSUPPORTED",
    );
  });

  it("preserves hidden gallery evidence across an unrelated edit and restores its original link", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(13),
      photos: [{ sectionKey: "quality", clientUploadId: "upload-1" }],
    }));
    const originalPhoto = (await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos[0]!;

    await tdb.execute(sql`UPDATE files SET is_active = false, deleted_at = NOW() WHERE id = ${FILE_1}`);
    const hiddenDetail = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(hiddenDetail.photos).toEqual([]);

    await updateFieldScorecard(tdb, updateInput(scorecard.id, hiddenDetail.updatedAt!, { photos: [] }));
    const hiddenLinks = (await tdb.execute(sql`
      SELECT id, section_key, deficiency_key
      FROM field_scorecard_photos
      WHERE scorecard_id = ${scorecard.id}
    `)).rows as any[];
    expect(hiddenLinks).toEqual([{
      id: originalPhoto.id,
      section_key: "quality",
      deficiency_key: null,
    }]);

    await tdb.execute(sql`UPDATE files SET is_active = true, deleted_at = NULL WHERE id = ${FILE_1}`);
    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos).toEqual([
      expect.objectContaining({ id: originalPhoto.id, fileId: FILE_1, sectionKey: "quality" }),
    ]);
  });

  it("rejects a replacement whose preserved hidden + editable evidence would exceed 100 links", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(16) }));
    await tdb.execute(sql`
      INSERT INTO files (id, deal_id, client_upload_id, uploaded_by, description, is_active, deleted_at)
      SELECT
        ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid,
        ${DEAL}::uuid,
        'hidden-cap-' || n::text,
        ${OWNER}::uuid,
        'Hidden evidence ' || n::text,
        false,
        now()
      FROM generate_series(1, 101) AS n;
    `);
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id)
      SELECT
        ${scorecard.id}::uuid,
        'quality',
        NULL,
        ('10000000-0000-0000-0000-' || lpad(n::text, 12, '0'))::uuid
      FROM generate_series(1, 101) AS n;
    `);

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, { photos: [] })),
      409,
      "SCORECARD_EDIT_PHOTO_LIMIT",
    );
    const rows = await tdb.execute(sql`
      SELECT count(*)::int AS count FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id}
    `);
    expect(rows.rows[0]?.count).toBe(101);
  });

  it("rejects a hidden evidence link id even when the edit token is current", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(14),
      photos: [{ sectionKey: "quality", clientUploadId: "upload-1" }],
    }));
    const originalPhoto = (await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos[0]!;

    await tdb.execute(sql`UPDATE files SET is_active = false, deleted_at = NOW() WHERE id = ${FILE_1}`);
    const hiddenDetail = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(hiddenDetail.photos).toEqual([]);

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, hiddenDetail.updatedAt!, {
        photos: [{ scorecardPhotoId: originalPhoto.id, sectionKey: "safety", deficiencyKey: null }],
      })),
      422,
    );
    const links = await tdb.execute(sql`
      SELECT id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id}
    `);
    expect(links.rows).toEqual([{ id: originalPhoto.id }]);
  });

  it("preserves hidden deficiency evidence until its parent deficiency is removed", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(15),
      criticalDeficiencies: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Original failed inspection" },
      actionItems: ["Correct the failed inspection"],
      photos: [{
        sectionKey: "critical_deficiency",
        deficiencyKey: "failed_inspection",
        clientUploadId: "upload-1",
      }],
    }));
    const originalPhoto = (await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos[0]!;
    await tdb.execute(sql`UPDATE files SET is_active = false, deleted_at = NOW() WHERE id = ${FILE_1}`);

    const preserved = await updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
      criticalDeficiencies: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Updated failed inspection" },
      photos: [],
    }));
    const preservedLinks = await tdb.execute(sql`
      SELECT id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id}
    `);
    expect(preservedLinks.rows).toEqual([{ id: originalPhoto.id }]);

    await updateFieldScorecard(tdb, updateInput(scorecard.id, preserved.scorecard.updatedAt!, {
      criticalDeficiencies: [],
      criticalDeficiencyNotes: {},
      photos: [],
    }));
    const prunedLinks = await tdb.execute(sql`
      SELECT id FROM field_scorecard_photos WHERE scorecard_id = ${scorecard.id}
    `);
    expect(prunedLinks.rows).toEqual([]);

    await tdb.execute(sql`UPDATE files SET is_active = true, deleted_at = NULL WHERE id = ${FILE_1}`);
    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos).toEqual([]);
  });
});

describe("updateFieldScorecard replacement and concurrency", () => {
  it("recomputes score/rating, replaces editable fields, invalidates the PDF, and preserves identity", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(20) }));
    const originalUpdatedAt = scorecard.updatedAt!;
    await tdb.execute(sql`
      UPDATE field_scorecards
      SET pdf_r2_key = 'scorecards/old.pdf', pdf_r2_bucket = 'private', pdf_generated_at = now()
      WHERE id = ${scorecard.id}
    `);

    const result = await updateFieldScorecard(tdb, updateInput(scorecard.id, originalUpdatedAt, {
      criticalDeficiencies: ["failed_inspection"],
      criticalDeficiencyNotes: { failed_inspection: "Handrail failed inspection" },
    }));
    expect(result.scorecard).toMatchObject({
      id: scorecard.id,
      dealId: DEAL,
      weekOf: "2026-07-14",
      projectNumber: "DFW-1-10000-aa",
      submittedByName: "Original Evaluator",
      totalScore: 100,
      averageScore: 10,
      rating: "elite",
      ratingLabel: "Elite Execution",
      canEdit: true,
      hasPdf: false,
    });
    expect(result.scorecard.updatedAt).not.toBe(originalUpdatedAt);

    const detail = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(detail.items).toHaveLength(8);
    expect(detail.items.every((item) => item.points === 10)).toBe(true);
    expect(detail.items.find((item) => item.sectionKey === "planning_precon")?.note).toBe("Updated plan");
    expect(detail.criticalDeficiencies).toEqual(["failed_inspection"]);
    expect(detail.criticalDeficiencyNotes).toEqual({ failed_inspection: "Handrail failed inspection" });
    expect(detail.actionItems).toEqual(["Close the remaining punch items"]);
    expect(detail.superintendentSignature).toBe("data:image/png;base64,new-superintendent-signature");
    expect(detail.pmSignature).toBe("Updated PM typed signature");
    expect(detail.submittedAt).toBe(scorecard.submittedAt);

    const [row] = (await tdb.execute(sql`
      SELECT pdf_r2_key, pdf_r2_bucket, pdf_generated_at FROM field_scorecards WHERE id = ${scorecard.id}
    `)).rows as any[];
    expect(row).toMatchObject({ pdf_r2_key: null, pdf_r2_bucket: null, pdf_generated_at: null });

    const [job] = (await tdb.execute(sql`
      SELECT payload FROM public.job_queue WHERE payload->>'scorecardId' = ${scorecard.id}
    `)).rows as any[];
    expect(job.payload).toMatchObject({ totalScore: 100, averageScore: 10, ratingLabel: "Elite Execution" });
  });

  it("requires both fresh project signatures before replacing anything", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(21) }));
    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, { pmSignature: "" })),
      422,
    );
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(detail.totalScore).toBe(80);
    expect(detail.pmSignature).toBe("Original PM signature");
  });

  it("rejects a changed stale request but accepts an identical response-loss replay without another bump", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(22) }));
    const staleToken = scorecard.updatedAt!;
    const desired = updateInput(scorecard.id, staleToken);
    const first = await updateFieldScorecard(tdb, desired);
    const currentToken = first.scorecard.updatedAt!;

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, staleToken, {
        items: projectItems(9),
      })),
      409,
      "SCORECARD_EDIT_CONFLICT",
    );

    const replay = await updateFieldScorecard(tdb, desired);
    expect(replay.scorecard.updatedAt).toBe(currentToken);
    expect(replay.scorecard.totalScore).toBe(100);
  });

  it("returns a conflict when a stale edit references evidence another session removed", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(25),
      photos: [{ sectionKey: "quality", clientUploadId: "upload-1" }],
    }));
    const staleToken = scorecard.updatedAt!;
    const before = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    const removedPhoto = before.photos[0]!;

    // The winning session removes the link and advances the optimistic-concurrency token.
    await updateFieldScorecard(tdb, updateInput(scorecard.id, staleToken, { photos: [] }));

    // This was a valid retained link when the losing session opened the form. Its disappearance is a
    // concurrency conflict, not a permanently invalid 422 that the mobile client would retry forever.
    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, staleToken, {
        photos: [{ scorecardPhotoId: removedPhoto.id, sectionKey: "quality", deficiencyKey: null }],
      })),
      409,
      "SCORECARD_EDIT_CONFLICT",
    );

    const after = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(after.photos).toEqual([]);
    expect(after.totalScore).toBe(100);
  });

  it("keeps a stale response-loss replay idempotent when the first edit added evidence", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(26) }));
    await bindConfirmedEditUpload(scorecard.id);
    const staleToken = scorecard.updatedAt!;
    const desired = updateInput(scorecard.id, staleToken, {
      photos: [{ clientUploadId: "upload-3", sectionKey: "quality", deficiencyKey: null }],
    });

    const first = await updateFieldScorecard(tdb, desired);
    const afterFirst = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(afterFirst.photos).toHaveLength(1);
    expect(afterFirst.photos[0]).toMatchObject({ clientUploadId: "upload-3" });

    const replay = await updateFieldScorecard(tdb, desired);
    const afterReplay = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(replay.scorecard.updatedAt).toBe(first.scorecard.updatedAt);
    expect(afterReplay.photos).toEqual(afterFirst.photos);
  });

  it("rejects an ordinary same-project upload id that was not authorized for this submitted edit", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(27) }));

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
        photos: [{ clientUploadId: "upload-3", sectionKey: "quality", deficiencyKey: null }],
      })),
      422,
    );

    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos).toEqual([]);
  });

  it("rejects evidence authorized for a different submitted scorecard on the same project", async () => {
    const { scorecard: target } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(28) }));
    const { scorecard: other } = await createFieldScorecard(tdb, projectSubmission({ clientSubmissionId: csid(29) }));
    await bindConfirmedEditUpload(other.id);

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(target.id, target.updatedAt!, {
        photos: [{ clientUploadId: "upload-3", sectionKey: "quality", deficiencyKey: null }],
      })),
      422,
    );

    expect((await getFieldScorecardDetail(tdb, target.id, OWNER_ACCESS)).photos).toEqual([]);
    const [binding] = (await tdb.execute(sql`
      SELECT scorecard_id, state FROM field_scorecard_edit_uploads WHERE client_upload_id = 'upload-3'
    `)).rows as any[];
    expect(binding).toEqual({ scorecard_id: other.id, state: "confirmed" });
  });

  it.each([
    ["authorized", 30],
    ["discarded", 31],
  ] as const)("rejects %s edit evidence before linking", async (state, submissionNumber) => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      projectSubmission({ clientSubmissionId: csid(submissionNumber) }),
    );
    await tdb.insert(fieldScorecardEditUploads).values({
      scorecardId: scorecard.id,
      dealId: DEAL,
      clientUploadId: "upload-3",
      uploadedBy: OWNER,
      fileId: state === "discarded" ? FILE_3 : null,
      state,
    });

    await expectAppError(
      updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
        photos: [{ clientUploadId: "upload-3", sectionKey: "quality", deficiencyKey: null }],
      })),
      422,
    );
    expect((await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS)).photos).toEqual([]);
  });

  it("retains link identity, unlinks omitted evidence, and adds only the new upload", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(23),
      photos: [
        { sectionKey: "quality", clientUploadId: "upload-1" },
        { sectionKey: "schedule", clientUploadId: "upload-2" },
      ],
    }));
    const before = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    const retained = before.photos.find((photo) => photo.fileId === FILE_1)!;
    const removed = before.photos.find((photo) => photo.fileId === FILE_2)!;
    await bindConfirmedEditUpload(scorecard.id);

    const saved = await updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
      photos: [
        { scorecardPhotoId: retained.id, sectionKey: "safety", deficiencyKey: null },
        { clientUploadId: "upload-3", sectionKey: "quality", deficiencyKey: null },
      ],
    }));

    const after = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(after.photos).toHaveLength(2);
    expect(after.photos.find((photo) => photo.fileId === FILE_1)).toMatchObject({
      id: retained.id,
      sectionKey: "safety",
    });
    expect(after.photos.some((photo) => photo.id === removed.id || photo.fileId === FILE_2)).toBe(false);
    expect(after.photos.find((photo) => photo.fileId === FILE_3)?.sectionKey).toBe("quality");
    const [linkedBinding] = (await tdb.execute(sql`
      SELECT state FROM field_scorecard_edit_uploads WHERE client_upload_id = 'upload-3'
    `)).rows as any[];
    expect(linkedBinding.state).toBe("linked");

    // A later edit may remove the scorecard link, but discard cleanup must preserve any gallery file that
    // was linked successfully at least once.
    await updateFieldScorecard(tdb, updateInput(scorecard.id, saved.scorecard.updatedAt!, {
      photos: [{ scorecardPhotoId: after.photos.find((photo) => photo.fileId === FILE_1)!.id, sectionKey: "safety" }],
    }));
    await expect(discardScorecardEditEvidence(tdb, {
      scorecardId: scorecard.id,
      userId: OWNER,
      clientUploadIds: ["upload-3"],
    })).resolves.toEqual({ discarded: 0 });
    const [onceLinkedFile] = (await tdb.execute(sql`
      SELECT is_active, deleted_at FROM files WHERE id = ${FILE_3}
    `)).rows as any[];
    expect(onceLinkedFile).toEqual({ is_active: true, deleted_at: null });
    const filesRemain = await tdb.execute(sql`SELECT count(*)::int AS count FROM files`);
    expect(filesRemain.rows[0]?.count).toBe(3);
  });

  it("updates leadership summary/scores without requiring or persisting project-only fields", async () => {
    const { scorecard } = await createFieldScorecard(tdb, projectSubmission({
      clientSubmissionId: csid(24),
      kind: "leadership",
      items: leadershipItems(8),
      summary: "Original visit summary",
      superintendentSignature: "must be discarded",
      pmSignature: "must be discarded",
    }));
    const result = await updateFieldScorecard(tdb, updateInput(scorecard.id, scorecard.updatedAt!, {
      items: leadershipItems(10),
      actionItems: ["must be discarded"],
      superintendentSignature: null,
      pmSignature: null,
      summary: "  Updated leadership summary  ",
    }));
    expect(result.scorecard).toMatchObject({ kind: "leadership", averageScore: 10, totalScore: 100 });
    const detail = await getFieldScorecardDetail(tdb, scorecard.id, OWNER_ACCESS);
    expect(detail.summary).toBe("Updated leadership summary");
    expect(detail.actionItems).toEqual([]);
    expect(detail.superintendentSignature).toBeNull();
    expect(detail.pmSignature).toBeNull();
  });
});
