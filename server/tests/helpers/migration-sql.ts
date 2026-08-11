// Reads a migration FROM DISK so a runtime suite can execute the file that actually ships.
//
// The alternative — retyping the DDL into the test's setup — is the failure mode this exists to remove: a
// hand copy lets a suite go on passing against an index or constraint the migration no longer creates, so
// the test proves a fixture rather than the deployed schema. Used by the *.runtime.test.ts lane, which is
// where anything with hand-written SQL belongs.
//
// Resolved relative to THIS file (server/tests/helpers/ -> repo root/migrations), never to the caller's
// __dirname, so suites colocated under server/src/ and suites under server/tests/ pass the same argument.
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const MIGRATIONS_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../../migrations");

/**
 * @param stem the migration filename without its `.sql` suffix, e.g.
 *             "0213_job_queue_glasses_walkthrough_forward_live_uniq".
 *
 * Throws — loudly, naming what it did find — rather than returning empty text for a name that does not
 * exist. A silently-empty migration executes cleanly and leaves the suite asserting against a schema with
 * no index on it at all, which is the exact shape of "green test, shipped defect" this helper is meant to
 * prevent. Renaming a migration is a real thing that happens in review.
 */
export function migrationSql(stem: string): string {
  const file = `${stem}.sql`;
  try {
    return readFileSync(join(MIGRATIONS_DIR, file), "utf-8");
  } catch {
    const nearby = readdirSync(MIGRATIONS_DIR).filter((name) => name.startsWith(stem.slice(0, 4)));
    throw new Error(`Migration ${file} not found. Migrations sharing its number: ${nearby.join(", ") || "(none)"}`);
  }
}
