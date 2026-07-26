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
  dealTeamMembers,
  contacts,
  fieldResponders,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

const DEAL = "11111111-1111-1111-1111-111111111111";
const USER = "33333333-3333-3333-3333-333333333333";
const STAGE_ACTIVE = "cccccccc-0000-0000-0000-000000000001";
const STAGE_LOST = "cccccccc-0000-0000-0000-000000000002";
const OFFICE = { id: "office-1", slug: "test" };
// A field-responder roster row the scorecard picker can point at (never on deal_team_members).
const ROSTER_SUPER = "44444444-4444-4444-4444-444444444401";

// The identity requireFieldContractor injects for the SESSION path. Tests mutate this to exercise the
// spec §7.1 gate: an assigned super/PM user, a management role (admin/director), or an unauthorized role.
let sessionUser: { id: string; role: string } = { id: USER, role: "field_contractor" };

// A single fake office backed by PGlite. resolveWriteOffice returns it; runInOffice/runInOfficeTransaction
// run the callback against the shared PGlite drizzle db.
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

// Presign the response-photo URL deterministically so the token-read path can be asserted (the route wires
// getFileDownloadUrl as the photo-URL resolver for BOTH the session and token flows).
vi.mock("../../../src/modules/files/service.js", () => ({
  getFileDownloadUrl: vi.fn(async (_db: any, fileId: string) => ({ url: `https://r2.example/${fileId}` })),
}));

