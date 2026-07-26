import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { sql } from "drizzle-orm";
import {
  dealTeamMembers,
  fieldResponders,
  fieldScorecards,
  scorecardCorrectiveActions,
  scorecardCorrectiveActionTokens,
} from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";
import { updateFieldResponder } from "../../../src/modules/field/field-responders-service.js";

// Recipient resolution reads field_responders at SEND and at TOKEN-VERIFY time, so a roster edit can silently
// change who answers a card — and, for the person holding the outstanding link, revoke it (their email stops
// matching a resolved recipient, so the next click 403s). Without a notification restart the card is left
// UNANSWERABLE: the previous holder is locked out, the fallback super/PM was never emailed, and
// corrective_action_email_sent_at suppresses any further send. These pin that the roster PATCH re-notifies,
// and that it stays quiet for edits that change nothing about who is reached.

const OFFICE = { id: "00000000-0000-0000-0000-0000000000f1", slug: "test" };
const DEAL = "11111111-1111-1111-1111-111111111111";
const DEAL_TWO = "11111111-1111-1111-1111-111111111112";
const OWNER = "33333333-3333-3333-3333-333333333333";
const RESPONDER = "44444444-4444-4444-4444-444444444401";
const OPEN_CARD = "aaaaaaaa-0000-0000-0000-00000000000a";
const OPEN_CARD_OTHER_DEAL = "aaaaaaaa-0000-0000-0000-00000000000b";
const CLOSED_CARD = "aaaaaaaa-0000-0000-0000-00000000000c";
const UNPICKED_CARD = "aaaaaaaa-0000-0000-0000-00000000000d";

let pg: PGlite;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;

async function correctiveJobs(): Promise<Array<{ scorecardId: string; dealId: string; cycleNonce: string }>> {
  const res = await tdb.execute(sql`
    SELECT payload FROM public.job_queue
     WHERE job_type = 'scorecard_corrective_action_email'
     ORDER BY id
  `);
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return (res.rows as Array<{ payload: any }>).map((r) => ({
    scorecardId: r.payload.scorecardId,
    dealId: r.payload.dealId,
    cycleNonce: r.payload.cycleNonce,
  }));
}

async function cardState(id: string): Promise<{ sentAt: unknown; nonce: string | null }> {
  const res = await tdb.execute(sql`
    SELECT corrective_action_email_sent_at AS s, corrective_action_cycle_nonce AS n
      FROM field_scorecards WHERE id = ${id}
  `);
  const row = res.rows[0] as { s: unknown; n: string | null };
  return { sentAt: row.s, nonce: row.n };
}

async function tokenCount(scorecardId: string): Promise<number> {
  const res = await tdb.execute(sql`
    SELECT COUNT(*)::int AS c FROM scorecard_corrective_action_tokens WHERE scorecard_id = ${scorecardId}
  `);
  return (res.rows[0] as { c: number }).c;
}

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`
    CREATE TABLE public.deals (id uuid PRIMARY KEY, name text NOT NULL, is_active boolean NOT NULL DEFAULT true);
    CREATE TABLE public.job_queue (
      id bigserial PRIMARY KEY, job_type varchar(100) NOT NULL, payload jsonb NOT NULL, office_id uuid,
      status text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0, max_attempts int NOT NULL DEFAULT 3,
      last_error text, started_processing_at timestamptz, run_after timestamptz NOT NULL DEFAULT now(),
      created_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
    );
  `);
  await pg.exec(
    tenantSchemaSql("public", [
      fieldResponders,
      fieldScorecards,
      scorecardCorrectiveActions,
      scorecardCorrectiveActionTokens,
      dealTeamMembers,
    ]),
  );
  tdb = drizzle(pg);
});

afterAll(async () => {
  await pg?.close?.();
});

beforeEach(async () => {
  await tdb.execute(sql`DELETE FROM scorecard_corrective_action_tokens`);
  await tdb.execute(sql`DELETE FROM field_scorecards`);
  await tdb.execute(sql`DELETE FROM field_responders`);
  await tdb.execute(sql`DELETE FROM deal_team_members`);
  await tdb.execute(sql`DELETE FROM public.job_queue`);
  await tdb.execute(sql`DELETE FROM deals`);
  await tdb.execute(sql`
    INSERT INTO deals (id, name, is_active) VALUES (${DEAL}, 'Alpha Job', TRUE), (${DEAL_TWO}, 'Bravo Job', TRUE)
  `);
  await tdb.insert(fieldResponders).values({
    id: RESPONDER,
    name: "James Helms",
    email: "james@trock.test",
    role: "superintendent",
  });

  // Four cards: two OPEN and picking this responder (on different deals), one CLOSED that picks him, and one
  // OPEN that does not. Only the first two are owed a re-notify.
  const cards: Array<[string, string, string, string | null]> = [
    [OPEN_CARD, DEAL, "corrective_action_open", RESPONDER],
    [OPEN_CARD_OTHER_DEAL, DEAL_TWO, "corrective_action_open", RESPONDER],
    [CLOSED_CARD, DEAL, "corrective_action_closed", RESPONDER],
    [UNPICKED_CARD, DEAL, "corrective_action_open", null],
  ];
  for (const [id, dealId, status, pick] of cards) {
    await tdb.execute(sql`
      INSERT INTO field_scorecards
        (id, client_submission_id, deal_id, week_of, total_score, rating, status, submitted_by,
         superintendent_responder_id, corrective_action_email_sent_at, corrective_action_cycle_nonce)
      VALUES (${id}, gen_random_uuid(), ${dealId}, '2026-07-20', 60, 'corrective_action', ${status}, ${OWNER},
              ${pick}::uuid, now(), gen_random_uuid())
    `);
    await tdb.execute(sql`
      INSERT INTO scorecard_corrective_action_tokens (scorecard_id, token_hash, recipient_email, role, expires_at)
      VALUES (${id}, ${`hash-${id}`}, 'james@trock.test', 'superintendent', now() + interval '30 days')
    `);
  }
});

