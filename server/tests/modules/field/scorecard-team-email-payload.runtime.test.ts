import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import { createFieldScorecard } from "../../../src/modules/field/scorecards-service.js";
import { addTeamMember } from "../../../src/modules/deals/team-service.js";
import {
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  dealTeamMembers,
  contacts,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// Proves the server stamps the deal's superintendent + project_manager emails into the enqueued scorecard
// email job payload (resolved from the assigned deal_team_members → user/contact).
const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const CONTACT = "44444444-4444-4444-4444-444444444444";
// A DEACTIVATED staff user + an ARCHIVED directory contact — must be ignored by the resolver.
const USER_DEACTIVATED = "33333333-3333-3333-3333-3333333333de";
const CONTACT_ARCHIVED = "44444444-4444-4444-4444-4444444444de";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";

const MAX: Record<string, number> = {
  planning_precon: 10,
  jobsite_5s: 15,
  schedule: 20,
  subcontractor: 15,
  quality: 20,
  communication: 10,
  financial: 10,
};
function fullItems() {
  return Object.entries(MAX).map(([sectionKey, points]) => ({ sectionKey, points }));
}
function submission(over: Partial<Parameters<typeof createFieldScorecard>[1]> = {}) {
  return {
    userId: USER,
    userRole: "field_contractor" as const,
    submittedByName: "Marcus Reed",
    dealId: DEAL,
    office: { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" },
    clientSubmissionId: "55555555-5555-5555-5555-000000000001",
    weekOf: "2026-06-30",
    items: fullItems(),
    criticalDeficiencies: [] as string[],
    actionItems: [] as string[],
    photos: [] as { sectionKey: string; clientUploadId: string }[],
    ...over,
  };
}

let pg: PGlite;
let tdb: any;

async function enqueuedPayload(): Promise<any> {
  const res = await tdb.execute(
    sql`SELECT payload FROM public.job_queue WHERE job_type = 'field_scorecard_email' ORDER BY id DESC LIMIT 1`,
  );
  return res.rows[0]?.payload ?? null;
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
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, avatar_url text, is_active boolean DEFAULT true);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
  `);
  await pg.exec(
    tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, dealTeamMembers, contacts]),
  );
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true);
    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${USER}', 'Sam Super', 'sam.super@trock.com', true),
      ('${USER_DEACTIVATED}', 'Gone User', 'gone.user@trock.com', false);
    INSERT INTO contacts (id, first_name, last_name, email, category, is_active) VALUES
      ('${CONTACT}', 'Dana', 'Cole', 'dana.cole@example.com', 'client', true),
      ('${CONTACT_ARCHIVED}', 'Archived', 'Contact', 'archived.contact@example.com', 'client', false);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

describe("createFieldScorecard enqueues team emails", () => {
  it("stamps the superintendent (contact) + project_manager (user) emails into the job payload", async () => {
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });

    await createFieldScorecard(tdb, submission());

    const payload = await enqueuedPayload();
    expect(payload).toBeTruthy();
    expect(payload.superintendentEmail).toBe("dana.cole@example.com");
    expect(payload.projectManagerEmail).toBe("sam.super@trock.com");
    // The content-addressed artifact key cannot exist until after render; the worker reads the row's
    // authoritative pdf_r2_key after its initial delay rather than trusting this enqueue-time payload.
    expect(payload.pdfR2Key).toBeNull();
  });

  it("stamps nulls when no superintendent/project_manager is assigned", async () => {
    await createFieldScorecard(tdb, submission());
    const payload = await enqueuedPayload();
    expect(payload).toBeTruthy();
    expect(payload.superintendentEmail).toBeNull();
    expect(payload.projectManagerEmail).toBeNull();
  });

  it("ignores a deactivated user + an archived contact (role resolves to null → CC omitted)", async () => {
    // Superintendent's CONTACT is archived (contacts.is_active = false); PM's USER is deactivated
    // (public.users.is_active = false). Both must be skipped, so neither CC is stamped.
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT_ARCHIVED, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, userId: USER_DEACTIVATED, role: "project_manager" });

    await createFieldScorecard(tdb, submission());

    const payload = await enqueuedPayload();
    expect(payload).toBeTruthy();
    expect(payload.superintendentEmail).toBeNull();
    expect(payload.projectManagerEmail).toBeNull();
  });

  it("prefers a newer ACTIVE assignee over an older one, but falls back to null (not the deactivated row)", async () => {
    // Older active superintendent, then a NEWER one whose contact is archived. The newest-row-wins rule
    // must skip the archived newer row and land on the still-active older one.
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT_ARCHIVED, role: "superintendent" });
    // PM: only a deactivated user assigned → resolves to null.
    await addTeamMember(tdb, { dealId: DEAL, userId: USER_DEACTIVATED, role: "project_manager" });

    await createFieldScorecard(tdb, submission());

    const payload = await enqueuedPayload();
    expect(payload).toBeTruthy();
    expect(payload.superintendentEmail).toBe("sam.super@trock.com");
    expect(payload.projectManagerEmail).toBeNull();
  });
});
