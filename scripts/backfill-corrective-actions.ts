import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../shared/src/schema/index.js";
import { reconcileScorecardCorrectiveActions } from "../server/src/modules/field/corrective-actions-service.js";
import { matchFieldResponders } from "../shared/src/lib/responderNameMatch.js";

/**
 * One-off backfill: open the corrective-action cycle on below-band scorecards that predate the feature.
 *
 * WHY THIS EXISTS
 * A scorecard that trips the corrective-action band is supposed to open a cycle and email the deal's
 * superintendent / project manager. Cards submitted before that shipped never did, so their flagged items
 * were never assigned to anyone. In office_dallas four cards sit at `rating = corrective_action` with
 * `status = submitted`, scored 3.5 to 6.5, and asked nothing of anybody.
 *
 * IT CALLS THE REAL SERVICE, NOT A COPY OF IT
 * `reconcileScorecardCorrectiveActions` is the same function the submit and edit paths use. It owns the
 * seeding, the `submitted -> corrective_action_open` transition, the cycle nonce, the token purge and the
 * notification enqueue, and several of those invariants are subtle (the nonce is the Resend idempotency
 * dimension; a stale enqueue double-sends). Re-implementing them here would be a second copy that drifts.
 *
 * RECIPIENTS
 * `deal_team_members` is empty office-wide and none of these cards recorded a roster pick, so recipient
 * resolution would find nobody. The typed free text is matched to the field-responder roster with the
 * shared matcher, and the resolved ids are written to superintendent_responder_id / pm_responder_id — the
 * same columns the mobile picker writes, which is the branch recipientResolutionSql prefers.
 *
 * A match is written ONLY when it is unambiguous. `ambiguous` and `unmatched` are reported and skipped:
 * this backfill will not guess who to email. And because the field a name was typed into is not evidence of
 * the role that person holds ("Nick Cheaham" is a project manager sitting in a superintendent field), each
 * person is written to the slot for their ACTUAL role — recipientResolutionSql joins on role, so a PM id in
 * the superintendent column resolves to nobody.
 *
 * SAFETY
 *  - dry-run by DEFAULT. `--commit` writes. A dry run does everything inside a transaction and ROLLS BACK,
 *    so the printed plan is what the real code path actually did, not a prediction of it.
 *  - IDEMPOTENT: a card that already has corrective actions, or is not `submitted` + below band, is skipped.
 *    A second run finds nothing.
 *  - one transaction per card; a failure rolls that card back and does not stop the others.
 *  - ⚠️ COMMITTING SENDS EMAIL to real people, and email cannot be recalled. The plan prints every intended
 *    recipient and the item text before anything is written. Read it.
 *
 * USAGE
 *   node --import tsx scripts/backfill-corrective-actions.ts                    # dry run, all candidates
 *   node --import tsx scripts/backfill-corrective-actions.ts --card <uuid>      # dry run, one card
 *   node --import tsx scripts/backfill-corrective-actions.ts --card <uuid> --commit
 */

const COMMIT = process.argv.includes("--commit");
const CARD_ARG = (() => {
  const i = process.argv.indexOf("--card");
  return i >= 0 ? process.argv[i + 1] : null;
})();

interface CandidateRow {
  id: string;
  deal_id: string;
  deal_number: string | null;
  deal_name: string | null;
  kind: string | null;
  rating: string;
  total_score: number | null;
  average_score: string | null;
  week_of: string;
  submitted_at: Date;
  superintendent_name: string | null;
  pm_name: string | null;
  superintendent_responder_id: string | null;
  pm_responder_id: string | null;
  action_items: string[] | null;
  critical_deficiencies: string[] | null;
  existing_actions: number;
}

interface RosterRow {
  id: string;
  name: string;
  role: string;
  isActive: boolean;
  email: string | null;
}

