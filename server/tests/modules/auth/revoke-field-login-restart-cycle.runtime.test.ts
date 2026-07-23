import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  dealTeamMembers,
  deals,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
  contacts,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { restartCorrectiveActionCyclesForRevokedFieldLogin } from "../../../src/modules/auth/local-auth-service.js";
import type { RevokeRestartDeps } from "../../../src/modules/auth/local-auth-service.js";
import { restartCorrectiveActionNotificationCycleForDeal } from "../../../src/modules/field/corrective-actions-service.js";

// When a CRM super/PM's FIELD-LOGIN capability is revoked (user_local_auth.is_enabled=false) while the user
// and their deal-team assignment stay ACTIVE, they can no longer open the trockcam:// deep link and — absent
// any team mutation — no restart re-notifies them. This strands them with a dead link and no tokenized web
// fallback. revokeUserInvite must therefore restart the OPEN corrective-action cycle for every deal where the
// revoked user is an active superintendent/project_manager, so the worker re-resolves them and routes them to
// the tokenized web link.

const OFFICE_A = { id: "00000000-0000-0000-0000-0000000000a1", slug: "alpha" };
const OFFICE_B = { id: "00000000-0000-0000-0000-0000000000b2", slug: "bravo" };

const SUPER_USER = "33333333-3333-3333-3333-333333333333"; // revoked super/PM, active on deals in both offices
const NON_RESPONDER_USER = "33333333-3333-3333-3333-3333330000cc"; // an estimator — revoke must NOT restart

// Deals in office ALPHA
const DEAL_A1 = "11111111-1111-1111-1111-1111111111a1"; // SUPER_USER = active superintendent, open card
const DEAL_A2 = "11111111-1111-1111-1111-1111111111a2"; // SUPER_USER = estimator only (non-responder) → no restart
// Deal in office BRAVO
const DEAL_B1 = "11111111-1111-1111-1111-1111111111b1"; // SUPER_USER = active project_manager, open card

const SCORECARD_A1 = "55555555-5555-5555-5555-0000000000a1";
const SCORECARD_B1 = "55555555-5555-5555-5555-0000000000b1";

let pg: PGlite;
let tdb: any;

