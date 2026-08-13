/**
 * One-time backfill: capitalise the user display names that were stored lowercase.
 *
 * `public.users` accumulated names typed straight into a field-user invite or the admin form — "nick
 * reyes", "kevin posey", "corey mcshane" — which then appeared in every people picker next to properly
 * cased ones. The write paths now normalise (see toProperCaseName), so this exists ONLY to correct the
 * rows written before that; it is not a recurring job.
 *
 * DRY-RUN BY DEFAULT. Pass --execute to write. Every run prints the exact before → after for each row, so
 * the dry-run output IS the review artefact.
 *
 * TWO SOURCES OF TRUTH, DELIBERATELY:
 *   • toProperCaseName for the general rule, so the backfill and the write paths cannot disagree.
 *   • CURATED_OVERRIDES for names the conservative rule cannot get right. It refuses to guess Mc/Mac
 *     (that heuristic turns "macey" into "MacEy"), so "corey mcshane" would land on "Corey Mcshane". A
 *     human reading the roster knows it is "McShane". Hard-coding the handful of real exceptions is
 *     honest; teaching the shared helper to guess is not.
 *
 * `public.users` is NOT tenant-scoped, so this runs once against the shared schema — no tenant loop.
 */
import pg from "pg";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { toProperCaseName } from "../lib/person-name.js";

/**
 * Exact, reviewed spellings for rows the general rule would get wrong.
 *
 * Keyed by the CURRENT stored value, lowercased, so an entry cannot silently apply to a different row
 * than the one it was written for. Anything not listed here follows toProperCaseName.
 */
const CURATED_OVERRIDES: Record<string, string> = {
  "corey mcshane": "Corey McShane",
  // The surname column needs its own entry: it is corrected independently of display_name, so without
  // this the same person would be stored as "Corey McShane" with a last_name of "Mcshane".
  mcshane: "McShane",
};

export interface UserNameRow {
  id: string;
  email: string;
  role: string;
  display_name: string | null;
  first_name: string | null;
  last_name: string | null;
}

export interface NameCasingChange {
  id: string;
  email: string;
  role: string;
  before: string;
  after: string;
  source: "curated" | "rule";
  /** Which of the three name columns this row rewrites; unchanged columns are omitted. */
  fields: {
    displayName?: { before: string; after: string };
    firstName?: { before: string; after: string };
    lastName?: { before: string; after: string };
  };
}

function correct(value: string | null, options: { surname?: boolean } = {}): { before: string; after: string } | null {
  const before = value ?? "";
  if (!before.trim()) return null;
  const curated = CURATED_OVERRIDES[before.trim().toLowerCase()];
  const after = curated ?? toProperCaseName(before, options);
  return after === before ? null : { before, after };
}

/**
 * ALL THREE NAME COLUMNS, not just display_name (Codex P2).
 *
 * The field-invite path — the source of most of these rows — writes first_name and last_name alongside
 * display_name, and the Admin → Field Users table renders `{firstName} {lastName}` directly rather than
 * the display name. Correcting only display_name would leave exactly the people this cleanup is for still
 * visibly lowercased on that screen and in the field app's identity UI.
 */
export function planNameCasingChanges(rows: UserNameRow[]): NameCasingChange[] {
  const changes: NameCasingChange[] = [];
  for (const row of rows) {
    const displayName = correct(row.display_name);
    const firstName = correct(row.first_name);
    // Surname context, so "van beethoven" stays "van Beethoven" and matches the display_name this same
    // plan writes — otherwise the parts-based views would render "Ludwig Van Beethoven".
    const lastName = correct(row.last_name, { surname: true });
    if (!displayName && !firstName && !lastName) continue;

    const fields: NameCasingChange["fields"] = {};
    if (displayName) fields.displayName = displayName;
    if (firstName) fields.firstName = firstName;
    if (lastName) fields.lastName = lastName;

    // A row whose display_name is already correct can still need its parts fixed; label it by whatever
    // name we do have so the review output never prints an empty before/after.
    const headline = displayName ?? { before: row.display_name ?? row.email, after: row.display_name ?? row.email };
    const usedCurated = [displayName, firstName, lastName].some(
      (change) => change && CURATED_OVERRIDES[change.before.trim().toLowerCase()] === change.after
    );

    changes.push({
      id: row.id,
      email: row.email,
      role: row.role,
      before: headline.before,
      after: headline.after,
      source: usedCurated ? "curated" : "rule",
      fields,
    });
  }
  return changes;
}

export async function main(argv = process.argv.slice(2)): Promise<void> {
  const execute = argv.includes("--execute");
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");

  const client = new pg.Client({ connectionString });
  await client.connect();
  try {
    const { rows } = await client.query<UserNameRow>(
      // Test-data accounts are excluded, not merely unimportant: they are already out of every roster this
      // change feeds, and one of them is literally named "SMOKE TEST DELETE …" in caps — re-casing that to
      // "Smoke Test Delete …" would file the serial numbers off a deliberate warning label. Inactive REAL
      // users are still corrected, so reactivating someone does not resurrect the old spelling.
      `SELECT id, email, role::text AS role, display_name, first_name, last_name
         FROM public.users
        WHERE COALESCE(is_test_data, false) = false
        ORDER BY lower(display_name)`
    );

    const changes = planNameCasingChanges(rows);
    console.log(`${execute ? "WRITE" : "DRY-RUN (no writes)"} — scanned ${rows.length} users`);

    if (changes.length === 0) {
      console.log("Nothing to change: every stored name already matches its normalised form.");
      return;
    }

    for (const change of changes) {
      const marker = change.source === "curated" ? " [curated]" : "";
      console.log(`  ${change.email}  (${change.role})${marker}`);
      for (const [column, field] of Object.entries(change.fields)) {
        console.log(`      ${column.padEnd(11)} ${field.before}  →  ${field.after}`);
      }
    }

    if (!execute) {
      console.log(`\n${changes.length} row(s) WOULD be updated. Re-run with --execute to apply.`);
      return;
    }

    // One statement per row rather than a bulk CASE: the set is tiny, and a per-row UPDATE keeps the WHERE
    // bound to the id AND every value we previewed, so a row edited between the dry-run and the write is
    // skipped whole rather than half-written from a stale decision. Only the columns that actually change
    // are assigned, so this cannot blank a NULL first/last name into "".
    let updated = 0;
    for (const change of changes) {
      const sets: string[] = [];
      const wheres: string[] = ["id = $1"];
      const params: unknown[] = [change.id];
      for (const [column, field] of [
        ["display_name", change.fields.displayName],
        ["first_name", change.fields.firstName],
        ["last_name", change.fields.lastName],
      ] as const) {
        if (!field) continue;
        params.push(field.after);
        sets.push(`${column} = $${params.length}`);
        params.push(field.before);
        wheres.push(`${column} = $${params.length}`);
      }
      const result = await client.query(
        `UPDATE public.users SET ${sets.join(", ")}, updated_at = now() WHERE ${wheres.join(" AND ")}`,
        params
      );
      if (result.rowCount === 0) {
        console.warn(`  SKIPPED ${change.email}: a name column changed since the preview`);
        continue;
      }
      updated += 1;
    }
    console.log(`\n=== UPDATED ${updated} of ${changes.length} row(s) ===`);
  } finally {
    await client.end();
  }
}

const executedPath = process.argv[1] ? pathToFileURL(path.resolve(process.argv[1])).href : "";
if (import.meta.url === executedPath) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
