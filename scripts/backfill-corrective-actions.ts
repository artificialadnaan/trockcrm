import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../shared/src/schema/index.js";
import type { ScorecardRating } from "../shared/src/types/index.js";
import { reconcileScorecardCorrectiveActions } from "../server/src/modules/field/corrective-actions-service.js";
import { matchFieldResponders } from "../shared/src/lib/responderNameMatch.js";
import {
  BROWSABLE_PROJECT_SQL,
  WON_BROWSABLE_SLUGS,
  LOST_EXCLUDED_SLUGS,
  recipientResolutionSql,
} from "../worker/src/jobs/scorecard-corrective-action-email.js";

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
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * `--card <uuid>`, or null for "every candidate".
 *
 * An ABSENT flag means all; a PRESENT flag with a missing or malformed value is a hard error, never "all".
 * `--card "$CARD" --commit` with an unset shell variable used to collapse to the falsy branch and quietly
 * widen the run to every candidate in every office — the broadest possible blast radius reached by way of
 * an attempt to narrow it, and this command sends mail that cannot be recalled.
 */
const CARD_ARG = (() => {
  const i = process.argv.indexOf("--card");
  if (i < 0) return null;
  const value = (process.argv[i + 1] ?? "").trim();
  if (!UUID.test(value)) {
    console.error(
      `--card was given ${value === "" ? "no value" : JSON.stringify(value)}; expected a scorecard UUID.\n` +
        "Refusing to run: an unusable --card must not silently widen this to every candidate.",
    );
    process.exit(2);
  }
  return value;
})();

interface CandidateRow {
  id: string;
  status: string;
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
    LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
   WHERE sc.rating = 'corrective_action'
     AND sc.status = 'submitted'
     AND sc.is_active = true
     AND COALESCE(d.is_test_data, false) = false
     -- The SAME browsable-project predicate the responder route (assertActiveCorrectiveActionScorecard)
     -- and both notification workers apply. Without it a deal that has since gone Lost or terminal is still
     -- selected: the cycle opens and seeds, then the emails are skipped and the responder link 404s — an
     -- open corrective action nobody can see or answer, which is worse than not backfilling it.
     AND ${BROWSABLE_PROJECT_SQL}
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
  let failed = 0;

