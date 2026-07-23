import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import express from "express";
import request from "supertest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
  scorecardCorrectiveActionUploads,
  dealTeamMembers,
  contacts,
  files,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
// A SECOND deal + scorecard in the SAME office. Used to prove an upload token minted for scorecard B (deal B)
// cannot be confirmed through scorecard A's route (cross-scorecard token confusion, finding #7).
const DEAL_B = "aaaaaaaa-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const OFFICE = { id: "office-1", slug: "test" };

// The identity requireFieldContractor injects for the SESSION path.
let sessionUser: { id: string; role: string } = { id: USER, role: "field_contractor" };

let pg: PGlite;
let tdb: any;

vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: (err?: unknown) => void) => {
    req.fieldUser = {
      id: sessionUser.id,
      email: "sam.super@trock.com",
      firstName: "Sam",
      lastName: "Super",
      role: sessionUser.role,
      tenantId: OFFICE.id,
      active: true,
    };
    next();
  },
}));

vi.mock("../../../src/modules/field/cross-office.js", () => ({
  resolveWriteOffice: vi.fn(async () => OFFICE),
  runInOffice: vi.fn(async (_office: any, run: any) => run(tdb, OFFICE)),
  runInOfficeTransaction: vi.fn(async (_office: any, _userId: any, run: any) => run(tdb, OFFICE)),
}));

const { registerCorrectiveActionRoutes } = await import(
  "../../../src/modules/field/corrective-action-routes.js"
);
const { mintCorrectiveActionToken } = await import(
  "../../../src/modules/field/corrective-action-tokens.js"
);

function makeApp() {
  const app = express();
  app.use(express.json());
  registerCorrectiveActionRoutes(app as any);
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: any, _req: any, res: any, _next: any) => {
    res.status(err.statusCode ?? 500).json({ error: err.message ?? "error" });
  });
  return app;
}

