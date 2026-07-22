import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  createFieldScorecard,
  updateFieldScorecard,
  type CreateFieldScorecardInput,
  type UpdateFieldScorecardInput,
} from "../../../src/modules/field/scorecards-service.js";
import { resolveCorrectiveActionItem } from "../../../src/modules/field/corrective-actions-service.js";
import {
  contacts,
  dealTeamMembers,
  fieldScorecardEditUploads,
  fieldScorecardItems,
  fieldScorecardPhotos,
  fieldScorecards,
  scorecardCorrectiveActions,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

// The scorecard EDIT path (updateFieldScorecard) is V2-only, so these cover the corrective-action lifecycle
// RECONCILE on edit: opening on a drop into band, reverting when lifted back out, add/remove flags while
// open, auto-close on the last-resolved flag, preserving resolved history, and the re-open email reset.

const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };
const DEAL = "11111111-1111-1111-1111-111111111111";
const OWNER = "33333333-3333-3333-3333-333333333333";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const csid = (n: number) => `55555555-5555-5555-5555-${String(n).padStart(12, "0")}`;

const V2_KEYS = [
  "planning_precon",
  "jobsite_5s",
  "safety",
  "schedule",
  "subcontractor",
  "quality",
  "communication",
  "financial",
] as const;

// avg == points (all 8 equal). points 5 → avg 5 → corrective_action; points 9 → avg 9 → elite (above band).
function v2Items(points: number) {
  return V2_KEYS.map((sectionKey) => ({ sectionKey, points, note: null as string | null }));
}

let pg: PGlite;
let tdb: any;

async function getStatus(id: string): Promise<string> {
  const res = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${id}`);
  return (res.rows[0] as { status: string }).status;
}
async function getEmailSentAt(id: string): Promise<unknown> {
  const res = await tdb.execute(sql`SELECT corrective_action_email_sent_at AS s FROM field_scorecards WHERE id = ${id}`);
  return (res.rows[0] as { s: unknown }).s;
}
interface CaRow {
  id: string;
  item_type: string;
  item_ref: string;
  item_label: string;
  status: string;
}
async function getItems(scorecardId: string): Promise<CaRow[]> {
  const res = await tdb.execute(sql`
    SELECT id, item_type, item_ref, item_label, status
    FROM scorecard_corrective_actions
    WHERE scorecard_id = ${scorecardId}
    ORDER BY item_type, item_ref
  `);
  return res.rows as CaRow[];
}
async function correctiveJobCount(): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
  `);
  return (res.rows[0] as { c: number }).c;
}

function createInput(over: Partial<CreateFieldScorecardInput> = {}): CreateFieldScorecardInput {
  return {
    userId: OWNER,
    userRole: "field_contractor",
    submittedByName: "Marcus Reed",
    dealId: DEAL,
    office: OFFICE,
    clientSubmissionId: csid(1),
    weekOf: "2026-07-14",
    formVersion: 2,
    kind: "project",
    superintendentName: "Marcus Reed",
    pmName: "Dana Cole",
    projectNumber: "DFW-10432",
    items: v2Items(9), // above band by default
    criticalDeficiencies: [],
    criticalDeficiencyNotes: {},
    actionItems: [],
    photos: [],
    superintendentSignature: "Sig super",
    pmSignature: "Sig pm",
    ...over,
  };
}

async function currentUpdatedAt(id: string): Promise<string> {
  const res = await tdb.execute(sql`SELECT updated_at FROM field_scorecards WHERE id = ${id}`);
  return new Date((res.rows[0] as { updated_at: string }).updated_at).toISOString();
}