  for (const { nspname: officeSchema } of schemas) {
    const slug = officeSchema.replace(/^office_/, "");
    const officeRow = await pool.query<{ id: string }>(
      // is_active — the field routes fan out only across ACTIVE offices (cross-office.ts), so a card in a
      // deactivated office would get emails whose recipients cannot resolve the owning office and whose
      // response links 404.
      `SELECT id FROM public.offices WHERE slug = $1 AND is_active = true LIMIT 1`,
      [slug],
    );
    if (officeRow.rowCount === 0) continue;
    const office = { id: officeRow.rows[0].id, slug };

    const exists = await pool.query(`SELECT to_regclass($1) IS NOT NULL AS ok`, [`${officeSchema}.field_scorecards`]);
    if (!exists.rows[0]?.ok) continue;

    const { rows: candidates } = await pool.query<CandidateRow>(
      CANDIDATE_SQL.replace(/\{S\}/g, `"${officeSchema}"`),
      [WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS],
    );
    const scoped = CARD_ARG ? candidates.filter((c) => c.id === CARD_ARG) : candidates;
    if (scoped.length === 0) continue;

    const { rows: roster } = await pool.query<RosterRow>(
      `SELECT id, name, role, is_active AS "isActive", email FROM "${officeSchema}".field_responders`,
    );

    console.log(`### ${officeSchema} — ${scoped.length} candidate(s)\n`);

    for (const card of scoped) {
      console.log(fmt(card));

      // EVERYTHING below runs inside the card's own transaction, off values re-read under its lock.
      //
      // The candidate list is an office-wide snapshot taken outside any transaction, so it is only a
      // pre-filter. Deriving the flagged items, the names or the visibility from it would let an edit that
      // landed in between be silently undone: an editor who REMOVED all the flags leaves a below-band card
      // with zero corrective actions, which passes a count-only guard, and the script would then recreate
      // the findings that person deleted and email them out.
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        await client.query(`SET LOCAL search_path TO "${officeSchema}", public`);

        const locked = await client.query<CandidateRow & { browsable: boolean }>(
          `SELECT sc.id, sc.deal_id, d.deal_number, d.name AS deal_name, sc.kind, sc.rating, sc.status,
                  sc.total_score, sc.average_score, sc.week_of::text, sc.submitted_at,
                  sc.superintendent_name, sc.pm_name,
                  sc.superintendent_responder_id, sc.pm_responder_id,
                  sc.action_items, sc.critical_deficiencies,
                  (SELECT count(*)::int FROM scorecard_corrective_actions ca WHERE ca.scorecard_id = sc.id)
                    AS existing_actions,
                  (COALESCE(d.is_test_data, false) = false AND ${BROWSABLE_PROJECT_SQL}) AS browsable
             FROM field_scorecards sc
             JOIN deals d ON d.id = sc.deal_id
             LEFT JOIN public.pipeline_stage_config psc ON psc.id = d.stage_id
            WHERE sc.id = $3
            -- OF sc: Postgres refuses FOR UPDATE on the nullable side of the outer join above.
            FOR UPDATE OF sc`,
          [WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS, card.id],
        );
        const row = locked.rows[0];

        if (!row || row.status !== "submitted" || row.rating !== "corrective_action" || row.existing_actions > 0) {
          await client.query("ROLLBACK");
          console.log(`   SKIP — changed since the snapshot (status=${row?.status}, actions=${row?.existing_actions})\n`);
          skipped += 1;
          continue;
        }
        if (!row.browsable) {
          // Re-checked here, not only in the candidate query: a deal that went Lost in between would get a
          // cycle whose emails are skipped and whose responder link 404s.
          await client.query("ROLLBACK");
          console.log("   SKIP — deal is no longer a browsable field project\n");
          skipped += 1;
          continue;
        }

        const actionItems = (row.action_items ?? []).map((s) => s.trim()).filter(Boolean);
        const deficiencies = row.critical_deficiencies ?? [];
        if (actionItems.length === 0 && deficiencies.length === 0) {
          await client.query("ROLLBACK");
          console.log("   SKIP — below band but NOTHING FLAGGED; a human must supply the items first\n");
          skipped += 1;
          continue;
        }

        // ── Recipients, matched from the LOCKED names ────────────────────────────────────────────────────
        const sup = matchFieldResponders({ text: row.superintendent_name, role: "superintendent", roster });
        const pm = matchFieldResponders({ text: row.pm_name, role: "project_manager", roster });
        const byId = new Map(roster.map((r) => [r.id, r]));

        // An EXISTING pick is authoritative and is never overwritten: recipientResolutionSql ranks the
        // card's own pick above everything else, so replacing a deliberate selection with a free-text guess
        // would redirect the corrective action away from the person somebody actually chose.
        const picks: { superintendent?: RosterRow; project_manager?: RosterRow } = {};
        // Tracks the slots whose STORED id was validated and kept. Guarding the writes below on the raw
        // column being non-null was wrong: a stale id — deleted, deactivated, or holding the other role — is
        // correctly refused here, a free-text match then fills the slot, and a raw non-null check would have
        // refused to WRITE it. recipientResolutionSql would resolve nobody, the notification job would retry
        // to dead-letter, and the script would have committed an open cycle nobody is told about: exactly
        // the failure it exists to remove.
        const heldSlots = new Set<"superintendent" | "project_manager">();
        for (const [slot, existingId] of [
          ["superintendent", row.superintendent_responder_id],
          ["project_manager", row.pm_responder_id],
        ] as const) {
          if (!existingId) continue;
          const held = byId.get(existingId);
          if (held && held.isActive && held.role === slot) {
            picks[slot] = held;
            heldSlots.add(slot);
            console.log(`   ${slot}: KEEPING existing pick ${held.name} <${held.email ?? "no email"}>`);
          } else {
            const why = !held ? "not on the roster" : !held.isActive ? "deactivated" : `holds ${held.role}`;
            console.log(`   ${slot}: existing pick ${existingId} is UNUSABLE (${why}) — will be replaced if a name matches`);
          }
        }

        for (const [label, result] of [["superintendent_name", sup], ["pm_name", pm]] as const) {
          for (const m of result.matches) {
            const slot = m.responder.role === "project_manager" ? "project_manager" : "superintendent";
            if (picks[slot]) {
              console.log(`   ${label}: "${m.matchedText}" -> ${m.responder.name} NOT APPLIED — ${slot} already resolved to ${picks[slot]!.name}`);
              continue;
            }
            picks[slot] = m.responder;
            console.log(`   ${label}: "${m.matchedText}" -> ${m.responder.name} <${m.responder.email ?? "no email"}> [${slot}]${m.roleMatchesQuery ? "" : "  (typed into the other role's field)"}`);
          }
          for (const a of result.ambiguous) {
            console.log(`   ${label}: "${a.matchedText}" AMBIGUOUS (${a.candidates.map((c) => c.name).join(" | ")}) — skipped, needs a human`);
          }
          for (const u of result.unmatched) {
            console.log(`   ${label}: "${u}" UNMATCHED — nobody on the roster`);
          }
        }

        const deliverable = [picks.superintendent, picks.project_manager]
          .filter((r): r is RosterRow => Boolean(r))
          .filter((r) => r.email && r.isActive);
        if (deliverable.length === 0) {
          await client.query("ROLLBACK");
          console.log("   SKIP — no deliverable recipient; opening a cycle nobody can answer helps no one\n");
          skipped += 1;
          continue;
        }

        console.log(`   FLAGGED ITEMS (${actionItems.length + deficiencies.length}):`);
        actionItems.forEach((a, i) => console.log(`     action_item[${i}]  ${a}`));
        deficiencies.forEach((d) => console.log(`     deficiency[${d}]`));

        // Display name AND id together, and only for a slot this run is filling. The create/edit path does
        // this so a card cannot show one person while routing to another.
        if (picks.superintendent && !heldSlots.has("superintendent")) {
          await client.query(
            `UPDATE field_scorecards SET superintendent_responder_id = $1, superintendent_name = $2 WHERE id = $3`,
            [picks.superintendent.id, picks.superintendent.name, row.id],
          );
        }
        if (picks.project_manager && !heldSlots.has("project_manager")) {
          await client.query(
            `UPDATE field_scorecards SET pm_responder_id = $1, pm_name = $2 WHERE id = $3`,
            [picks.project_manager.id, picks.project_manager.name, row.id],
          );
        }

        const tx = drizzle(client, { schema }) as unknown as Parameters<
          typeof reconcileScorecardCorrectiveActions
        >[0];
        // NOT cast to `never`. An `as never` here silently swallowed a MISSING dealId, whose job the worker
        // then discards as an invalid payload — committing an open cycle nobody is ever told about, the
        // exact failure this backfill exists to undo. The type is spelled out so the compiler checks it.
        await reconcileScorecardCorrectiveActions(tx, {
          scorecardId: row.id,
          dealId: row.deal_id,
          office,
          rating: row.rating as ScorecardRating,
          actionItems,
          deficiencies,
          currentStatus: "submitted",
          responderPickChanged: Boolean(picks.superintendent || picks.project_manager),
        });

        // WHO THE WORKER WILL ACTUALLY EMAIL — the worker's own SQL, after the writes, inside the
        // transaction. Listing only what this script matched ignores the card's existing pick and the
        // deal_team_members fallback, so it could print one recipient and mail two.
        const resolved = await client.query<{ role: string; name: string | null; email: string | null }>(
          recipientResolutionSql(`"${officeSchema}"`),
          [row.deal_id, row.id],
        );
        console.log("   WORKER WILL EMAIL:");
        if (resolved.rows.length === 0) console.log("     (nobody)");
        for (const r of resolved.rows) {
          console.log(`     ${String(r.role).padEnd(16)} ${r.name ?? "—"} <${r.email ?? "NO EMAIL"}>`);
        }

        const after = await client.query<{ status: string; n: string; jobs: string; bad: string }>(
          `SELECT sc.status,
                  (SELECT count(*) FROM scorecard_corrective_actions WHERE scorecard_id = sc.id) AS n,
                  (SELECT count(*) FROM public.job_queue
                    WHERE job_type LIKE 'scorecard_corrective_action%'
                      AND payload->>'scorecardId' = sc.id::text) AS jobs,
                  (SELECT count(*) FROM public.job_queue
                    WHERE job_type LIKE 'scorecard_corrective_action%'
                      AND payload->>'scorecardId' = sc.id::text
                      AND (payload->>'dealId' IS NULL OR payload->>'tenantSchema' IS NULL)) AS bad
             FROM field_scorecards sc WHERE sc.id = $1`,
          [row.id],
        );
        const a = after.rows[0];
        console.log(`   RESULT: status=${a.status}  corrective_actions=${a.n}  queued_jobs=${a.jobs}`);
        // Counting jobs is not enough — a job with a missing dealId is queued and then DISCARDED by the
        // worker. That is how the `as never` defect stayed invisible in the first dry run.
        if (Number(a.bad) > 0) throw new Error(`${a.bad} queued job(s) have an incomplete payload — refusing to commit`);
        if (Number(a.jobs) === 0) throw new Error("no notification job was queued — refusing to commit a cycle nobody is told about");

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
        failed += 1;
      } finally {
        client.release();
      }
    }
  }

  console.log(`${planned} card(s) ${COMMIT ? "backfilled" : "would be backfilled"}, ${skipped} skipped, ${failed} failed.`);
  if (!COMMIT && planned > 0) console.log("Re-run with --commit to apply. THAT SENDS EMAIL.");
  await pool.end();
  // A rolled-back card must not read as success. Continue-on-error is deliberate — one bad card should not
  // strand the rest — but an operator or a wrapper checking only the exit code would otherwise record a
  // partially-applied run as clean and never retry the failures.
  if (failed > 0) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