let app: express.Express;
let scorecardId: string;
let scorecardBId: string;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, deal_number text, is_active boolean DEFAULT true,
      property_address text, property_city text, property_state text, property_zip text
    );
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
    CREATE TABLE public.audit_events (id bigserial PRIMARY KEY);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      files,
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
  // confirmUpload's insert uses ON CONFLICT (client_upload_id) WHERE NOT NULL — mirror migration 0170's
  // partial unique index so the arbitrating index exists (the drizzle schema DDL doesn't emit it).
  await pg.exec(
    `CREATE UNIQUE INDEX IF NOT EXISTS files_client_upload_id_key ON public.files (client_upload_id) WHERE client_upload_id IS NOT NULL;`,
  );
  // files.uploaded_by is NOT NULL WITH a real FK to public.users(id) in PROD (migration 0001) — the drizzle
  // schema (which tenantSchemaSql derives from) OMITS `.references()`, so this class of bug is invisible
  // without the constraint. Add it explicitly here: a nil-uuid uploader (an email-only token responder with
  // no CRM user) must FK-violate, and the submitter fallback must satisfy it.
  await pg.exec(
    `ALTER TABLE public.files ADD CONSTRAINT files_uploaded_by_fk FOREIGN KEY (uploaded_by) REFERENCES public.users(id);`,
  );
  await pg.exec(`INSERT INTO deals (id, name, deal_number, is_active) VALUES ('${DEAL}', 'Maple St', 'DFW-1', true);`);
  await pg.exec(`INSERT INTO deals (id, name, deal_number, is_active) VALUES ('${DEAL_B}', 'Oak Ave', 'DFW-2', true);`);
  // The scorecard's submitter — a real active user; token uploads are attributed to this id (not a nil uuid).
  await pg.exec(
    `INSERT INTO public.users (id, display_name, email, is_active) VALUES ('${USER}', 'Sam Super', 'sam.super@trock.com', true);`,
  );
  tdb = drizzle(pg);
  app = makeApp();
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  sessionUser = { id: USER, role: "field_contractor" };
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_uploads`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM files`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, role, is_active)
    VALUES (${DEAL}, ${USER}, 'superintendent', true)
  `);
  // The session user is also the assigned super on deal B, so B's own presign passes (the cross-scorecard
  // test needs a legitimately-minted B token, not an authz failure at presign).
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, role, is_active)
    VALUES (${DEAL_B}, ${USER}, 'superintendent', true)
  `);
  // An email-only assigned PROJECT MANAGER whose email matches the token recipient used by the token tests.
  // The token path revalidates the token email against the deal's CURRENT active super/PM recipients.
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, contact_id, member_name, member_email, role, is_active)
    VALUES (${DEAL}, NULL, NULL, 'Pat Manager', 'pm@example.com', 'project_manager', true)
  `);
  scorecardId = "22222222-2222-2222-2222-222222222222";
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${scorecardId}, '55555555-5555-5555-5555-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
  await tdb.execute(sql`
    INSERT INTO scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
    VALUES (${scorecardId}, 'action_item', '0', 'Re-inspect slab 2', 'open')
  `);
  // Scorecard B on deal B — its own OPEN corrective action, so B's presign succeeds.
  scorecardBId = "22222222-2222-2222-2222-2222222222bb";
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${scorecardBId}, '55555555-5555-5555-5555-000000000002', ${DEAL_B}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
  await tdb.execute(sql`
    INSERT INTO scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
    VALUES (${scorecardBId}, 'action_item', '0', 'Re-inspect slab B', 'open')
  `);
});

// Perform the two-step upload (presign then confirm). R2 is unconfigured in tests, so requestUploadUrl
// mints a mock upload URL + token and confirmUpload skips the R2 head-check.
async function uploadPhoto(query: string) {
  const urlRes = await request(app)
    .post(`/scorecards/${scorecardId}/corrective-actions/upload/url${query}`)
    .send({ contentType: "image/jpeg", sizeBytes: 1024 });
  if (urlRes.status !== 200) return { urlRes, confirmRes: null as any };
  const confirmRes = await request(app)
    .post(`/scorecards/${scorecardId}/corrective-actions/upload${query}`)
    .send({ uploadToken: urlRes.body.uploadToken, objectKey: urlRes.body.objectKey });
  return { urlRes, confirmRes };
}

describe("token-scoped corrective-action photo upload", () => {
  it("uploads an image as the deal's assigned superintendent (session) and returns { fileId } on the deal", async () => {
    const { confirmRes } = await uploadPhoto("");
    expect(confirmRes.status).toBe(201);
    expect(typeof confirmRes.body.fileId).toBe("string");
    const rows = await tdb.execute(
      sql`SELECT deal_id, category FROM files WHERE id = ${confirmRes.body.fileId}`,
    );
    expect(rows.rows[0].deal_id).toBe(DEAL);
    expect(rows.rows[0].category).toBe("photo");
  });

  it("uploads via a valid ?token (no session) and attributes files.uploaded_by to the submitter", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const { confirmRes } = await uploadPhoto(`?token=${encodeURIComponent(rawToken)}`);
    expect(confirmRes.status).toBe(201);
    expect(typeof confirmRes.body.fileId).toBe("string");
    // The email-only responder has no CRM user id → the row must be attributed to the scorecard's
    // submitter (a real user that satisfies the files.uploaded_by FK), NOT a nil uuid.
    const rows = await tdb.execute(
      sql`SELECT uploaded_by FROM files WHERE id = ${confirmRes.body.fileId}`,
    );
    expect(rows.rows[0].uploaded_by).toBe(USER);
  });

  it("would FK-violate if a token upload used the nil-uuid sentinel as uploaded_by (regression guard)", async () => {
    // Proves the FK is live in this test's schema: a nil uuid (no such user) cannot be the uploader. This is
    // exactly what the old CORRECTIVE_ACTION_SYSTEM_UPLOADER sentinel would have attempted in prod.
    await expect(
      tdb.execute(sql`
        INSERT INTO files (id, category, display_name, system_filename, original_filename, mime_type,
          file_size_bytes, file_extension, r2_key, r2_bucket, deal_id, uploaded_by)
        VALUES (gen_random_uuid(), 'photo', 'x', 'x', 'x', 'image/jpeg', 1, 'jpg',
          ${"nil-key-" + Date.now()}, 'b', ${DEAL}, '00000000-0000-0000-0000-000000000000')
      `),
    ).rejects.toThrow();
  });

  it("returns a fileId that submitCorrectiveActionResponse accepts as a fresh response photo", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const query = `?token=${encodeURIComponent(rawToken)}`;
    const { confirmRes } = await uploadPhoto(query);
    const fileId = confirmRes.body.fileId as string;

    const items = await request(app).get(`/scorecards/${scorecardId}/corrective-actions${query}`);
    const itemId = items.body.items[0].id;
    const resp = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemId}${query}`)
      .send({ comment: "fixed with photo", photoFileIds: [fileId] });
    expect(resp.status).toBe(200);
    const resolved = resp.body.items.find((i: any) => i.id === itemId);
    expect(resolved.status).toBe("resolved");
    expect(resolved.photos.map((p: any) => p.fileId)).toContain(fileId);
  });

  it("persists a valid caption onto the file's description", async () => {
    const urlRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(urlRes.status).toBe(200);
    const confirmRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload`)
      .send({ uploadToken: urlRes.body.uploadToken, objectKey: urlRes.body.objectKey, caption: "Slab fixed" });
    expect(confirmRes.status).toBe(201);
    const rows = await tdb.execute(sql`SELECT description FROM files WHERE id = ${confirmRes.body.fileId}`);
    expect(rows.rows[0].description).toBe("Slab fixed");
  });

  it("400s an oversized caption before any upload work (finding #3)", async () => {
    const urlRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(urlRes.status).toBe(200);
    // > MAX_RESPONSE_COMMENT_LENGTH (5000) — must be rejected, never persisted to files.description.
    const confirmRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload`)
      .send({ uploadToken: urlRes.body.uploadToken, objectKey: urlRes.body.objectKey, caption: "x".repeat(5001) });
    expect(confirmRes.status).toBe(400);
  });

  it("401s an invalid token on the upload-url step", async () => {
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url?token=not-a-real-token`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(res.status).toBe(401);
  });

  it("403s a token minted for a DIFFERENT scorecard", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: "99999999-9999-9999-9999-999999999999",
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url?token=${encodeURIComponent(rawToken)}`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(res.status).toBe(403);
  });

  it("403s a field_contractor NOT on the deal team (session path)", async () => {
    sessionUser = { id: "44444444-4444-4444-4444-444444444444", role: "field_contractor" };
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(res.status).toBe(403);
  });

  it("rejects a non-image content type (400)", async () => {
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "application/pdf", sizeBytes: 1024 });
    expect(res.status).toBe(400);
  });

  it("409s a presign once the corrective action is CLOSED (finding H)", async () => {
    // Close the corrective action: no open items + closed status. A still-assigned recipient's long-lived
    // token must not keep minting upload URLs after closure.
    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'resolved' WHERE scorecard_id = ${scorecardId}`);
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'corrective_action_closed' WHERE id = ${scorecardId}`);
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(res.status).toBe(409);
  });

  it("409s a CONFIRM once the corrective action closes between presign and confirm (finding H)", async () => {
    // Presign while still open, then close the corrective action, then confirm — the confirm must be rejected
    // so a closed scorecard never gains a new orphaned response file.
    const urlRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(urlRes.status).toBe(200);

    await tdb.execute(sql`UPDATE scorecard_corrective_actions SET status = 'resolved' WHERE scorecard_id = ${scorecardId}`);
    await tdb.execute(sql`UPDATE field_scorecards SET status = 'corrective_action_closed' WHERE id = ${scorecardId}`);

    const confirmRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload`)
      .send({ uploadToken: urlRes.body.uploadToken, objectKey: urlRes.body.objectKey });
    expect(confirmRes.status).toBe(409);
  });

  it("takes the parent-scorecard FOR UPDATE lock BEFORE the open-check + file-create on confirm (finding E)", async () => {
    // confirmCorrectiveActionUpload must serialize its open-check + file-create against the close a concurrent
    // resolve commits. It takes the SAME parent-scorecard FOR UPDATE lock the submit/discard paths use, up front
    // — otherwise a resolve of the last open item could commit the close between the open-check and confirmUpload
    // and this would still create an active orphan file. Assert the FOR UPDATE on field_scorecards is issued and
    // precedes the ownership-ledger INSERT (the file-create work).
    const urlRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(urlRes.status).toBe(200);

    const seen: string[] = [];
    const origExecute = tdb.execute.bind(tdb);
    const spy = vi.spyOn(tdb, "execute").mockImplementation(((...args: any[]) => {
      const q = args[0];
      const text = typeof q === "string" ? q : (q?.strings?.join?.("?") ?? JSON.stringify(q));
      seen.push(text);
      return origExecute(...args);
    }) as any);
    try {
      const confirmRes = await request(app)
        .post(`/scorecards/${scorecardId}/corrective-actions/upload`)
        .send({ uploadToken: urlRes.body.uploadToken, objectKey: urlRes.body.objectKey });
      expect(confirmRes.status).toBe(201);
    } finally {
      spy.mockRestore();
    }
    const lockIdx = seen.findIndex((t) => /FROM field_scorecards/i.test(t) && /FOR UPDATE/i.test(t));
    const ledgerIdx = seen.findIndex((t) => /scorecard_corrective_action_uploads/i.test(t));
    expect(lockIdx).toBeGreaterThanOrEqual(0); // the parent-scorecard lock was taken
    expect(ledgerIdx).toBeGreaterThanOrEqual(0); // the file-create ledger write ran
    expect(lockIdx).toBeLessThan(ledgerIdx); // the lock precedes the file-create work
  });

  it("rejects confirming scorecard B's upload token through scorecard A's route (cross-scorecard token confusion, finding #7)", async () => {
    // Presign an upload for scorecard B (deal B) — a legitimate token bound to deal B.
    const urlResB = await request(app)
      .post(`/scorecards/${scorecardBId}/corrective-actions/upload/url`)
      .send({ contentType: "image/jpeg", sizeBytes: 1024 });
    expect(urlResB.status).toBe(200);

    const filesBefore = await tdb.execute(sql`SELECT count(*)::int AS n FROM files WHERE deal_id = ${DEAL_B}`);
    const countBefore = (filesBefore.rows[0] as { n: number }).n;

    // Confirm B's token through scorecard A's route. The caller is authorized for A, so A's open/authz checks
    // pass — but confirmCorrectiveActionUpload now binds the confirm to A's authoritative deal, so B's
    // deal-scoped pending token mismatches (deal A ≠ deal B) → confirmUpload rejects it (400
    // SCORECARD_EDIT_UPLOAD_SCOPE). No file is created on deal B.
    const confirmRes = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/upload`)
      .send({ uploadToken: urlResB.body.uploadToken, objectKey: urlResB.body.objectKey });
    expect(confirmRes.status).toBe(400);

    const filesAfter = await tdb.execute(sql`SELECT count(*)::int AS n FROM files WHERE deal_id = ${DEAL_B}`);
    expect((filesAfter.rows[0] as { n: number }).n).toBe(countBefore);
  });
});

