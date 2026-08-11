import "dotenv/config";
import pg from "pg";
import { drizzle } from "drizzle-orm/node-postgres";
import { sql } from "drizzle-orm";
import * as schema from "../shared/src/schema/index.js";
import type { ScorecardRating } from "../shared/src/types/index.js";
import { scorecardCriticalDeficiencyLabel } from "../shared/src/types/field-scorecard.js";
import { reconcileScorecardCorrectiveActions } from "../server/src/modules/field/corrective-actions-service.js";
import { matchFieldResponders } from "../shared/src/lib/responderNameMatch.js";
import {
  BROWSABLE_PROJECT_SQL,
  WON_BROWSABLE_SLUGS,
  LOST_EXCLUDED_SLUGS,
  recipientResolutionSql,
  assignedRolesSql,
  basicValidEmail,
} from "../worker/src/jobs/scorecard-corrective-action-email.js";
import { resolveFieldScorecardRecipients } from "../shared/src/lib/fieldScorecardEmails.js";

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
 *    PRECISELY: the plan is accurate AS OF THE COMMIT. Roster rows are read inside the card's transaction
 *    under FOR SHARE, so nothing can change between the preview and the write. What the plan cannot cover is
 *    the gap AFTER it: the notification job runs a short delay later and re-runs recipientResolutionSql, so a
 *    field-responder email edited in that window redirects the notice to the then-current address, which this
 *    run never printed.
 *
 *    That re-resolution is deliberate and is NOT worked around here. Freezing the previewed identities into
 *    the job payload would have to change reconcileScorecardCorrectiveActions, which the submit and
 *    corrective-action API paths also call — so every production cycle would inherit it — and it trades a
 *    small disclosure gap for a worse failure: an address corrected in that window would either be ignored in
 *    favour of the stale one, or match nothing and notify NOBODY. Re-resolving sends to whoever is actually
 *    the responder at send time, which is the right answer. The residual exposure is that the operator may
 *    not have seen that exact address.
 *
 * USAGE
 * Build shared FIRST. Importing the server service resolves @trock-crm/shared/schema to shared/dist, so on a
 * clean checkout every command below fails at import time — before argument or database validation — with a
 * module-not-found that says nothing about the real cause. The premerge sequence happens to build shared
 * first, which is what kept this hidden.
 *
 *   npm run build --workspace=shared
 *   node --import tsx scripts/backfill-corrective-actions.ts                    # dry run, all candidates
 *   node --import tsx scripts/backfill-corrective-actions.ts --card <uuid>      # dry run, one card
 *   node --import tsx scripts/backfill-corrective-actions.ts --card <uuid> --commit
 *
 * FIELD_SCORECARD_EMAIL_RECIPIENTS should hold the DEPLOYED WORKER's value, so the plan can show the
 * oversight watchers that worker will mail. Committing without it requires --allow-unpreviewable-oversight.
 */

const COMMIT = process.argv.includes("--commit");
/**
 * Commit even though this process cannot see FIELD_SCORECARD_EMAIL_RECIPIENTS, and therefore cannot show who
 * the deployed worker will mail the oversight notice to. An explicit opt-out, never a default: the whole
 * value of the plan is that nobody is mailed who was not printed first.
 */
const ALLOW_UNPREVIEWABLE_OVERSIGHT = process.argv.includes("--allow-unpreviewable-oversight");

/**
 * Ask the operator, on the terminal, immediately after the card's plan is printed.
 *
 * A NON-INTERACTIVE stdin answers NO, never yes. Piping this script or running it from CI must not be a way
 * to skip the one human checkpoint in front of irreversible mail; if nobody can be asked, nobody approved.
 */
