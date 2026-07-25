import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { recipientResolutionSql } from "../../src/jobs/scorecard-corrective-action-email.js";

// Real-SQL (PGlite) coverage for the corrective-action recipient resolution. This query decides WHO is emailed
// and WHO gets a response token for a below-band card, and the server's token verify-time revalidation
// (resolveScorecardCorrectiveActionRecipients) must agree with it row-for-row — a link this query mints for
// someone the server wouldn't resolve 403s on its first click. String-mocking the query text can't catch a
// precedence or active-filter mistake, so exercise the actual SQL against actual rows.

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`; // hex-only suffixes — these are real uuids

const DEAL = U("d1");
const CARD = U("c1"); // the scorecard under test
const ROSTER_SUPER = U("f1");
const ROSTER_PM = U("f2");
const ROSTER_INACTIVE = U("f3");
const CRM_USER = U("a1");

let pg: PGlite;

/** Run the resolution exactly as the worker does: $1 = deal id, $2 = scorecard id. */
async function resolve(): Promise<
  Array<{ role: string; email: string; user_id: string | null; can_field_login: boolean; name: string }>
> {
  const res = await pg.query(recipientResolutionSql("office_test"), [DEAL, CARD] as never[]);
  return res.rows as never[];
}

/** Point the card at the given roster rows (null clears a slot). */
async function setPicks(superintendentResponderId: string | null, pmResponderId: string | null) {
  await pg.query(
    `UPDATE office_test.field_scorecards
        SET superintendent_responder_id = $1::uuid, pm_responder_id = $2::uuid
      WHERE id = $3::uuid`,
    [superintendentResponderId, pmResponderId, CARD] as never[],
  );
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE SCHEMA office_test;
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.user_local_auth (
      user_id uuid PRIMARY KEY,
      is_enabled boolean NOT NULL DEFAULT true,
      revoked_at timestamptz,
      must_change_password boolean NOT NULL DEFAULT true
    );
    CREATE TABLE office_test.contacts (
      id uuid PRIMARY KEY, first_name text, last_name text, email text, is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE office_test.field_responders (
      id uuid PRIMARY KEY, name text NOT NULL, email text NOT NULL, role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true
    );
    CREATE TABLE office_test.field_scorecards (
      id uuid PRIMARY KEY,
      deal_id uuid NOT NULL,
      superintendent_responder_id uuid,
      pm_responder_id uuid
    );
    CREATE TABLE office_test.deal_team_members (
      id uuid PRIMARY KEY,
      deal_id uuid NOT NULL,
      user_id uuid,
      contact_id uuid,
      member_name text,
      member_email text,
      role text NOT NULL,
      is_active boolean NOT NULL DEFAULT true,
      created_at timestamptz NOT NULL DEFAULT NOW()
    );

    INSERT INTO public.users (id, display_name, email) VALUES ('${CRM_USER}', 'Casey CRM', 'casey@trock.test');
    INSERT INTO public.user_local_auth (user_id, is_enabled, revoked_at, must_change_password)
      VALUES ('${CRM_USER}', true, NULL, false);

    INSERT INTO office_test.field_responders (id, name, email, role, is_active) VALUES
      ('${ROSTER_SUPER}', 'James Helms', 'james@trock.test', 'superintendent', true),
      ('${ROSTER_PM}', 'Tim Mitchell', 'tim@trock.test', 'project_manager', true),
      ('${ROSTER_INACTIVE}', 'Gone Guy', 'gone@trock.test', 'superintendent', false);

    INSERT INTO office_test.field_scorecards (id, deal_id) VALUES ('${CARD}', '${DEAL}');

    -- The deal team: a CRM-user superintendent (deep-link capable) and an email-only PM.
    INSERT INTO office_test.deal_team_members (id, deal_id, user_id, contact_id, member_name, member_email, role, created_at) VALUES
      ('${U("e1")}', '${DEAL}', '${CRM_USER}', NULL, NULL, NULL, 'superintendent', NOW() - INTERVAL '2 hours'),
      ('${U("e2")}', '${DEAL}', NULL, NULL, 'Team PM', 'team.pm@trock.test', 'project_manager', NOW() - INTERVAL '2 hours');
  `);
}, 30_000);

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await setPicks(null, null);
  await pg.exec(`UPDATE office_test.deal_team_members SET is_active = true WHERE deal_id = '${DEAL}';`);
});