/** Candidates: below band, still `submitted`, live card, and no corrective actions yet. */
const CANDIDATE_SQL = `
  SELECT sc.id, sc.deal_id, d.deal_number, d.name AS deal_name, sc.kind, sc.rating,
         sc.total_score, sc.average_score, sc.week_of::text, sc.submitted_at,
         sc.superintendent_name, sc.pm_name, sc.superintendent_responder_id, sc.pm_responder_id,
         sc.action_items, sc.critical_deficiencies,
         (SELECT count(*)::int FROM {S}.scorecard_corrective_actions ca WHERE ca.scorecard_id = sc.id)
           AS existing_actions
    FROM {S}.field_scorecards sc
    JOIN {S}.deals d ON d.id = sc.deal_id
   WHERE sc.rating = 'corrective_action'
     AND sc.status = 'submitted'
     AND sc.is_active = true
     AND d.is_active = true
     AND COALESCE(d.is_test_data, false) = false
   ORDER BY sc.submitted_at DESC`;

function fmt(row: CandidateRow): string {
  const score = row.average_score ? `${row.average_score}/10` : `${row.total_score}/100`;
  return `${row.submitted_at.toISOString().slice(0, 10)}  ${row.deal_number ?? "—"}  ${row.deal_name ?? "—"} (${row.kind ?? "project"}, ${score})`;
}

