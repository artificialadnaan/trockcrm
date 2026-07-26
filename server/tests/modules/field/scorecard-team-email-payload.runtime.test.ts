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
  scorecardCorrectiveActions,
  dealTeamMembers,
  contacts,
  fieldResponders,
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
// Field-responder roster rows the scorecard picker can point at.
const ROSTER_SUPER = "44444444-4444-4444-4444-444444444401";
const ROSTER_PM = "44444444-4444-4444-4444-444444444402";
const ROSTER_INACTIVE = "44444444-4444-4444-4444-444444444403";

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
    tenantSchemaSql("public", [fieldScorecards, fieldScorecardItems, fieldScorecardPhotos, scorecardCorrectiveActions, dealTeamMembers, contacts, fieldResponders]),
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
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
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

describe("createFieldScorecard stores + honors the picked field responder", () => {
  // The completed-scorecard email freezes its recipients into the payload at submit (nothing re-resolves them
  // at send time), so the pick has to win HERE — unlike the corrective-action email, which resolves in the
  // worker. Both halves follow the same rule: per role, a usable pick wins, else the deal's Team-tab super/PM.
  beforeEach(async () => {
    await tdb.execute(sql`DELETE FROM field_responders`);
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active) VALUES
        (${ROSTER_SUPER}, 'James Helms', 'james@trock.test', 'superintendent', true),
        (${ROSTER_PM}, 'Tim Mitchell', 'tim@trock.test', 'project_manager', true),
        (${ROSTER_INACTIVE}, 'Gone Guy', 'gone@trock.test', 'superintendent', false)
    `);
  });

  async function storedLinks(): Promise<{ superintendent: string | null; pm: string | null }> {
    const res = await tdb.execute(
      sql`SELECT superintendent_responder_id, pm_responder_id FROM field_scorecards ORDER BY submitted_at DESC LIMIT 1`,
    );
    const row = res.rows[0] as
      | { superintendent_responder_id: string | null; pm_responder_id: string | null }
      | undefined;
    return { superintendent: row?.superintendent_responder_id ?? null, pm: row?.pm_responder_id ?? null };
  }

  it("stores both links and addresses the completed-scorecard email to the picked people", async () => {
    // The deal team says Dana + Sam; the field user picked James + Tim on the card. The pick wins for both.
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });

    await createFieldScorecard(
      tdb,
      submission({ superintendentResponderId: ROSTER_SUPER, pmResponderId: ROSTER_PM }),
    );

    expect(await storedLinks()).toEqual({ superintendent: ROSTER_SUPER, pm: ROSTER_PM });
    const payload = await enqueuedPayload();
    expect(payload.superintendentEmail).toBe("james@trock.test");
    expect(payload.projectManagerEmail).toBe("tim@trock.test");
  });

  it("falls back to the deal team ONLY for the role without a pick", async () => {
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    await addTeamMember(tdb, { dealId: DEAL, userId: USER, role: "project_manager" });

    await createFieldScorecard(tdb, submission({ superintendentResponderId: ROSTER_SUPER }));

    expect(await storedLinks()).toEqual({ superintendent: ROSTER_SUPER, pm: null });
    const payload = await enqueuedPayload();
    expect(payload.superintendentEmail).toBe("james@trock.test");
    expect(payload.projectManagerEmail).toBe("sam.super@trock.com");
  });

  it("drops an unusable link instead of rejecting the submit — the card still saves", async () => {
    // A drafted-in-the-truck card can upload days later, by which time the picked person may be deactivated or
    // re-roled. Stranding that submission would be far worse than quietly falling back to the deal team.
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });

    const result = await createFieldScorecard(
      tdb,
      submission({
        superintendentResponderId: ROSTER_INACTIVE, // deactivated
        pmResponderId: ROSTER_SUPER, // a superintendent sitting in the PM slot
      }),
    );

    expect(result.created).toBe(true);
    expect(await storedLinks()).toEqual({ superintendent: null, pm: null });
    const payload = await enqueuedPayload();
    expect(payload.superintendentEmail).toBe("dana.cole@example.com");
    expect(payload.projectManagerEmail).toBeNull();
  });

  it("the pick OWNS the display name — a mismatched name cannot survive beside a resolved id", async () => {
    // Otherwise a client could pair Bob's id with the name "Alice" and the card + PDF would name Alice as the
    // on-site superintendent while every email and response token went to Bob.
    await createFieldScorecard(
      tdb,
      submission({ superintendentResponderId: ROSTER_SUPER, superintendentName: "Alice Impostor" }),
    );
    const res = await tdb.execute(
      sql`SELECT superintendent_name, pm_name FROM field_scorecards ORDER BY submitted_at DESC LIMIT 1`,
    );
    expect((res.rows[0] as { superintendent_name: string }).superintendent_name).toBe("James Helms");
    // The role WITHOUT a pick keeps whatever free text was submitted.
    expect((res.rows[0] as { pm_name: string | null }).pm_name).toBeNull();
  });

  it("keeps the submitted free-text name when the pick does not resolve", async () => {
    await createFieldScorecard(
      tdb,
      submission({ superintendentResponderId: ROSTER_INACTIVE, superintendentName: "Typed Name" }),
    );
    const res = await tdb.execute(
      sql`SELECT superintendent_name FROM field_scorecards ORDER BY submitted_at DESC LIMIT 1`,
    );
    expect((res.rows[0] as { superintendent_name: string }).superintendent_name).toBe("Typed Name");
  });

  it("re-reads the roster at enqueue, so a mid-submit deactivation does not mail the completed card to them", async () => {
    // FOR KEY SHARE deliberately does not block a director's PATCH, so a picked responder can be deactivated
    // between the validating read and the enqueue. Because the corrective-action path re-resolves at SEND time
    // and this one snapshots, a stale snapshot would mail the PDF to someone the corrective action has already
    // stopped addressing. Simulated by deactivating the roster row after the read the service would cache.
    await addTeamMember(tdb, { dealId: DEAL, contactId: CONTACT, role: "superintendent" });
    await tdb.execute(sql`
      CREATE OR REPLACE FUNCTION deactivate_picked() RETURNS trigger AS $$
      BEGIN
        UPDATE field_responders SET is_active = false WHERE id = NEW.superintendent_responder_id;
        RETURN NEW;
      END; $$ LANGUAGE plpgsql
    `);
    // Fires on the card INSERT — i.e. after the service's validating read, before it builds the email payload.
    await tdb.execute(sql`
      CREATE TRIGGER deactivate_picked_trg AFTER INSERT ON field_scorecards
      FOR EACH ROW WHEN (NEW.superintendent_responder_id IS NOT NULL) EXECUTE FUNCTION deactivate_picked()
    `);
    try {
      await createFieldScorecard(tdb, submission({ superintendentResponderId: ROSTER_SUPER }));
      const payload = await enqueuedPayload();
      // The re-read sees the committed deactivation and falls back to the deal team, matching what the
      // corrective-action path will independently resolve at send time.
      expect(payload.superintendentEmail).toBe("dana.cole@example.com");
      expect(payload.superintendentEmail).not.toBe("james@trock.test");
    } finally {
      await tdb.execute(sql`DROP TRIGGER IF EXISTS deactivate_picked_trg ON field_scorecards`);
    }
  });

  it("stores nothing for a malformed or unknown id rather than 500ing the submit", async () => {
    const result = await createFieldScorecard(
      tdb,
      submission({
        superintendentResponderId: "not-a-uuid",
        pmResponderId: "44444444-4444-4444-4444-4444444444ff",
      }),
    );
    expect(result.created).toBe(true);
    expect(await storedLinks()).toEqual({ superintendent: null, pm: null });
  });
});