// Import AFTER the mocks so the routes bind to the mocked cross-office/projects.
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
let itemIds: string[];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.pipeline_stage_config (id uuid PRIMARY KEY, name text, slug text, is_terminal boolean DEFAULT false);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, name text, is_active boolean DEFAULT true,
      stage_id uuid, bid_board_stage_slug text
    );
    CREATE TABLE files (
      id uuid PRIMARY KEY, deal_id uuid, client_upload_id text, uploaded_by uuid,
      description text, is_active boolean DEFAULT true, deleted_at timestamptz, created_at timestamptz DEFAULT now()
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
      fieldResponders,
    ]),
  );
  await pg.exec(`
    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_ACTIVE}', 'Estimating', 'estimating', false),
      ('${STAGE_LOST}', 'Lost', 'lost', true);
    INSERT INTO deals (id, name, is_active, stage_id) VALUES ('${DEAL}', 'Maple St', true, '${STAGE_ACTIVE}');
  `);
  tdb = drizzle(pg);
  app = makeApp();
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  // Default the session user to the ASSIGNED superintendent (a team-member row is seeded below), so the
  // happy-path session tests are authorized. Per-test overrides exercise the management-role and 403 cases.
  sessionUser = { id: USER, role: "field_contractor" };
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM scorecard_corrective_actions`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM field_responders`);
  // Reset the deal to its ACTIVE/browsable baseline (some tests archive it / move it to Lost).
  await tdb.execute(sql`UPDATE deals SET is_active = true, stage_id = ${STAGE_ACTIVE} WHERE id = ${DEAL}`);
  // USER is the deal's assigned superintendent (active) → authorized on the session path.
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, role, is_active)
    VALUES (${DEAL}, ${USER}, 'superintendent', true)
  `);
  // An email-only assigned PROJECT MANAGER whose email matches the token recipient used by the token tests.
  // The token path revalidates the token email against the deal's CURRENT active super/PM recipients, so a
  // matching active assignment must exist for a token to grant access.
  await tdb.execute(sql`
    INSERT INTO deal_team_members (deal_id, user_id, contact_id, member_name, member_email, role, is_active)
    VALUES (${DEAL}, NULL, NULL, 'Pat Manager', 'pm@example.com', 'project_manager', true)
  `);

  // Seed a below-band scorecard with two open corrective-action items.
  scorecardId = "22222222-2222-2222-2222-222222222222";
  await tdb.execute(sql`
    INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
    VALUES (${scorecardId}, '55555555-5555-5555-5555-000000000001', ${DEAL}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
  `);
  const inserted = await tdb.execute(sql`
    INSERT INTO scorecard_corrective_actions (scorecard_id, item_type, item_ref, item_label, status)
    VALUES
      (${scorecardId}, 'action_item', '0', 'Re-inspect slab 2', 'open'),
      (${scorecardId}, 'action_item', '1', 'Verify hold points', 'open')
    RETURNING id
  `);
  itemIds = (inserted.rows as { id: string }[]).map((r) => r.id);
});

describe("GET /scorecards/:id/corrective-actions", () => {
  it("returns items for the deal's assigned superintendent (session user)", async () => {
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("returns items for an admin/director (management role) not on the team", async () => {
    // Remove the team membership so ONLY the management role admits this user.
    await tdb.execute(sql`DELETE FROM deal_team_members`);
    for (const role of ["admin", "director"] as const) {
      sessionUser = { id: "44444444-4444-4444-4444-444444444444", role };
      const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
      expect(res.status).toBe(200);
      expect(res.body.items).toHaveLength(2);
    }
  });

  it("403s a field_contractor NOT on the deal team (browsable ≠ authorized)", async () => {
    sessionUser = { id: "44444444-4444-4444-4444-444444444444", role: "field_contractor" };
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(403);
  });

  it("403s a rep NOT on the deal team", async () => {
    sessionUser = { id: "44444444-4444-4444-4444-444444444444", role: "rep" };
    const res = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(res.status).toBe(403);
  });

  it("authorizes a token minted for the card's PICKED responder, who is NOT on the deal team", async () => {
    // The load-bearing authz case for the scorecard picker. The worker mints tokens for whoever the CARD
    // resolves to, and for a picked responder that is a roster person with no deal_team_members row at all.
    // A deal-scoped revalidation here would 403 that link on its first click: the email sends, the recipient
    // taps it, and the corrective action is unreachable.
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active)
      VALUES (${ROSTER_SUPER}, 'James Helms', 'james@trock.test', 'superintendent', true)
    `);
    await tdb.execute(sql`
      UPDATE field_scorecards SET superintendent_responder_id = ${ROSTER_SUPER} WHERE id = ${scorecardId}
    `);
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "james@trock.test",
      role: "superintendent",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("403s a roster person's token once they are DEACTIVATED — the re-read IS the revocation", async () => {
    // There is no separate revoke hook for the roster. Because authorization re-resolves the pick on every
    // request, deactivating someone kills their outstanding link immediately rather than 30 days later.
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active)
      VALUES (${ROSTER_SUPER}, 'James Helms', 'james@trock.test', 'superintendent', true)
    `);
    await tdb.execute(sql`
      UPDATE field_scorecards SET superintendent_responder_id = ${ROSTER_SUPER} WHERE id = ${scorecardId}
    `);
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "james@trock.test",
      role: "superintendent",
      ttlDays: 30,
    });
    await tdb.execute(sql`UPDATE field_responders SET is_active = false WHERE id = ${ROSTER_SUPER}`);
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(403);
  });

  it("403s a roster person's token on a SIBLING card that did not pick them", async () => {
    // Picks are per-card, so authorization must be too: being picked on this week's scorecard grants nothing
    // on last week's.
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active)
      VALUES (${ROSTER_SUPER}, 'James Helms', 'james@trock.test', 'superintendent', true)
    `);
    const sibling = "22222222-2222-2222-2222-2222222222bb";
    await tdb.execute(sql`
      INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by)
      VALUES (${sibling}, '55555555-5555-5555-5555-0000000000bb', ${DEAL}, '2026-06-23', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${USER})
    `);
    await tdb.execute(sql`
      UPDATE field_scorecards SET superintendent_responder_id = ${ROSTER_SUPER} WHERE id = ${scorecardId}
    `);
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: sibling,
      recipientEmail: "james@trock.test",
      role: "superintendent",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${sibling}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(403);
  });

  it("still 403s an arbitrary roster person who was never picked on any card", async () => {
    // The pick — not roster membership — is what grants access. Being on the roster must not be a skeleton key.
    await tdb.execute(sql`
      INSERT INTO field_responders (id, name, email, role, is_active)
      VALUES (${ROSTER_SUPER}, 'James Helms', 'james@trock.test', 'superintendent', true)
    `);
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "james@trock.test",
      role: "superintendent",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(403);
  });

  it("returns items for an email-only recipient via ?token (no session)", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    expect(res.body.items).toHaveLength(2);
  });

  it("401s an invalid token", async () => {
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=not-a-real-token`,
    );
    expect(res.status).toBe(401);
  });

  it("403s a still-unexpired token whose email no longer matches an active super/PM assignment (revalidate)", async () => {
    // Mint a token for the PM recipient, then simulate the assignment DRIFTING: the PM member's email is
    // changed (a case the archive/removal hooks don't cover). The token hash+expiry are still valid, but the
    // verify-time revalidation must reject it because no active recipient carries that email anymore.
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    await tdb.execute(sql`UPDATE deal_team_members SET member_email = 'new.pm@example.com' WHERE member_email = 'pm@example.com'`);
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(403);
  });

  it("the TOKEN read path resolves a non-null url for the responder's own submitted photos", async () => {
    // Seed a resolved item that carries a corrective-action RESPONSE photo (a fresh file). The token read
    // must pass a presigner so the web responder's own photo grid renders (not an empty grid).
    const RESPONSE_FILE = "aaaaaaaa-0000-0000-0000-0000000000ca";
    await tdb.execute(sql`INSERT INTO files (id, deal_id, is_active) VALUES (${RESPONSE_FILE}, ${DEAL}, true)`);
    await tdb.execute(sql`
      UPDATE scorecard_corrective_actions SET status = 'resolved', response_comment = 'done', responder_email = 'pm@example.com'
      WHERE id = ${itemIds[0]}
    `);
    await tdb.execute(sql`
      INSERT INTO field_scorecard_photos (scorecard_id, section_key, deficiency_key, file_id, corrective_action_id)
      VALUES (${scorecardId}, NULL, NULL, ${RESPONSE_FILE}, ${itemIds[0]})
    `);

    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(rawToken)}`,
    );
    expect(res.status).toBe(200);
    const resolved = res.body.items.find((i: any) => i.id === itemIds[0]);
    expect(resolved.photos).toHaveLength(1);
    expect(resolved.photos[0].url).toBe(`https://r2.example/${RESPONSE_FILE}`);
  });

});