async function main() {
  const pool = new pg.Pool({
    connectionString: process.env.DATABASE_PUBLIC_URL ?? process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false },
  });

  const { rows: schemas } = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname`,
  );

  console.log(COMMIT ? "*** COMMIT MODE — this will send email ***" : "DRY RUN (no writes, no email)");
  if (CARD_ARG) console.log(`scoped to card ${CARD_ARG}`);
  console.log();

  let planned = 0;
  let skipped = 0;

  for (const { nspname: officeSchema } of schemas) {
    const slug = officeSchema.replace(/^office_/, "");
    const officeRow = await pool.query<{ id: string }>(
      `SELECT id FROM public.offices WHERE slug = $1 LIMIT 1`,
      [slug],
    );
    if (officeRow.rowCount === 0) continue;
    const office = { id: officeRow.rows[0].id, slug };

    const exists = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${officeSchema}.field_scorecards`]);
    if (!exists.rows[0]?.ok) continue;

    const { rows: candidates } = await pool.query<CandidateRow>(
      CANDIDATE_SQL.replace(/\{S\}/g, `"${officeSchema}"`),
    );
    const scoped = CARD_ARG ? candidates.filter((c) => c.id === CARD_ARG) : candidates;
    if (scoped.length === 0) continue;

    const { rows: roster } = await pool.query<RosterRow>(
      `SELECT id, name, role, is_active AS "isActive", email FROM "${officeSchema}".field_responders`,
    );

    console.log(`### ${officeSchema} — ${scoped.length} candidate(s)\n`);

    for (const card of scoped) {
      console.log(fmt(card));

      if (card.existing_actions > 0) {
        console.log(`   SKIP — already has ${card.existing_actions} corrective action(s); this is idempotent\n`);
        skipped += 1;
        continue;
      }

      const actionItems = (card.action_items ?? []).map((s) => s.trim()).filter(Boolean);
      const deficiencies = card.critical_deficiencies ?? [];
      if (actionItems.length === 0 && deficiencies.length === 0) {
        // The reconcile gate is `isCorrectiveActionBand && flagged.length > 0`. A leadership card recorded
        // no flagged items before the form could capture them, so there is genuinely nothing to ask for.
        // Inventing findings and emailing them to a superintendent is not this script's call to make.
        console.log("   SKIP — below band but NOTHING FLAGGED; a human must supply the items first\n");
        skipped += 1;
        continue;
      }

      // ── Recipients ────────────────────────────────────────────────────────────────────────────────────
      const resolve = (text: string | null, role: string) =>
        matchFieldResponders({ text, role, roster });
      const sup = resolve(card.superintendent_name, "superintendent");
      const pm = resolve(card.pm_name, "project_manager");

      // Written by the person's ACTUAL role, never by the field they were typed into.
      const picks: { superintendent?: RosterRow; project_manager?: RosterRow } = {};
      const notes: string[] = [];
      for (const [label, result] of [["superintendent_name", sup], ["pm_name", pm]] as const) {
        for (const m of result.matches) {
          const slot = m.responder.role === "project_manager" ? "project_manager" : "superintendent";
          if (picks[slot] && picks[slot]!.id !== m.responder.id) {
            notes.push(`${label}: "${m.matchedText}" -> ${m.responder.name} DROPPED — ${slot} slot already taken by ${picks[slot]!.name} (the flow addresses one per role)`);
            continue;
          }
          picks[slot] = m.responder;
          notes.push(`${label}: "${m.matchedText}" -> ${m.responder.name} <${m.responder.email ?? "no email"}> [${slot}]${m.roleMatchesQuery ? "" : "  (typed into the other role's field)"}`);
        }
        for (const a of result.ambiguous) {
          notes.push(`${label}: "${a.matchedText}" AMBIGUOUS (${a.candidates.map((c) => c.name).join(" | ")}) — skipped, needs a human`);
        }
        for (const u of result.unmatched) {
          notes.push(`${label}: "${u}" UNMATCHED — nobody on the roster`);
        }
      }
      notes.forEach((n) => console.log(`   ${n}`));

      const recipients = [picks.superintendent, picks.project_manager].filter(Boolean) as RosterRow[];
      const deliverable = recipients.filter((r) => r.email && r.isActive);
      if (deliverable.length === 0) {
        console.log("   SKIP — no deliverable recipient; opening a cycle nobody can answer helps no one\n");
        skipped += 1;
        continue;
      }

      console.log(`   FLAGGED ITEMS (${actionItems.length + deficiencies.length}):`);
      actionItems.forEach((a, i) => console.log(`     action_item[${i}]  ${a}`));
      deficiencies.forEach((d) => console.log(`     deficiency[${d}]`));
      console.log(`   WILL EMAIL: ${deliverable.map((r) => `${r.name} <${r.email}>`).join(", ")}`);

      // ── Apply, through the real service ───────────────────────────────────────────────────────────────
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${officeSchema}", public`);
        const tx = drizzle(client, { schema }) as never;

        if (picks.superintendent) {
          await client.query(`UPDATE field_scorecards SET superintendent_responder_id = $1 WHERE id = $2`, [picks.superintendent.id, card.id]);
        }
        if (picks.project_manager) {
          await client.query(`UPDATE field_scorecards SET pm_responder_id = $1 WHERE id = $2`, [picks.project_manager.id, card.id]);
        }

        await reconcileScorecardCorrectiveActions(tx, {
          scorecardId: card.id,
          office,
          rating: card.rating as never,
          actionItems,
          deficiencies,
          currentStatus: "submitted",
        } as never);

        const after = await client.query<{ status: string; n: string; jobs: string }>(
          `SELECT sc.status,
                  (SELECT count(*) FROM scorecard_corrective_actions WHERE scorecard_id = sc.id) AS n,
                  (SELECT count(*) FROM public.job_queue
                    WHERE job_type LIKE 'scorecard_corrective_action%'
                      AND payload->>'scorecardId' = sc.id::text) AS jobs
             FROM field_scorecards sc WHERE sc.id = $1`,
          [card.id],
        );
        const a = after.rows[0];
        console.log(`   RESULT: status=${a.status}  corrective_actions=${a.n}  queued_jobs=${a.jobs}`);

        if (COMMIT) {
          await client.query("COMMIT");
          console.log("   *** COMMITTED ***\n");
        } else {
          await client.query("ROLLBACK");
          console.log("   (rolled back — dry run)\n");
        }
        planned += 1;
      } catch (err) {
        await client.query("ROLLBACK");
        console.log(`   FAILED, rolled back: ${(err as Error).message}\n`);
      } finally {
        client.release();
      }
    }
  }

  console.log(`${planned} card(s) ${COMMIT ? "backfilled" : "would be backfilled"}, ${skipped} skipped.`);
  if (!COMMIT && planned > 0) console.log("Re-run with --commit to apply. THAT SENDS EMAIL.");
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