const TENANT_TABLES = [
  dealTeamMembers,
  deals,
  fieldScorecards,
  fieldScorecardItems,
  fieldScorecardPhotos,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
  contacts,
];

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
    CREATE TABLE public.users (id uuid PRIMARY KEY, display_name text, email text, is_active boolean DEFAULT true);
  `);
  await pg.exec(tenantSchemaSql(`office_${OFFICE_A.slug}`, TENANT_TABLES));
  await pg.exec(tenantSchemaSql(`office_${OFFICE_B.slug}`, TENANT_TABLES));
  await pg.exec(`
    INSERT INTO public.users (id, display_name, email, is_active) VALUES
      ('${SUPER_USER}', 'Sam Super', 'sam.super@trock.com', true),
      ('${NON_RESPONDER_USER}', 'Ed Estimator', 'ed.est@trock.com', true);
  `);
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

// A test double for the cross-office runner: instead of the real pooled connection, run the callback against
// the office's schema by flipping the PGlite search_path (faithful to runInOfficeTransaction's envelope).
//
// Production isolates each office on its OWN pooled connection (runInOfficeTransaction -> pool.connect()), so
// the fan-out's concurrent per-office search_path switches never collide. PGlite is a SINGLE shared connection,
// so we serialize the search_path-scoped sections here (a test-only mutex) to reproduce that per-connection
// isolation — otherwise one office's `SET search_path TO public` reset would clobber another mid-restart. This
// changes nothing about the code under test; the production concurrency (Promise.allSettled) is unchanged.
let searchPathLock: Promise<unknown> = Promise.resolve();
async function runInOffice(office: { id: string; slug: string }, run: (officeDb: any) => Promise<void>) {
  const prior = searchPathLock;
  let release!: () => void;
  searchPathLock = new Promise<void>((resolve) => {
    release = resolve;
  });
  await prior;
  try {
    await tdb.execute(sql.raw(`SET search_path TO office_${office.slug}, public`));
    await run(tdb);
  } finally {
    await tdb.execute(sql.raw(`SET search_path TO public`));
    release();
  }
}

const deps: RevokeRestartDeps = {
  listOffices: async () => [OFFICE_A, OFFICE_B],
  runInOffice,
  restartCycleForDeal: restartCorrectiveActionNotificationCycleForDeal,
};

async function seedOffice(
  schema: string,
  rows: { dealId: string; userId: string; role: string; isActive?: boolean }[],
  scorecards: { id: string; dealId: string }[],
) {
  await tdb.execute(sql.raw(`SET search_path TO ${schema}, public`));
  for (const sc of scorecards) {
    await tdb.execute(sql`
      INSERT INTO field_scorecards (id, client_submission_id, deal_id, week_of, form_version, kind, total_score, rating, status, submitted_by, corrective_action_email_sent_at)
      VALUES (${sc.id}, ${sc.id}, ${sc.dealId}, '2026-06-30', 1, 'project', 60, 'corrective_action', 'corrective_action_open', ${SUPER_USER}, now())
    `);
  }
  for (const r of rows) {
    await tdb.execute(sql`
      INSERT INTO deal_team_members (deal_id, user_id, role, is_active)
      VALUES (${r.dealId}, ${r.userId}, ${r.role}::deal_team_role, ${r.isActive ?? true})
    `);
  }
  await tdb.execute(sql.raw(`SET search_path TO public`));
}

async function jobCountForOffice(schema: string, scorecardId: string): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM public.job_queue
    WHERE job_type = 'scorecard_corrective_action_email'
      AND payload->>'scorecardId' = ${scorecardId}
  `);
  return (res.rows[0] as { c: number }).c;
}

async function sentAtForScorecard(schema: string, scorecardId: string): Promise<string | null> {
  await tdb.execute(sql.raw(`SET search_path TO ${schema}, public`));
  const res = await tdb.execute(sql`
    SELECT corrective_action_email_sent_at AS sent FROM field_scorecards WHERE id = ${scorecardId}
  `);
  await tdb.execute(sql.raw(`SET search_path TO public`));
  return (res.rows[0] as { sent: string | null }).sent;
}