describe("active-scorecard/browsable-project gate (finding P2)", () => {
  // A recipient-bound token that verifies fine, and an assigned session super — both must be REJECTED once
  // the scorecard is soft-deleted or its deal is archived / moved to Lost, matching every other field surface
  // (getFieldScorecardDetail gates on field_scorecards.is_active + activeProjectWhere). Return 404 (hidden ⇒
  // nonexistent). We assert on BOTH the read (GET) and a write (POST resolve) so no path bypasses the gate.
  async function mintPmToken(): Promise<string> {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    return rawToken;
  }

  it("404s a TOKEN once the scorecard is soft-deleted (is_active=false)", async () => {
    const token = await mintPmToken();
    await tdb.execute(sql`UPDATE field_scorecards SET is_active = false WHERE id = ${scorecardId}`);
    const read = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(token)}`,
    );
    expect(read.status).toBe(404);
    const write = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(token)}`)
      .send({ comment: "should be blocked" });
    expect(write.status).toBe(404);
    // The item was NOT resolved.
    const item = await tdb.execute(sql`SELECT status FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`);
    expect(item.rows[0].status).toBe("open");
  });

  it("404s a SESSION responder once the scorecard is soft-deleted (is_active=false)", async () => {
    await tdb.execute(sql`UPDATE field_scorecards SET is_active = false WHERE id = ${scorecardId}`);
    const read = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(read.status).toBe(404);
    const write = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "should be blocked" });
    expect(write.status).toBe(404);
    const item = await tdb.execute(sql`SELECT status FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`);
    expect(item.rows[0].status).toBe("open");
  });

  it("404s a TOKEN once the deal is archived (deals.is_active=false)", async () => {
    const token = await mintPmToken();
    await tdb.execute(sql`UPDATE deals SET is_active = false WHERE id = ${DEAL}`);
    const read = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(token)}`,
    );
    expect(read.status).toBe(404);
  });

  it("404s a SESSION responder once the deal is archived (deals.is_active=false)", async () => {
    await tdb.execute(sql`UPDATE deals SET is_active = false WHERE id = ${DEAL}`);
    const read = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(read.status).toBe(404);
  });

  it("404s a TOKEN once the deal is moved to Lost (terminal stage)", async () => {
    const token = await mintPmToken();
    await tdb.execute(sql`UPDATE deals SET stage_id = ${STAGE_LOST} WHERE id = ${DEAL}`);
    const read = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(token)}`,
    );
    expect(read.status).toBe(404);
  });

  it("404s a SESSION responder once the deal is moved to Lost (terminal stage)", async () => {
    await tdb.execute(sql`UPDATE deals SET stage_id = ${STAGE_LOST} WHERE id = ${DEAL}`);
    const read = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(read.status).toBe(404);
    const write = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "should be blocked" });
    expect(write.status).toBe(404);
  });

  it("still admits an ACTIVE scorecard on a browsable deal (token AND session)", async () => {
    // Baseline sanity: with the deal active + non-terminal, BOTH paths still succeed (the gate isn't a
    // blanket denial).
    const token = await mintPmToken();
    const tokenRead = await request(app).get(
      `/scorecards/${scorecardId}/corrective-actions?token=${encodeURIComponent(token)}`,
    );
    expect(tokenRead.status).toBe(200);
    const sessionRead = await request(app).get(`/scorecards/${scorecardId}/corrective-actions`);
    expect(sessionRead.status).toBe(200);
  });
});

