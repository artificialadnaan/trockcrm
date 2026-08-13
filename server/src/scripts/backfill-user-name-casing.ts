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
};

export interface NameCasingChange {
  id: string;
  email: string;
  role: string;
  before: string;
  after: string;
  source: "curated" | "rule";
}

export function planNameCasingChanges(
  rows: Array<{ id: string; email: string; role: string; display_name: string | null }>
): NameCasingChange[] {
  const changes: NameCasingChange[] = [];
  for (const row of rows) {
    const before = row.display_name ?? "";
    if (!before.trim()) continue;
    const curated = CURATED_OVERRIDES[before.trim().toLowerCase()];
    const after = curated ?? toProperCaseName(before);
    if (after === before) continue;
    changes.push({
      id: row.id,
      email: row.email,
      role: row.role,
      before,
      after,
      source: curated ? "curated" : "rule",
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
    const { rows } = await client.query<{
      id: string;
      email: string;
      role: string;
      display_name: string | null;
    }>(
      // Test-data accounts are excluded, not merely unimportant: they are already out of every roster this
      // change feeds, and one of them is literally named "SMOKE TEST DELETE …" in caps — re-casing that to
      // "Smoke Test Delete …" would file the serial numbers off a deliberate warning label. Inactive REAL
      // users are still corrected, so reactivating someone does not resurrect the old spelling.
      `SELECT id, email, role::text AS role, display_name
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
      console.log(`  ${change.before}  →  ${change.after}   (${change.role}, ${change.email})${marker}`);
    }

    if (!execute) {
      console.log(`\n${changes.length} row(s) WOULD be updated. Re-run with --execute to apply.`);
      return;
    }

    // One statement per row rather than a bulk CASE: the set is tiny, and a per-row UPDATE keeps the
    // WHERE bound to the id AND the exact value we previewed, so a row edited between the dry-run and the
    // write is skipped rather than silently overwritten with a stale decision.
    let updated = 0;
    for (const change of changes) {
      const result = await client.query(
        `UPDATE public.users SET display_name = $1, updated_at = now() WHERE id = $2 AND display_name = $3`,
        [change.after, change.id, change.before]
      );
      if (result.rowCount === 0) {
        console.warn(`  SKIPPED ${change.email}: display_name changed since the preview`);
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