async function confirm(prompt: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    console.log(`${prompt}\n   (stdin is not a terminal — nobody can approve this, so declining)`);
    return false;
  }
  const { createInterface } = await import("node:readline/promises");
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return /^y(es)?$/i.test((await rl.question(prompt)).trim());
  } finally {
    rl.close();
  }
}
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
  // Lower-cased: the validator is case-insensitive but Postgres renders uuid columns in canonical
  // lowercase, so an uppercase argument passed validation and then matched no candidate — a scoped
  // `--card <UPPERCASE> --commit` exited 0 having silently done nothing at all.
  return value.toLowerCase();
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
  // Explicit, trimmed, and required. `??` treats an EMPTY string as present, so a blank
  // DATABASE_PUBLIC_URL would beat a valid DATABASE_URL; and with neither set pg does not object — it falls
  // back to ambient PG* / the local OS user, so a --commit run could open cycles and send mail against
  // whatever database happens to answer on localhost.
  const connectionString =
    [process.env.DATABASE_PUBLIC_URL, process.env.DATABASE_URL]
      .map((v) => (v ?? "").trim())
      .find((v) => v.length > 0) ?? "";
  if (!connectionString) {
    console.error("Neither DATABASE_PUBLIC_URL nor DATABASE_URL is set. Refusing to fall back to a local default.");
    process.exit(2);
  }
  const pool = new pg.Pool({ connectionString, ssl: { rejectUnauthorized: false } });

  const { rows: schemas } = await pool.query<{ nspname: string }>(
    `SELECT nspname FROM pg_namespace WHERE nspname ~ '^office_' ORDER BY nspname`,
  );

  console.log(COMMIT ? "*** COMMIT MODE — this will send email ***" : "DRY RUN (no writes, no email)");
  if (CARD_ARG) console.log(`scoped to card ${CARD_ARG}`);
  console.log();

  // Whether `--card` matched a candidate in ANY office. A syntactically valid but mistyped UUID, or a real
  // card that no longer meets the candidate predicate, otherwise takes the `continue` in every office and the
  // run exits 0 reporting "0 card(s) would be backfilled" — indistinguishable from "nothing left to do". A
  // wrapper checking the exit code records a targeted production backfill as completed having examined
  // nothing at all.
  let scopedCardSeen = false;
  const initializedSchemas: string[] = [];
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

    // BOTH tables: the candidate scan reads field_scorecards, and the scoped-card diagnostic also counts
    // scorecard_corrective_actions. Verifying only the first left the diagnostic able to reference a relation
    // that does not exist.
    const exists = await pool.query<{ ok: boolean }>(
      `SELECT to_regclass($1) IS NOT NULL AND to_regclass($2) IS NOT NULL AS ok`,
      [`${officeSchema}.field_scorecards`, `${officeSchema}.scorecard_corrective_actions`],
    );
    if (!exists.rows[0]?.ok) continue;
    // Remembered for the scoped-card diagnostic below, which unions across offices. Building that from the
    // RAW namespace list threw on any partially-initialized office_* schema — so the one path whose whole
    // job is to explain a mistyped --card was the path that could not run.
    initializedSchemas.push(officeSchema);

    const { rows: candidates } = await pool.query<CandidateRow>(
      CANDIDATE_SQL.replace(/\{S\}/g, `"${officeSchema}"`),
      [WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS],
    );
    const scoped = CARD_ARG ? candidates.filter((c) => c.id === CARD_ARG) : candidates;
    if (scoped.length === 0) continue;
    scopedCardSeen = scopedCardSeen || scoped.length > 0;

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

        // The office's active state has to hold through the COMMIT, not merely at discovery. The field
        // responder path resolves scorecards only across ACTIVE offices (cross-office.ts), so an office
        // deactivated between the office list and this card's commit leaves a committed cycle whose emailed
        // links all 404 — notified, and unanswerable. Locked, so it cannot change until this card is done.
        const officeStillActive = await client.query<{ is_active: boolean }>(
          `SELECT is_active FROM public.offices WHERE id = $1 FOR SHARE`,
          [office.id],
        );
        if (!officeStillActive.rows[0]?.is_active) {
          await client.query("ROLLBACK");
          console.log("   SKIP — office is no longer active; its response links would 404\n");
          skipped += 1;
          continue;
        }

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
              -- Re-applied here, not just in the candidate query: a card SOFT-DELETED between discovery and
              -- this transaction would otherwise pass the status/rating/action guards and get a committed
              -- cycle, while the notification worker and the responder route both exclude inactive
              -- scorecards — no email, and a response flow nobody can reach.
              AND sc.is_active = true
            -- sc AND d: locking only the scorecard left the browsable flag a read-time answer. A deal deactivated
            -- or moved to a Lost/terminal stage between this SELECT and the COMMIT would still pass the check
            -- here, and the cycle would be seeded against a deal the notification worker then skips and the
            -- responder route rejects — an open cycle nobody is told about and nobody can answer.
            -- psc is excluded because Postgres refuses FOR UPDATE on the nullable side of the outer join.
            FOR UPDATE OF sc, d`,
          [WON_BROWSABLE_SLUGS, LOST_EXCLUDED_SLUGS, card.id],
        );
        const row = locked.rows[0];

        if (!row || row.status !== "submitted" || row.rating !== "corrective_action" || row.existing_actions > 0) {
          await client.query("ROLLBACK");
          console.log(`   SKIP — gone or changed since the snapshot (status=${row?.status ?? "not found / inactive"}, actions=${row?.existing_actions ?? "-"})\n`);
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
        // The roster is read HERE — inside the card's transaction, immediately before matching, and locked —
        // not once per office outside it. An office-level snapshot is stale for every card after the first:
        // a responder added, renamed, re-roled or reactivated in between would be matched against yesterday's
        // roster, and the failure is silent in the worst direction. A newly-added SAME-NAMED person makes a
        // formerly unique name ambiguous, and the matcher's whole contract is that an ambiguous name resolves
        // to nobody — but against the stale snapshot it still looks unique, so the script writes an
        // authoritative pick and emails a person who may not be the one meant.
        //
        // FOR SHARE holds the rows read: none of them can be renamed, re-roled or deactivated between this
        // match and the COMMIT that acts on it. A brand-new row INSERTed after this read is still theoretically
        // possible — READ COMMITTED has no predicate lock to prevent it — but that window is now microseconds
        // inside one transaction rather than the whole office's run, and this script is operator-run, not
        // concurrent with roster administration.
        const rosterSql = `SELECT id, name, role, is_active AS "isActive", email FROM field_responders ORDER BY id`;
        const { rows: roster } = await client.query<RosterRow>(`${rosterSql} FOR SHARE`);
        // FOR SHARE holds the rows it READ — no existing responder can be renamed, re-roled, deactivated or
        // deleted before this card commits. It cannot stop an INSERT: READ COMMITTED has no predicate lock,
        // so a same-named person added mid-transaction is a phantom this scan never saw, and a name that was
        // unique when matched would no longer be. This fingerprint is what detects that, and it is re-taken
        // after the operator approves — see the check before COMMIT.
        const rosterFingerprint = JSON.stringify(roster);

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

        // Two DISTINCT people matched for one role slot is a decision this script must not make.
        //
        // The card holds one responder per role (recipientResolutionSql is DISTINCT ON (role)), and the
        // order names appear in free text says nothing about which of them is accountable. Keeping the first
        // and continuing quietly emailed a real corrective action to an arbitrarily chosen person — it
        // happened to agree with the human's choice on the one card run so far, which is luck, not a rule.
        // An authoritative EXISTING pick resolves it; otherwise the card is skipped for a human.
        const contested = new Set<string>();
        let unresolvedSegments = 0;
        // Per SOURCE field: did every name it held resolve into the OTHER role's slot?
        //
        // The write below fills the slot for a person's ACTUAL role, which is right, but it left the source
        // column's text untouched — so a superintendent-field "Nick Cheatam" who is a project manager set
        // pm_name AND kept superintendent_name, and the QC report, the deal scorecard view and the generated
        // PDF all read those two raw columns directly. The card then showed one person as BOTH the
        // superintendent and the PM. Tracked per field so the source text is only cleared when nobody
        // in-role remains to justify it.
        const sourceFieldMovedAway: Record<"superintendent" | "project_manager", boolean> = {
          superintendent: false,
          project_manager: false,
        };
        for (const [label, result, sourceRole] of [
          ["superintendent_name", sup, "superintendent"],
          ["pm_name", pm, "project_manager"],
        ] as const) {
          if (result.matches.length > 0) {
            sourceFieldMovedAway[sourceRole] = result.matches.every((m) => !m.roleMatchesQuery);
          }
          for (const m of result.matches) {
            const slot = m.responder.role === "project_manager" ? "project_manager" : "superintendent";
            if (picks[slot]) {
              if (picks[slot]!.id !== m.responder.id) {
                if (heldSlots.has(slot)) {
                  console.log(`   ${label}: "${m.matchedText}" -> ${m.responder.name} NOT APPLIED — ${slot} is an explicit existing pick (${picks[slot]!.name})`);
                } else {
                  contested.add(slot);
                  console.log(`   ${label}: "${m.matchedText}" -> ${m.responder.name} COMPETES with ${picks[slot]!.name} for the single ${slot} slot`);
                }
              }
              continue;
            }
            picks[slot] = m.responder;
            console.log(`   ${label}: "${m.matchedText}" -> ${m.responder.name} <${m.responder.email ?? "no email"}> [${slot}]${m.roleMatchesQuery ? "" : "  (typed into the other role's field)"}`);
          }
          // A field that names somebody this script CANNOT resolve is not safely partially resolvable.
          //
          // My own spec warns callers about exactly this shape — "matches.length > 0 does not mean the field
          // is fully resolved; gating on it silently drops the second recipient" — and this caller then did
          // it: "Brett Bell / <someone unmatched>" committed Brett Bell as the sole responder and emailed
          // him, while the other person named on the card was quietly discarded. An unresolved segment means
          // a human has to look, unless an authoritative existing pick already settles that role.
          for (const a of result.ambiguous) {
            console.log(`   ${label}: "${a.matchedText}" AMBIGUOUS (${a.candidates.map((c) => c.name).join(" | ")}) — needs a human`);
            unresolvedSegments += 1;
          }
          for (const u of result.unmatched) {
            console.log(`   ${label}: "${u}" UNMATCHED — nobody on the roster`);
            unresolvedSegments += 1;
          }
        }

        if (unresolvedSegments > 0 && !(heldSlots.has("superintendent") && heldSlots.has("project_manager"))) {
          await client.query("ROLLBACK");
          console.log(`   SKIP — ${unresolvedSegments} segment(s) name somebody unresolvable; emailing the resolvable subset would silently drop them\n`);
          skipped += 1;
          continue;
        }

        if (contested.size > 0) {
          await client.query("ROLLBACK");
          console.log(`   SKIP — ${[...contested].join(" and ")} named more than one person; a human must choose (set the responder pick on the card, then re-run)\n`);
          skipped += 1;
          continue;
        }

        // EVERY role this card selects must be deliverable — not merely one of them. Requiring only a
        // non-empty set let a card naming both a super and a PM proceed when one of the two roster rows had
        // a null or malformed address: the worker skips that recipient, mails the other, and — with no
        // deal_team_members row to make the role "assigned" — stamps the cycle as delivered. The named person
        // is then never notified and the cycle is closed against a retry. Silently omitting a named responder
        // is the exact failure this backfill exists to undo.
        const selectedRoles = (["superintendent", "project_manager"] as const).filter((role) => picks[role]);
        const undeliverable = selectedRoles.filter((role) => {
          const pick = picks[role]!;
          return !pick.isActive || !pick.email || !basicValidEmail(pick.email.trim());
        });
        if (selectedRoles.length === 0) {
          await client.query("ROLLBACK");
          console.log("   SKIP — no deliverable recipient; opening a cycle nobody can answer helps no one\n");
          skipped += 1;
          continue;
        }
        if (undeliverable.length > 0) {
          await client.query("ROLLBACK");
          for (const role of undeliverable) {
            const pick = picks[role]!;
            console.log(
              `   ${role}: ${pick.name} is not deliverable — ${!pick.isActive ? "roster row is INACTIVE" : `email ${JSON.stringify(pick.email ?? null)} is missing or malformed`}`,
            );
          }
          console.log("   SKIP — a named responder cannot be emailed; notifying only part of the named team is worse than notifying nobody\n");
          skipped += 1;
          continue;
        }

        console.log(`   FLAGGED ITEMS (${actionItems.length + deficiencies.length}):`);
        actionItems.forEach((a, i) => console.log(`     action_item[${i}]  ${a}`));
        // The LABEL, resolved through the same helper reconcile seeds the rows with, not just the stored key.
        // Printing `deficiency[site_org_below]` showed the operator different text from the email they were
        // authorizing — and the plan is only a safeguard if what it shows is what gets sent. The key stays
        // alongside it, because that is what the corrective_actions row and the response flow are keyed on.
        deficiencies.forEach((d) =>
          console.log(`     deficiency[${d}]  ${scorecardCriticalDeficiencyLabel(d)}`),
        );

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

        // A source field whose names ALL belong to the other role no longer names anybody in ITS role, and
        // leaving the text there makes three read surfaces show the same person twice. Cleared only when the
        // slot is also unfilled — a held or freshly-matched in-role pick is the legitimate occupant.
        for (const [role, column] of [
          ["superintendent", "superintendent_name"],
          ["project_manager", "pm_name"],
        ] as const) {
          if (sourceFieldMovedAway[role] && !picks[role]) {
            await client.query(`UPDATE field_scorecards SET ${column} = NULL WHERE id = $1`, [row.id]);
            console.log(`   ${column}: CLEARED — every name in it resolved to the other role`);
          }
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

        // ...AND THE OVERSIGHT WATCHERS. Reconcile enqueues a SECOND job,
        // scorecard_corrective_action_oversight_email, which mails FIELD_SCORECARD_EMAIL_RECIPIENTS minus the
        // cycle's responders. Previewing only the responder job broke this script's one promise — that every
        // address about to receive irreversible mail is printed BEFORE the commit prompt — because those
        // watchers were mailed moments later having never appeared in the plan.
        //
        // The subtraction and the phase are the oversight job's, not a paraphrase: the backfill opens a cycle,
        // so the notice is `opened`, which is the one phase that excludes responders.
        const responderEmails = new Set(
          resolved.rows
            .map((r) => r.email?.trim().toLowerCase())
            .filter((email): email is string => !!email),
        );
        //
        // READ THE PROVENANCE NOTE. This resolves FIELD_SCORECARD_EMAIL_RECIPIENTS from THIS process, while
        // the queued job is executed later by the deployed worker against the WORKER's environment. When the
        // two differ — a local shell, a one-off container, an operator who never exported the variable — the
        // preview is not merely incomplete, it is confidently wrong in the one direction that matters: it
        // prints "(nobody)" and production then mails a watcher list this run never showed anybody.
        //
        // So an unset variable REFUSES TO COMMIT rather than previewing an empty list. There is no way for
        // this process to read the worker's environment, and quietly presenting its own as authoritative is
        // what turns "every recipient is printed before the commit" into a promise this script cannot keep.
        // Tested on the RAW variable, never on the resolver's output. resolveFieldScorecardRecipients
        // fabricates a placeholder address under NODE_ENV=development|test so local runs work, which made
        // the guard below see a non-empty list and rule the production watcher list "previewable" — the
        // operator approved a plan naming a dev placeholder while the deployed worker went on to mail its
        // real watchers. The question this guard has to ask is whether the AUTHORITATIVE value was supplied
        // to this process, and only the variable itself answers that.
        const oversightExplicitlyConfigured = (process.env.FIELD_SCORECARD_EMAIL_RECIPIENTS ?? "").trim().length > 0;
        const oversightConfigured = oversightExplicitlyConfigured
          ? resolveFieldScorecardRecipients(process.env)
          : [];
        const watchers = [
          ...new Set(
            oversightConfigured
              .filter((email) => !responderEmails.has(email.trim().toLowerCase()))
              .map((email) => email.trim().toLowerCase()),
          ),
        ];
        console.log("   OVERSIGHT WILL EMAIL (as configured in THIS process — the worker resolves its own):");
        if (watchers.length === 0 && oversightConfigured.length > 0) {
          console.log("     (nobody — every configured watcher is already a responder on this card)");
        }
        for (const email of watchers) console.log(`     watcher          <${email}>`);
        if (!oversightExplicitlyConfigured) {
          console.log("     (FIELD_SCORECARD_EMAIL_RECIPIENTS not set in this process — cannot preview who the worker will mail)");
          if (COMMIT && !ALLOW_UNPREVIEWABLE_OVERSIGHT) {
            throw new Error(
              "FIELD_SCORECARD_EMAIL_RECIPIENTS is unset in this process, so the oversight watchers the WORKER " +
                "will email cannot be previewed. Export the worker's value to preview it, or pass " +
                "--allow-unpreviewable-oversight to commit knowing addresses will be mailed that were never shown.",
            );
          }
        }
        // The worker's answer is the one that counts, and it is read AFTER the writes. The earlier
        // `deliverable` check is against the roster snapshot: somebody deactivated between that snapshot and
        // this transaction passes it, gets their id written, and then resolves to nothing here. Printing
        // "(nobody)" and committing anyway leaves an open cycle whose job retries to dead-letter.
        // basicValidEmail is the worker's OWN predicate, imported rather than approximated. A non-empty
        // check is not the same test: the worker rejects a malformed address, then throws for having zero
        // recipients and dead-letters — so a card whose only addresses are junk would have committed an
        // unnotified cycle while this guard reported success.
        if (!resolved.rows.some((r) => r.email && basicValidEmail(r.email.trim()))) {
          throw new Error("the worker resolves no VALID email recipient — refusing to commit a cycle nobody is told about");
        }

        // EVERY assigned role must resolve, not merely one of them. `some(...)` above answers "will anyone be
        // told?"; the worker asks a strictly harder question and throws unless EVERY role with an active
        // deal_team_members row resolved to a deliverable address. So a deal assigning both a super and a PM,
        // where only the super has a usable email, passes the check above, mails the super, and then throws —
        // retrying to dead-letter without ever stamping, leaving a committed cycle permanently half-notified.
        // assignedRolesSql is the worker's OWN query, imported so the two cannot drift.
        const resolvedRoles = new Set(
          resolved.rows
            .filter((r) => r.email && basicValidEmail(r.email.trim()))
            .map((r) => String(r.role)),
        );
        const assigned = await client.query<{ role: string }>(assignedRolesSql(`"${officeSchema}"`), [row.deal_id]);
        const unresolvedAssignedRoles = assigned.rows
          .map((r) => String(r.role))
          .filter((role) => !resolvedRoles.has(role));
        if (unresolvedAssignedRoles.length > 0) {
          throw new Error(
            `assigned role(s) ${unresolvedAssignedRoles.join(", ")} resolve to no deliverable address — the worker would notify only part of the team and then retry to dead-letter; refusing to commit`,
          );
        }

        // ...AND the roles this script itself selected. The check above is necessary but does NOT cover them:
        // assignedRolesSql reads deal_team_members, which is EMPTY office-wide, so for every card here it
        // returns nothing and the guard passes vacuously. The roles that actually matter are the scorecard
        // picks this transaction just wrote. A picked role the worker cannot resolve is worse than an
        // unresolvable assigned one, because nothing makes the worker throw — it mails whoever it can and
        // STAMPS the cycle, so the omission is permanent and silent rather than retried.
        const unresolvedSelectedRoles = selectedRoles.filter((role) => !resolvedRoles.has(role));
        if (unresolvedSelectedRoles.length > 0) {
          throw new Error(
            `selected role(s) ${unresolvedSelectedRoles.join(", ")} do not resolve to a valid address through the worker's own query — it would mail the other role and stamp the cycle, leaving a named responder silently unnotified; refusing to commit`,
          );
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
          // The plan above is only a safeguard if somebody reads it BEFORE the mail is queued. Committing
          // straight after printing gave the operator nothing to act on, and a prior dry run is not a
          // substitute: this run deliberately re-reads live cards, rosters and recipients under its own
          // locks, so its plan can legitimately differ from the one that was reviewed.
          const approved = await confirm(`   Commit this card and send the mail above? [y/N] `);
          if (!approved) {
            await client.query("ROLLBACK");
            console.log("   DECLINED — rolled back, no mail sent\n");
            skipped += 1;
            continue;
          }

          // The approval prompt turned the phantom-insert window from microseconds into however long the
          // operator spends reading. A responder added in that time can make a name that matched uniquely
          // ambiguous, and the matcher's whole contract is that an ambiguous name resolves to NOBODY — so
          // committing the pick derived before the prompt would mail a person the evidence no longer
          // identifies. Re-taken here rather than re-derived: any roster change at all invalidates the plan
          // the operator actually approved, and re-running the match would be a second copy of the
          // derivation free to drift from the first.
          const { rows: rosterNow } = await client.query<RosterRow>(rosterSql);
          if (JSON.stringify(rosterNow) !== rosterFingerprint) {
            await client.query("ROLLBACK");
            console.log("   ABORTED — the responder roster changed while this card was awaiting approval;");
            console.log("   the plan you approved is no longer the evidence. Re-run to see the current one.\n");
            failed += 1;
            continue;
          }
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

  // Say WHICH of the three it was, because the operator's next step differs in each case: a typo is retyped,
  // an already-processed card is left alone, and an ineligible one is a question about the card.
  if (CARD_ARG && !scopedCardSeen && initializedSchemas.length === 0) {
    console.error(`--card ${CARD_ARG}: no office schema has an initialized field_scorecards table. Nothing was examined.`);
    process.exitCode = 1;
  } else if (CARD_ARG && !scopedCardSeen) {
    const found = await pool.query<{ schema: string; status: string; rating: string; is_active: boolean; actions: string }>(
      initializedSchemas
        .map(
          (nspname) => `SELECT '${nspname}' AS schema, sc.status, sc.rating::text AS rating, sc.is_active,
                     (SELECT count(*) FROM "${nspname}".scorecard_corrective_actions ca WHERE ca.scorecard_id = sc.id)::text AS actions
                FROM "${nspname}".field_scorecards sc WHERE sc.id = $1`,
        )
        .join(" UNION ALL "),
      [CARD_ARG],
    );
    const hit = found.rows[0];
    console.error(
      hit
        ? `--card ${CARD_ARG} exists in ${hit.schema} but is NOT a backfill candidate ` +
            `(status=${hit.status}, rating=${hit.rating}, is_active=${hit.is_active}, existing corrective actions=${hit.actions}). ` +
            "Nothing was examined."
        : `--card ${CARD_ARG} matches no scorecard in any office. Nothing was examined — check the UUID.`,
    );
    process.exitCode = 1;
  }

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
