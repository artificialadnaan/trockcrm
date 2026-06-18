/**
 * One-time cleanup: dismiss the existing backlog of stale `daily_first_outreach_touchpoint` tasks
 * (resolved-but-lingering + aged-out), across every active office.
 *
 * This reuses the SAME `dismissResolvedFirstOutreachTasks` the daily worker now runs, so there is no
 * predicate drift. DRY-RUN BY DEFAULT: each office's dismissal runs inside a transaction that is rolled
 * back unless `--apply` is passed, so a dry run reports the exact count that WOULD be dismissed without
 * changing anything. (The daily job also drains this backlog on its next run; this just lets ops do it
 * now, with a preview.)
 *
 *   Dry run (default):  DATABASE_URL=... tsx worker/src/scripts/dismiss-stale-first-outreach.ts
 *   Apply:              DATABASE_URL=... tsx worker/src/scripts/dismiss-stale-first-outreach.ts --apply
 */
import { pool } from "../db.js";
import { dismissResolvedFirstOutreachTasks } from "../jobs/daily-tasks.js";

const SLUG_REGEX = /^[a-z][a-z0-9_]*$/;

export async function runDismissStaleFirstOutreach(apply: boolean): Promise<{ total: number; failures: number }> {
  const client = await pool.connect();
  let total = 0;
  let failures = 0;
  try {
    const offices = await client.query<{ id: string; slug: string }>(
      "SELECT id, slug FROM public.offices WHERE is_active = true"
    );

    for (const office of offices.rows) {
      if (!SLUG_REGEX.test(office.slug)) {
        console.warn(`[dismiss-first-outreach] Invalid office slug "${office.slug}" — skipping`);
        failures += 1;
        continue;
      }
      const schemaName = `office_${office.slug}`;
      try {
        await client.query("BEGIN");
        const dismissed = await dismissResolvedFirstOutreachTasks(client, schemaName, office.id);
        if (apply) {
          await client.query("COMMIT");
        } else {
          await client.query("ROLLBACK");
        }
        total += dismissed;
        console.log(
          `[dismiss-first-outreach] ${office.slug}: ${dismissed} task(s) ${apply ? "dismissed" : "would be dismissed (dry run)"}`
        );
      } catch (officeErr) {
        // Keep processing the other offices, but record the failure so the process exits non-zero — a
        // partial cleanup must be visible to schedulers/ops automation, not silently succeed.
        await client.query("ROLLBACK").catch(() => {});
        failures += 1;
        console.error(`[dismiss-first-outreach] Office ${office.slug} failed:`, officeErr);
      }
    }
  } finally {
    client.release();
  }
  console.log(
    `[dismiss-first-outreach] ${apply ? "Applied" : "Dry run"} complete. ${total} task(s) ${apply ? "dismissed" : "would be dismissed"} across all offices` +
      (failures > 0 ? `, ${failures} office(s) FAILED.` : ".")
  );
  return { total, failures };
}

const isMain = process.argv[1] != null && import.meta.url === `file://${process.argv[1]}`;
if (isMain) {
  const apply = process.argv.includes("--apply");
  runDismissStaleFirstOutreach(apply)
    .then(({ failures }) => pool.end().then(() => process.exit(failures > 0 ? 1 : 0)))
    .catch((err) => {
      console.error("[dismiss-first-outreach] Failed:", err);
      pool.end().finally(() => process.exit(1));
    });
}