describe("roster PATCH re-notifies the cards a picked responder answers for", () => {
  it("deactivating restarts every OPEN card that picked them — new nonce, cleared stamp, tokens purged", async () => {
    const before = await cardState(OPEN_CARD);
    await updateFieldResponder(tdb, RESPONDER, { isActive: false }, OFFICE);

    const jobs = await correctiveJobs();
    expect(jobs.map((j) => j.scorecardId).sort()).toEqual([OPEN_CARD, OPEN_CARD_OTHER_DEAL].sort());
    // Each job carries ITS OWN card's deal — a responder-scoped restart can span deals.
    expect(jobs.find((j) => j.scorecardId === OPEN_CARD)!.dealId).toBe(DEAL);
    expect(jobs.find((j) => j.scorecardId === OPEN_CARD_OTHER_DEAL)!.dealId).toBe(DEAL_TWO);

    const after = await cardState(OPEN_CARD);
    expect(after.sentAt).toBeNull(); // the worker will send again
    expect(after.nonce).toBeTruthy();
    expect(after.nonce).not.toBe(before.nonce);
    // The enqueued nonce must EQUAL the persisted one or the job could never stamp.
    expect(jobs.find((j) => j.scorecardId === OPEN_CARD)!.cycleNonce).toBe(after.nonce);
    // Prior-cycle links must not survive a new cycle (the worker's reuse-skip would treat one as delivered).
    expect(await tokenCount(OPEN_CARD)).toBe(0);
  });

  it("leaves CLOSED cards and cards that never picked them alone", async () => {
    await updateFieldResponder(tdb, RESPONDER, { isActive: false }, OFFICE);
    const touched = (await correctiveJobs()).map((j) => j.scorecardId);
    expect(touched).not.toContain(CLOSED_CARD);
    expect(touched).not.toContain(UNPICKED_CARD);
    expect(await cardState(CLOSED_CARD)).toMatchObject({ sentAt: expect.anything() });
    expect(await tokenCount(UNPICKED_CARD)).toBe(1);
  });

  it("restarts on a ROLE change — the pick no longer matches the slot it was made for", async () => {
    await updateFieldResponder(tdb, RESPONDER, { role: "project_manager" }, OFFICE);
    expect((await correctiveJobs()).map((j) => j.scorecardId).sort()).toEqual(
      [OPEN_CARD, OPEN_CARD_OTHER_DEAL].sort(),
    );
  });

  it("restarts on an EMAIL change — the outstanding token's recipient_email stops matching", async () => {
    await updateFieldResponder(tdb, RESPONDER, { email: "james.helms@trock.test" }, OFFICE);
    expect((await correctiveJobs()).map((j) => j.scorecardId).sort()).toEqual(
      [OPEN_CARD, OPEN_CARD_OTHER_DEAL].sort(),
    );
  });

  it("restarts on REACTIVATION — the pick starts winning again", async () => {
    await tdb.execute(sql`UPDATE field_responders SET is_active = false WHERE id = ${RESPONDER}`);
    await tdb.execute(sql`DELETE FROM public.job_queue`);
    await updateFieldResponder(tdb, RESPONDER, { isActive: true }, OFFICE);
    expect((await correctiveJobs()).map((j) => j.scorecardId).sort()).toEqual(
      [OPEN_CARD, OPEN_CARD_OTHER_DEAL].sort(),
    );
  });

  it("stays QUIET for a name-only edit — the label changed, not who is reached", async () => {
    // Mirrors the worker's recipient signature, which deliberately excludes `name`: a display-name correction
    // must not blow away live response links and re-email everyone.
    await updateFieldResponder(tdb, RESPONDER, { name: "James R. Helms" }, OFFICE);
    expect(await correctiveJobs()).toEqual([]);
    expect(await tokenCount(OPEN_CARD)).toBe(1);
    expect((await cardState(OPEN_CARD)).sentAt).not.toBeNull();
  });

  it("stays QUIET for a no-op patch that re-sends identical values", async () => {
    await updateFieldResponder(
      tdb,
      RESPONDER,
      { email: "JAMES@trock.test", role: "superintendent", isActive: true },
      OFFICE,
    );
    // Email differs only in case, role and isActive are unchanged → nothing about resolution moved.
    expect(await correctiveJobs()).toEqual([]);
    expect(await tokenCount(OPEN_CARD)).toBe(1);
  });

  it("still applies the roster edit when no office context is threaded (restart is best-effort)", async () => {
    // Mirrors the team-mutation routes: a missing office must not fail or skip the write itself.
    const updated = await updateFieldResponder(tdb, RESPONDER, { isActive: false });
    expect(updated.isActive).toBe(false);
    expect(await correctiveJobs()).toEqual([]);
  });
});