describe("POST /scorecards/:id/corrective-actions/:itemId", () => {
  it("resolves an item as a session user and closes the scorecard on the last item", async () => {
    const first = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "fixed one" });
    expect(first.status).toBe(200);
    let status = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${scorecardId}`);
    expect(status.rows[0].status).toBe("corrective_action_open");

    const second = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[1]}`)
      .send({ comment: "fixed two" });
    expect(second.status).toBe(200);
    status = await tdb.execute(sql`SELECT status FROM field_scorecards WHERE id = ${scorecardId}`);
    expect(status.rows[0].status).toBe("corrective_action_closed");

    // The session responder is stamped by user id.
    const item = await tdb.execute(
      sql`SELECT responded_by_user_id, responder_email FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].responded_by_user_id).toBe(USER);
  });

  it("resolves an item via a token, stamping the recipient email (no user id)", async () => {
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(
        `/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(rawToken)}`,
      )
      .send({ comment: "fixed by external pm" });
    expect(res.status).toBe(200);
    const item = await tdb.execute(
      sql`SELECT responded_by_user_id, responder_email FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].responded_by_user_id).toBeNull();
    expect(item.rows[0].responder_email).toBe("pm@example.com");
  });

  it("stamps the configured recipient NAME (not null) on a token response", async () => {
    // The seeded PM member has member_name 'Pat Manager'. A token response must carry that resolved name into
    // responder_name (previously hard-coded null), so the CRM/mobile thread shows the assignee's name.
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(
        `/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(rawToken)}`,
      )
      .send({ comment: "fixed by external pm" });
    expect(res.status).toBe(200);
    const item = await tdb.execute(
      sql`SELECT responder_name, responder_email FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].responder_name).toBe("Pat Manager");
    expect(item.rows[0].responder_email).toBe("pm@example.com");
  });

  it("403s a POST from a field_contractor NOT on the deal team (can't respond/auto-close)", async () => {
    sessionUser = { id: "44444444-4444-4444-4444-444444444444", role: "field_contractor" };
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "should be blocked" });
    expect(res.status).toBe(403);
    // The item stays open — the unauthorized POST did not resolve it.
    const item = await tdb.execute(
      sql`SELECT status FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].status).toBe("open");
  });

  it("400s a response comment that exceeds the max length (5000 chars)", async () => {
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "x".repeat(5001) });
    expect(res.status).toBe(400);
    // The item stays open — the oversized comment was rejected before any resolve.
    const item = await tdb.execute(
      sql`SELECT status FROM scorecard_corrective_actions WHERE id = ${itemIds[0]}`,
    );
    expect(item.rows[0].status).toBe("open");
  });

  it("accepts a comment exactly at the max length (5000 chars)", async () => {
    const res = await request(app)
      .post(`/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}`)
      .send({ comment: "x".repeat(5000) });
    expect(res.status).toBe(200);
  });

  it("403s a token minted for a DIFFERENT scorecard (no cross-scorecard access)", async () => {
    // Mint a token bound to another scorecard id, then try to use it on THIS scorecard's route.
    const otherScorecard = "99999999-9999-9999-9999-999999999999";
    const { rawToken } = await mintCorrectiveActionToken(tdb, {
      scorecardId: otherScorecard,
      recipientEmail: "pm@example.com",
      role: "project_manager",
      ttlDays: 30,
    });
    const res = await request(app)
      .post(
        `/scorecards/${scorecardId}/corrective-actions/${itemIds[0]}?token=${encodeURIComponent(rawToken)}`,
      )
      .send({ comment: "should be blocked" });
    expect(res.status).toBe(403);
  });
});
