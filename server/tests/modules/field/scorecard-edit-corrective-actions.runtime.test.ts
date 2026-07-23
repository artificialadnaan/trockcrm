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
  scorecardCorrectiveActionTokens,
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
      scorecardCorrectiveActionTokens,
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
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
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

  it("re-adding a REMOVED-then-resolved deficiency reopens with a fresh open row (recurs, finding 2)", async () => {
    // Flag a critical deficiency, resolve it → the card auto-closes. An edit REMOVES the deficiency (its
    // resolved row must NOT persist as blocking history), then a LATER edit RE-ADDS the same deficiency. The
    // recurring critical deficiency must reopen the card with a NEW open row — otherwise a stale resolved row
    // would satisfy the membership check, leave openCount == 0, and silently keep the card closed (nobody
    // notified, no response required).
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), criticalDeficiencies: ["missed_hold_point"] }),
    );
    const [def] = await getItems(scorecard.id);
    expect(def.item_type).toBe("critical_deficiency");
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: def.id,
      responseComment: "corrected",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");

    // Edit REMOVES the deficiency (still below band via a different flag so the card doesn't leave the band).
    const at1 = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at1, {
        items: v2Items(5),
        criticalDeficiencies: [],
        actionItems: ["Keep card open"],
      }),
    );
    // The removed deficiency's resolved row is dropped (no longer part of the assessment) — no stale history.
    const mid = await getItems(scorecard.id);
    expect(mid.some((i) => i.item_type === "critical_deficiency")).toBe(false);
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");

    // A LATER edit RE-ADDS the same deficiency → a FRESH open row + the card is corrective_action_open again.
    const at2 = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at2, {
        items: v2Items(5),
        criticalDeficiencies: ["missed_hold_point"],
        actionItems: ["Keep card open"],
      }),
    );
    const after = await getItems(scorecard.id);
    const readded = after.find((i) => i.item_type === "critical_deficiency")!;
    expect(readded).toBeTruthy();
    expect(readded.status).toBe("open");
    expect(readded.id).not.toBe(def.id); // a brand-new row, not the stale resolved one
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
  });

  it("a deficiency that STAYS flagged after resolution does NOT reopen on an unrelated edit (finding 2)", async () => {
    // The normal case must be untouched: a deficiency that remains flagged keeps its resolved row and must
    // NOT reopen on every edit. Resolve a deficiency, keep it flagged, edit an unrelated field → the resolved
    // row survives (same id, still resolved) and the card stays closed.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), criticalDeficiencies: ["missed_hold_point"] }),
    );
    const [def] = await getItems(scorecard.id);
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: def.id,
      responseComment: "corrected",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");

    // An unrelated edit that KEEPS the deficiency flagged.
    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, {
        items: v2Items(5),
        criticalDeficiencies: ["missed_hold_point"],
        pmName: "New PM",
      }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(def.id); // same resolved row, not reseeded
    expect(after[0].status).toBe("resolved");
    // Still closed — a resolved-but-still-flagged deficiency must not reopen the card.
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");
  });

  it("re-adding a REMOVED-then-resolved action item reopens with a fresh open row (finding 2)", async () => {
    // The analogous action-item bug: resolve an action item, REMOVE it (its resolved row must not persist),
    // then RE-ADD the same label. Multiset (label+cardinality) matching must insert a fresh open row for the
    // recurring item rather than treating the stale resolved row as satisfying the flag.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Re-inspect slab 2"] }),
    );
    const [item] = await getItems(scorecard.id);
    expect(item.item_type).toBe("action_item");
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: item.id,
      responseComment: "re-inspected",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");

    // Edit REMOVES the action item (keeping the card below band via a deficiency so it stays in the band).
    const at1 = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at1, {
        items: v2Items(5),
        criticalDeficiencies: ["missed_hold_point"],
        actionItems: [],
      }),
    );
    // The removed action item's resolved row is dropped (no stale history for the label).
    const mid = await getItems(scorecard.id);
    expect(mid.some((i) => i.item_type === "action_item")).toBe(false);
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");

    // A LATER edit RE-ADDS the same action-item label → a FRESH open row.
    const at2 = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at2, {
        items: v2Items(5),
        criticalDeficiencies: ["missed_hold_point"],
        actionItems: ["Re-inspect slab 2"],
      }),
    );
    const after = await getItems(scorecard.id);
    const readded = after.find((i) => i.item_type === "action_item")!;
    expect(readded).toBeTruthy();
    expect(readded.status).toBe("open");
    expect(readded.id).not.toBe(item.id); // brand-new row, not the stale resolved one
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

  it("an already-open card that GAINS a new flag AFTER its email sent starts a fresh cycle (finding J)", async () => {
    // Open with one flag → the original notification enqueues. Simulate the worker having SENT it (stamp set)
    // + a live prior-cycle web token. An edit that ADDS a second flag while still open must start a fresh
    // cycle: clear the stamp, delete the outstanding token, and enqueue a second notification — otherwise the
    // recipient never learns of the newly-assigned corrective action.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["First flag"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    expect(await correctiveJobCount()).toBe(1);
    // The worker stamped the original notification as sent.
    await tdb.execute(sql`UPDATE field_scorecards SET corrective_action_email_sent_at = now() WHERE id = ${scorecard.id}`);
    // A prior-cycle web token for the email-only PM.
    await tdb.insert(scorecardCorrectiveActionTokens).values({
      scorecardId: scorecard.id,
      tokenHash: "sent-cycle-hash",
      recipientEmail: "pm@example.com",
      role: "project_manager",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["First flag", "Second flag"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    // Stamp cleared so the worker sends again; a second job enqueued; the stale token deleted.
    expect(await getEmailSentAt(scorecard.id)).toBeNull();
    expect(await correctiveJobCount()).toBe(2);
    const tokens = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecard.id}`,
    );
    expect((tokens.rows[0] as { c: number }).c).toBe(0);
    // Both flags are open (the original was never resolved).
    const after = await getItems(scorecard.id);
    expect(after.filter((i) => i.status === "open")).toHaveLength(2);
  });

  it("an already-open card that gains a flag BEFORE its email sent does NOT enqueue a second (finding J)", async () => {
    // Open with one flag → notification enqueued but the stamp is still NULL (the worker hasn't sent yet). An
    // edit that adds a second flag must NOT enqueue a duplicate: the pending job reads items fresh at send time
    // and will already include the new flag.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["First flag"] }),
    );
    expect(await correctiveJobCount()).toBe(1);
    expect(await getEmailSentAt(scorecard.id)).toBeNull();

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["First flag", "Second flag"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    // Still exactly ONE job — the original (unsent) notification covers the added flag.
    expect(await correctiveJobCount()).toBe(1);
    expect(await getEmailSentAt(scorecard.id)).toBeNull();
    const after = await getItems(scorecard.id);
    expect(after.filter((i) => i.status === "open")).toHaveLength(2);
  });

  it("preserves duplicate action-item MULTIPLICITY: two identical-label flags yield two open items (finding 3)", async () => {
    // A single flag; then an edit adds a SECOND action item with the IDENTICAL label. Multiset (label +
    // cardinality) matching must insert a second tracked row rather than collapsing both onto one — otherwise
    // resolving the one row could close the card while the duplicate flag has no response.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Re-inspect slab 2"] }),
    );
    expect(await getItems(scorecard.id)).toHaveLength(1);

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, {
        items: v2Items(5),
        actionItems: ["Re-inspect slab 2", "Re-inspect slab 2"], // duplicate label
      }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(2);
    expect(after.every((i) => i.item_type === "action_item")).toBe(true);
    expect(after.every((i) => i.item_label === "Re-inspect slab 2")).toBe(true);
    expect(after.filter((i) => i.status === "open")).toHaveLength(2);
    // Distinct rows (distinct item_refs → distinct ids), so each duplicate flag is independently trackable.
    expect(new Set(after.map((i) => i.item_ref)).size).toBe(2);
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");

    // Resolving ONE duplicate leaves the card open (the second identical flag still needs a response).
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: after[0].id,
      responseComment: "first re-inspection done",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    const stillOpen = (await getItems(scorecard.id)).filter((i) => i.status === "open");
    expect(stillOpen).toHaveLength(1);
  });

  it("trimming a duplicate action item deletes an OPEN copy but preserves the RESOLVED one (finding 3)", async () => {
    // Two identical-label flags, one resolved. An edit dropping to a SINGLE copy of that label must keep the
    // resolved row (history) and delete the still-open duplicate — not the other way round.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Verify hold points", "Verify hold points"] }),
    );
    const both = await getItems(scorecard.id);
    expect(both).toHaveLength(2);
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: both[0].id,
      responseComment: "verified",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });

    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Verify hold points"] }),
    );
    const after = await getItems(scorecard.id);
    expect(after).toHaveLength(1);
    expect(after[0].id).toBe(both[0].id); // the RESOLVED row survived
    expect(after[0].status).toBe("resolved");
    // The lone surviving item is resolved history → the card auto-closes.
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");
  });

  it("a REOPEN deletes prior-cycle responder tokens so the worker re-mints a fresh link (finding 6)", async () => {
    // Open with a flag, mint a prior-cycle web token, resolve → close. Editing to add a NEW flag re-opens the
    // card; the reconcile must delete the stale token so the worker's per-recipient reuse-skip can't strand the
    // email-only recipient on a link from the closed cycle.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Only flag"] }),
    );
    const [only] = await getItems(scorecard.id);
    // A prior-cycle token for the email-only PM.
    await tdb.insert(scorecardCorrectiveActionTokens).values({
      scorecardId: scorecard.id,
      tokenHash: "prior-cycle-hash",
      recipientEmail: "pm@example.com",
      role: "project_manager",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    await resolveCorrectiveActionItem(tdb, {
      scorecardId: scorecard.id,
      itemId: only.id,
      responseComment: "fixed",
      respondedBy: { userId: OWNER, name: "Sam", email: null },
    });
    expect(await getStatus(scorecard.id)).toBe("corrective_action_closed");
    const tokensBefore = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecard.id}`,
    );
    expect((tokensBefore.rows[0] as { c: number }).c).toBe(1);

    // Edit adds a fresh flag → re-open → the reconcile deletes the prior-cycle token.
    const at = await currentUpdatedAt(scorecard.id);
    await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(5), actionItems: ["Only flag", "Brand new flag"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    const tokensAfter = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecard.id}`,
    );
    expect((tokensAfter.rows[0] as { c: number }).c).toBe(0);
  });

  it("lifting an OPEN card ABOVE band (cancel) revokes its outstanding responder tokens", async () => {
    // An edit that lifts a card out of the band walks it back to `submitted` and drops the open items — the
    // corrective-action cycle no longer exists, so a prior recipient-bound web token must NOT keep authorizing
    // the responder flow / token-scoped uploads until it expires.
    const { scorecard } = await createFieldScorecard(
      tdb,
      createInput({ items: v2Items(5), actionItems: ["Fix it"] }),
    );
    expect(await getStatus(scorecard.id)).toBe("corrective_action_open");
    // An outstanding web token for the email-only PM.
    await tdb.insert(scorecardCorrectiveActionTokens).values({
      scorecardId: scorecard.id,
      tokenHash: "cancel-cycle-hash",
      recipientEmail: "pm@example.com",
      role: "project_manager",
      expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
    });
    const tokensBefore = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecard.id}`,
    );
    expect((tokensBefore.rows[0] as { c: number }).c).toBe(1);

    // Edit lifts the card above band → revert to submitted → the reconcile must revoke the outstanding token.
    const at = await currentUpdatedAt(scorecard.id);
    const { scorecard: updated } = await updateFieldScorecard(
      tdb,
      updateInput(scorecard.id, at, { items: v2Items(9), actionItems: [] }),
    );
    expect(updated.status).toBe("submitted");
    const tokensAfter = await tdb.execute(
      sql`SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecard.id}`,
    );
    expect((tokensAfter.rows[0] as { c: number }).c).toBe(0);
  });
});