async function tokenCount(schema: string, scorecardId: string): Promise<number> {
  await tdb.execute(sql.raw(`SET search_path TO ${schema}, public`));
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecardId}
  `);
  await tdb.execute(sql.raw(`SET search_path TO public`));
  return (res.rows[0] as { c: number }).c;
}

beforeEach(async () => {
  await tdb.execute(sql.raw(`SET search_path TO public`));
  await tdb.execute(sql`DELETE FROM public.job_queue`);
  for (const schema of [`office_${OFFICE_A.slug}`, `office_${OFFICE_B.slug}`]) {
    await tdb.execute(sql.raw(`SET search_path TO ${schema}, public`));
    await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
    await tdb.execute(sql`DELETE FROM deal_team_members`);
    await tdb.execute(sql`DELETE FROM field_scorecards`);
  }
  await tdb.execute(sql.raw(`SET search_path TO public`));

  await seedOffice(
    `office_${OFFICE_A.slug}`,
    [
      { dealId: DEAL_A1, userId: SUPER_USER, role: "superintendent" },
      { dealId: DEAL_A2, userId: SUPER_USER, role: "estimator" },
    ],
    [{ id: SCORECARD_A1, dealId: DEAL_A1 }],
  );
  await seedOffice(
    `office_${OFFICE_B.slug}`,
    [{ dealId: DEAL_B1, userId: SUPER_USER, role: "project_manager" }],
    [{ id: SCORECARD_B1, dealId: DEAL_B1 }],
  );

  // Pre-existing tokens from the prior (deep-link) cycle — the restart must delete them so the worker's
  // reuse-skip doesn't treat them as "already delivered THIS cycle".
  for (const [schema, sc, deal] of [
    [`office_${OFFICE_A.slug}`, SCORECARD_A1, DEAL_A1],
    [`office_${OFFICE_B.slug}`, SCORECARD_B1, DEAL_B1],
  ] as const) {
    await tdb.execute(sql.raw(`SET search_path TO ${schema}, public`));
    await tdb.execute(sql`
      INSERT INTO scorecard_corrective_action_tokens (scorecard_id, token_hash, recipient_email, role, expires_at)
      VALUES (${sc}, ${`hash-${sc}`}, 'sam.super@trock.com', 'superintendent', now() + interval '30 days')
    `);
  }
  await tdb.execute(sql.raw(`SET search_path TO public`));
});

describe("revoking a super/PM's field login restarts open corrective-action cycles across offices", () => {
  it("clears sent_at, deletes prior tokens, and enqueues one job per affected deal (both offices)", async () => {
    await restartCorrectiveActionCyclesForRevokedFieldLogin(SUPER_USER, deps);

    // Office A: DEAL_A1 (superintendent) restarted; DEAL_A2 (estimator) has no open card and is a non-responder.
    expect(await sentAtForScorecard(`office_${OFFICE_A.slug}`, SCORECARD_A1)).toBeNull();
    expect(await tokenCount(`office_${OFFICE_A.slug}`, SCORECARD_A1)).toBe(0);
    expect(await jobCountForOffice(`office_${OFFICE_A.slug}`, SCORECARD_A1)).toBe(1);

    // Office B: DEAL_B1 (project_manager) restarted.
    expect(await sentAtForScorecard(`office_${OFFICE_B.slug}`, SCORECARD_B1)).toBeNull();
    expect(await tokenCount(`office_${OFFICE_B.slug}`, SCORECARD_B1)).toBe(0);
    expect(await jobCountForOffice(`office_${OFFICE_B.slug}`, SCORECARD_B1)).toBe(1);

    // Exactly two jobs total — one per affected deal, none for the estimator-only deal.
    const total = await tdb.execute(sql`
      SELECT COUNT(*)::int AS c FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
    `);
    expect((total.rows[0] as { c: number }).c).toBe(2);
  });

  it("does NOT restart when the revoked user is a non-responder (estimator only) on every deal", async () => {
    await restartCorrectiveActionCyclesForRevokedFieldLogin(NON_RESPONDER_USER, deps);

    // No open card belongs to a deal where NON_RESPONDER_USER is a super/PM → nothing enqueued, sent_at intact.
    expect(await sentAtForScorecard(`office_${OFFICE_A.slug}`, SCORECARD_A1)).not.toBeNull();
    expect(await sentAtForScorecard(`office_${OFFICE_B.slug}`, SCORECARD_B1)).not.toBeNull();
    const total = await tdb.execute(sql`
      SELECT COUNT(*)::int AS c FROM public.job_queue WHERE job_type = 'scorecard_corrective_action_email'
    `);
    expect((total.rows[0] as { c: number }).c).toBe(0);
    // Prior-cycle tokens are untouched for a non-responder revoke.
    expect(await tokenCount(`office_${OFFICE_A.slug}`, SCORECARD_A1)).toBe(1);
  });

  it("one office failing does not block the restart in the other office", async () => {
    const flakyDeps: RevokeRestartDeps = {
      ...deps,
      runInOffice: async (office, run) => {
        if (office.slug === OFFICE_A.slug) throw new Error("office alpha unavailable");
        return runInOffice(office, run);
      },
    };
    await restartCorrectiveActionCyclesForRevokedFieldLogin(SUPER_USER, flakyDeps);
    // Office B still restarted despite office A throwing.
    expect(await jobCountForOffice(`office_${OFFICE_B.slug}`, SCORECARD_B1)).toBe(1);
    expect(await sentAtForScorecard(`office_${OFFICE_B.slug}`, SCORECARD_B1)).toBeNull();
  });
});