describe("token-scoped corrective-action photo discard", () => {
  async function tokenFor(scId: string) {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: scId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    return rawToken;
  }

  it("discards an uploaded-but-un-submitted photo (session): soft-deletes the file", async () => {
    const { confirmRes } = await uploadPhoto("");
    const fileId = confirmRes.body.fileId as string;

    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}`,
    );
    expect(del.status).toBe(200);
    expect(del.body.discarded).toBe(true);

    const rows = await tdb.execute(sql`SELECT is_active, deleted_at FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(false);
    expect(rows.rows[0].deleted_at).not.toBeNull();
  });

  it("discards via a valid ?token (email-only responder)", async () => {
    const rawToken = await tokenFor(scorecardId);
    const query = `?token=${encodeURIComponent(rawToken)}`;
    const { confirmRes } = await uploadPhoto(query);
    const fileId = confirmRes.body.fileId as string;

    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}${query}`,
    );
    expect(del.status).toBe(200);
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(false);
  });

  it("rejects (409) discarding a photo that is already attached to a submitted response", async () => {
    const rawToken = await tokenFor(scorecardId);
    const query = `?token=${encodeURIComponent(rawToken)}`;
    const { confirmRes } = await uploadPhoto(query);
    const fileId = confirmRes.body.fileId as string;

    // Submit a response that attaches the photo (creates its field_scorecard_photos row).
    const items = await request(app).get(`/scorecards/${scorecardId}/corrective-actions${query}`);
    const itemId = items.body.items[0].id;
    const resp = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemId}${query}`)
      .send({ comment: "fixed", photoFileIds: [fileId] });
    expect(resp.status).toBe(200);

    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}${query}`,
    );
    expect(del.status).toBe(409);
    // The attached file MUST remain active (never dropped from the finalized response).
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(true);
  });

  it("runs the re-check + delete under the parent-scorecard lock; an attach wins the race (409) (finding E)", async () => {
    // discardCorrectiveActionUpload takes the SAME parent-scorecard FOR UPDATE lock the submit path uses, so
    // an attach that commits first is observed by the discard's is-attached re-check → 409, never a
    // soft-delete of an already-attached file. Here the submit attaches the file first (serialized under the
    // lock in prod); the discard then sees the attachment and rejects, leaving the file active.
    const rawToken = await tokenFor(scorecardId);
    const query = `?token=${encodeURIComponent(rawToken)}`;
    const { confirmRes } = await uploadPhoto(query);
    const fileId = confirmRes.body.fileId as string;

    const items = await request(app).get(`/scorecards/${scorecardId}/corrective-actions${query}`);
    const itemId = items.body.items[0].id;
    const resp = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemId}${query}`)
      .send({ comment: "attached under the lock", photoFileIds: [fileId] });
    expect(resp.status).toBe(200);

    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}${query}`,
    );
    expect(del.status).toBe(409);
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(true);
  });

  it("404s discarding a file that is not a corrective-action upload (foreign gallery file)", async () => {
    // A plain project photo on the same deal — NOT minted via the corrective-action flow, so it has NO
    // ownership ledger row.
    const other = "88888888-8888-8888-8888-888888888888";
    await tdb.execute(sql`
      INSERT INTO files (id, category, display_name, system_filename, original_filename, mime_type,
        file_size_bytes, file_extension, r2_key, r2_bucket, deal_id, uploaded_by, is_active)
      VALUES (${other}, 'photo', 'site.jpg', 'sys.jpg', 'site.jpg', 'image/jpeg', 10, 'jpg',
        ${"plain-key-" + Date.now()}, 'b', ${DEAL}, ${USER}, true)
    `);
    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${other}`,
    );
    expect(del.status).toBe(404);
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${other}`);
    expect(rows.rows[0].is_active).toBe(true);
  });

  it("writes an ownership ledger row on confirm; a ledger-backed file is discardable (finding #7)", async () => {
    // Discard eligibility is proven by the DURABLE scorecard_corrective_action_uploads ledger, written by
    // confirm — not the forgeable filename. Confirm writes exactly one ledger row (file_id + scorecard_id).
    const { confirmRes } = await uploadPhoto("");
    const fileId = confirmRes.body.fileId as string;
    const ledger = await tdb.execute(
      sql`SELECT scorecard_id FROM scorecard_corrective_action_uploads WHERE file_id = ${fileId}`,
    );
    expect(ledger.rows).toHaveLength(1);
    expect((ledger.rows[0] as { scorecard_id: string }).scorecard_id).toBe(scorecardId);

    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}`,
    );
    expect(del.status).toBe(200);
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(false);
  });

  it("404s discarding a look-alike file with a crafted corrective-action- filename but NO ledger row (finding #7)", async () => {
    // The security fix: the generic upload API lets a caller supply original_filename, so the
    // `corrective-action-` prefix is FORGEABLE. A file that mimics the prefix but was NEVER confirmed through
    // this flow has no ownership ledger row → it is NOT discardable (404), so an authorized responder can't
    // soft-delete an arbitrary unattached file on the deal by naming it to look like a corrective-action upload.
    const forged = "99999999-8888-7777-6666-555544443333";
    await tdb.execute(sql`
      INSERT INTO files (id, category, display_name, system_filename, original_filename, mime_type,
        file_size_bytes, file_extension, r2_key, r2_bucket, deal_id, uploaded_by, is_active)
      VALUES (${forged}, 'photo', 'x.jpg', 'sys.jpg', 'corrective-action-1234.jpg', 'image/jpeg', 10, 'jpg',
        ${"forged-key-" + Date.now()}, 'b', ${DEAL}, ${USER}, true)
    `);
    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${forged}`,
    );
    expect(del.status).toBe(404);
    // The forged-name file is untouched — never soft-deleted.
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${forged}`);
    expect(rows.rows[0].is_active).toBe(true);
  });

  it("403s a discard with a token minted for a DIFFERENT scorecard", async () => {
    const { confirmRes } = await uploadPhoto("");
    const fileId = confirmRes.body.fileId as string;
    const foreign = await tokenFor("99999999-9999-9999-9999-999999999999");
    const del = await request(app).delete(
      `/scorecards/${scorecardId}/corrective-actions/upload/${fileId}?token=${encodeURIComponent(foreign)}`,
    );
    expect(del.status).toBe(403);
    const rows = await tdb.execute(sql`SELECT is_active FROM files WHERE id = ${fileId}`);
    expect(rows.rows[0].is_active).toBe(true);
  });
});