function updateInput(
  scorecardId: string,
  expectedUpdatedAt: string,
  over: Partial<UpdateFieldScorecardInput> = {},
): UpdateFieldScorecardInput {
  return {
    userId: OWNER,
    userRole: "field_contractor",
    scorecardId,
    office: OFFICE,
    expectedUpdatedAt,
    superintendentName: "Marcus Reed",
    pmName: "Dana Cole",
    items: v2Items(9),
    criticalDeficiencies: [],
    criticalDeficiencyNotes: {},
    actionItems: [],
    photos: [],
    superintendentSignature: "data:image/png;base64,fresh-super",
    pmSignature: "Fresh PM typed",
    summary: null,
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
      description text, tags text[] DEFAULT ARRAY['scorecard']::text[],
      is_active boolean DEFAULT true, deleted_at timestamptz, deleted_by_user_id uuid, created_at timestamptz DEFAULT now()
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
      fieldScorecardEditUploads,
      scorecardCorrectiveActions,
      dealTeamMembers,
      contacts,
    ]),
  );
  await pg.exec(
    `ALTER TABLE public.field_scorecards ADD CONSTRAINT field_scorecards_csid_uniq UNIQUE (client_submission_id);`,
  );
  await pg.exec(
    `ALTER TABLE public.scorecard_corrective_actions ADD CONSTRAINT sca_scorecard_item_uniq UNIQUE (scorecard_id, item_type, item_ref);`,
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}','Estimating','estimating',false);
    INSERT INTO deals (id, name, project_number, stage_id, is_active) VALUES
      ('${DEAL}','Maple St','DFW-10432','${STAGE_ACTIVE}', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecard_edit_uploads`);
  await tdb.execute(sql`DELETE FROM field_scorecard_photos`);
  await tdb.execute(sql`DELETE FROM field_scorecard_items`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
});

describe("updateFieldScorecard corrective-action reconcile", () => {
  it("edit of a submitted (above-band) card that drops BELOW band opens, seeds, and enqueues", async () => {
    const { scorecard } = await createFieldScorecard(tdb, createInput());
    expect(scorecard.rating).not.toBe("corrective_action");
    expect(await getStatus(scorecard.id)).toBe("submitted");
    expect(await correctiveJobCount()).toBe(0);

    const at = await currentUpdatedAt(scorecard.id);
    const { scorecard: updated } = await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, {
        items: v2Items(5), // avg 5 → corrective_action
        criticalDeficiencies: ["missed_hold_point"],
        actionItems: ["Re-inspect slab 2"],
      }),
    );
    expect(updated.rating).toBe("corrective_action");
    expect(updated.status).toBe("corrective_action_open");
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");

    const items = await getItems(scorecard.id);
    expect(items).toHaveLength(2);
    expect(items.every((i) => i.status === "open")).toBe(true);
    expect(items.map((i) => i.item_type).sort()).toEqual(["action_item", "critical_deficiency"]);
    // The edit-into-open transition enqueues exactly one corrective-action notification.
    expect(await correctiveJobCount()).toBe(1);
  });

  it("edit of an OPEN card that rises ABOVE band reverts to submitted and drops the open items", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), criticalDeficiencies: ["missed_hold_point"], actionItems: ["Fix it"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    expect(await getItems(scorecard.id)).toHaveLength(2);

    const at = await currentUpdatedAt(scorecard.id);
    const { scorecard: updated } = await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(9), criticalDeficiencies: [], actionItems: [] }),
    );
    expect(updated.rating).not.toBe("corrective_action");
    expect(updated.status).toBe("submitted");
    expect(await getStatus(scorecard.id)).toBe("submitted");
    // Obsolete open items are removed (they'd otherwise block a future closure / be dead history).
    expect(await getItems(scorecard.id)).toHaveLength(0);
  });

  it("edit of an OPEN card that ADDS a new flag inserts a new open item (blocks closure)", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["First fix"] }),
    );
    const before = await getItems(scorecard.id);
    expect(before).toHaveLength(1);

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, {
        items: v2Items(5),
        actionItems: ["First fix", "Second fix"], // add a second action item
      }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(2);
    expect(after.filter((i) => i.status === "open")).toHaveLength(2);
    expect(after.map((i) => i.item_label).sort()).toEqual(["First fix", "Second fix"]);
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("edit of an OPEN card that REMOVES an unresolved flag deletes that open item", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Keep me", "Remove me"] }),
    );
    expect(await getItems(scorecard.id)).toHaveLength(2);

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Keep me"] }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(1);
    expect(after[0].item_label).toBe("Keep me");
    expect(after[0].status).toBe("open");
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("edit that removes the LAST unresolved flag while others are resolved auto-closes the card", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Resolve me", "Drop me"] }),
    );
    const items = await getItems(scorecard.id);
    const resolveTarget = items.find((i) => i.item_label === "Resolve me")!;
    // Resolve the "Resolve me" item so it becomes history; "Drop me" remains open.
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: resolveTarget.id,
      responseComment: "done",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");

    // Edit removes the last UNRESOLVED flag ("Drop me") but keeps "Resolve me" (already resolved history).
    const at = await currentUpdatedAt(scorecard.id);
    const { scorecard: updated } = await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Resolve me"] }),
    );
    expect(updated.rating).toBe("corrective_action");
    // No open items remain (the resolved one is history) → auto-close.
    expect(updated.status).toBe("corrective_action_closed");
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(1);
    expect(after[0].status).toBe("resolved");
    expect(after[0].item_label).toBe("Resolve me");
  });

  it("preserves a resolved item across an unrelated edit (history is never dropped)", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Resolved one", "Still open"] }),
    );
    const items = await getItems(scorecard.id);
    const resolved = items.find((i) => i.item_label === "Resolved one")!;
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: resolved.id,
      responseComment: "fixed",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });

    // An edit that keeps BOTH flags (so nothing is added/removed) must leave the resolved item intact.
    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Resolved one", "Still open"], pmName: "New PM" }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(2);
    const resolvedAfter = after.find((i) => i.item_label === "Resolved one")!;
    expect(resolvedAfter.status).toBe("resolved");
    expect(resolvedAfter.id).toBe(resolved.id); // same row, not reseeded
    expect(after.find((i) => i.item_label === "Still open")!.status).toBe("open");
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("re-opening a CLOSED card (a fresh flag) resets the email stamp and re-enqueues", async () => {
    // Open with a single flag, resolve it → the card auto-closes.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Only flag"] }),
    );
    const [only] = await getItems(scorecard.id);
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: only.id,
      responseComment: "fixed",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");
    // Simulate the worker having stamped the notification as sent.
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${scorecard.id}`);
    expect(await getEmailSentAt(scorecard.id)).not.toBeNull();
    const jobsBefore = await correctiveJobCount();

    // Edit adds a NEW flag while still below band → re-open + reset stamp + re-enqueue.
    const at = await currentUpdatedAt(scorecard.id);
    const { scorecard: updated } = await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Only flag", "Brand new flag"] }),
    );
    expect(updated.status).toBe("corrective_action_open");
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    // The email stamp is cleared so the worker sends again.
    expect(await getEmailSentAt(scorecard.id)).toBeNull();
    // Exactly one MORE corrective-action job was enqueued (the re-open notification).
    expect(await correctiveJobCount()).toBe(jobsBefore + 1);
    // The originally-resolved flag stays resolved history; the new flag is open.
    const after = await getItems(scorecard.id);
    expect(after.find((i) => i.item_label === "Only flag")!.status).toBe("resolved");
    expect(after.find((i) => i.item_label === "Brand new flag")!.status).toBe("open");
  });

  it("an edit that keeps the card open (no flag change) does NOT re-enqueue", async () => {
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Same flag"] }),
    );
    expect(await correctiveJobCount()).toBe(1);
    const at = await currentUpdatedAt(scorecard.id);
    // Change only the PM name; the flag set + band are unchanged.
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Same flag"], pmName: "Different PM" }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    // No second notification — the card was already open.
    expect(await correctiveJobCount()).toBe(1);
  });
});