describe("corrective-action recipient resolution (real SQL)", () => {
  it("with no pick, resolves exactly the deal team — the pre-feature behavior is untouched", async () => {
    const rows = await resolve();
    expect(rows.map((r) => `${r.role}:${r.email}`).sort()).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:casey@trock.test",
    ]);
    // The CRM superintendent holds an enabled, non-must-change field login → in-app deep link.
    expect(rows.find((r) => r.role === "superintendent")).toMatchObject({
      user_id: CRM_USER,
      can_field_login: true,
    });
  });

  it("a picked superintendent WINS over the deal-team superintendent, and only for that role", async () => {
    await setPicks(ROSTER_SUPER, null);
    const rows = await resolve();
    expect(rows.map((r) => `${r.role}:${r.email}`).sort()).toEqual([
      "project_manager:team.pm@trock.test", // untouched — no pick for this role
      "superintendent:james@trock.test", // the picked roster person, not Casey
    ]);
  });

  it("routes a picked responder to the tokenized web link (no CRM identity, so never a deep link)", async () => {
    await setPicks(ROSTER_SUPER, null);
    const picked = (await resolve()).find((r) => r.role === "superintendent")!;
    // user_id NULL + can_field_login FALSE is what sends the worker down the mint-a-token branch. If either
    // flipped, the picked person would be emailed a trockcam:// deep link they have no account to open.
    expect(picked.user_id).toBeNull();
    expect(picked.can_field_login).toBe(false);
    expect(picked.name).toBe("James Helms");
  });

  it("resolves a pick for BOTH roles at once", async () => {
    await setPicks(ROSTER_SUPER, ROSTER_PM);
    const rows = await resolve();
    expect(rows.map((r) => `${r.role}:${r.email}`).sort()).toEqual([
      "project_manager:tim@trock.test",
      "superintendent:james@trock.test",
    ]);
  });

  it("falls back to the deal team when the picked responder has been DEACTIVATED", async () => {
    // Deactivation is the roster's only off-switch, and it must take effect on the next send rather than
    // silently emailing someone who has left. The role still gets notified — just via the deal team.
    await setPicks(ROSTER_INACTIVE, null);
    const rows = await resolve();
    expect(rows.find((r) => r.role === "superintendent")?.email).toBe("casey@trock.test");
    expect(rows.map((r) => r.email)).not.toContain("gone@trock.test");
  });

  it("ignores a pick whose roster row holds the OTHER role", async () => {
    // Storage validates role-vs-slot, but a director can re-role someone afterwards. A PM sitting in the
    // superintendent slot must not answer for the superintendent.
    await setPicks(ROSTER_PM, null);
    const rows = await resolve();
    expect(rows.find((r) => r.role === "superintendent")?.email).toBe("casey@trock.test");
  });

  it("ignores a dangling pick (roster row gone) rather than dropping the role", async () => {
    await setPicks(U("dead"), null);
    const rows = await resolve();
    expect(rows.find((r) => r.role === "superintendent")?.email).toBe("casey@trock.test");
  });

  it("notifies a picked role that has NO deal-team assignment at all", async () => {
    // Without the pick this role would resolve to nobody; the pick is the whole reason anyone is reached.
    await pg.exec(
      `UPDATE office_test.deal_team_members SET is_active = false WHERE role = 'superintendent' AND deal_id = '${DEAL}';`,
    );
    await setPicks(ROSTER_SUPER, null);
    const rows = await resolve();
    expect(rows.map((r) => `${r.role}:${r.email}`).sort()).toEqual([
      "project_manager:team.pm@trock.test",
      "superintendent:james@trock.test",
    ]);
  });

  it("scopes picks to their OWN card — a sibling scorecard on the same deal is unaffected", async () => {
    // Recipients are per-CARD now. A pick made on this week's scorecard must not redirect last week's.
    const sibling = U("c2");
    await pg.exec(
      `INSERT INTO office_test.field_scorecards (id, deal_id) VALUES ('${sibling}', '${DEAL}') ON CONFLICT DO NOTHING;`,
    );
    await setPicks(ROSTER_SUPER, null);
    const siblingRes = await pg.query(recipientResolutionSql("office_test"), [DEAL, sibling] as never[]);
    const siblingRows = siblingRes.rows as Array<{ role: string; email: string }>;
    expect(siblingRows.find((r) => r.role === "superintendent")?.email).toBe("casey@trock.test");
  });

  it("keeps the deal-team newest-row-per-role tiebreak intact under the pick precedence", async () => {
    // The fallback half of the query still has to behave like it always did: DISTINCT ON (role) takes the
    // most recent assignment, and adding the priority column must not reorder that.
    await pg.exec(`
      INSERT INTO office_test.deal_team_members (id, deal_id, user_id, contact_id, member_name, member_email, role, created_at)
      VALUES ('${U("e3")}', '${DEAL}', NULL, NULL, 'Newer PM', 'newer.pm@trock.test', 'project_manager', NOW())
      ON CONFLICT DO NOTHING;
    `);
    const rows = await resolve();
    expect(rows.find((r) => r.role === "project_manager")?.email).toBe("newer.pm@trock.test");
    await pg.exec(`DELETE FROM office_test.deal_team_members WHERE id = '${U("e3")}';`);
  });
});
