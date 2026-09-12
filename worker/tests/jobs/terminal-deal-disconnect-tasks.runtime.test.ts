// The AI-disconnect admin-task generator, executed against a real database.
//
// Its four disconnect branches all read `deals`, and none of them consulted the deal's stage — so a Won or
// Lost deal kept generating "Resolve <disconnect> for <number>" admin tasks. 778 of the 3,395 tasks stuck
// on closed deals office-wide came from this job (prod, 2026-09-12).
//
// There is a second, sharper cost than noise, and it is what this suite pins: the branches
// `ORDER BY age_days DESC` under a `LIMIT 10`, and a closed deal's disconnect only ever gets OLDER. Closed
// work therefore crowded the live disconnects out of the window entirely — the job starved itself. So the
// assertion is not merely "the Won deal is absent"; it is "the open deal is PRESENT despite being younger
// than three closed ones", which is the behaviour the LIMIT was silently denying.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { PGlite } from "@electric-sql/pglite";

const queryMock = vi.fn();
vi.spyOn(console, "error").mockImplementation(() => {});
vi.spyOn(console, "log").mockImplementation(() => {});
vi.mock("../../src/db.js", () => ({
  pool: { connect: async () => ({ query: queryMock, release: vi.fn() }) },
}));

const { runAiDisconnectAdminTaskGeneration } = await import("../../src/jobs/ai-disconnect-admin-tasks.js");

const SCHEMA = "office_beta";
const U = (s: string) => `00000000-0000-4000-8000-${s.padStart(12, "0")}`;
const STAGE_OPEN = U("50e0");
const STAGE_WON = U("50e1");
const STAGE_LOST = U("50e2");

/** Capture the verbatim disconnect query the job issues, so the test executes production SQL, not a copy. */
async function captureDisconnectSql(): Promise<string> {
  const captured: string[] = [];
  queryMock.mockReset();
  queryMock.mockImplementation(async (sql: string) => {
    captured.push(sql);
    if (sql.includes("FROM public.offices")) return { rows: [{ id: U("0f1"), slug: "beta", name: "Beta" }] };
    if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: SCHEMA }] };
    if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
    if (sql.includes("FROM public.users")) return { rows: [{ id: U("ad1") }] };
    return { rows: [], rowCount: 0 };
  });
  await runAiDisconnectAdminTaskGeneration();
  const hits = captured.filter((s) => s.includes("disconnect_rows") && s.includes("LIMIT 10"));
  expect(hits).toHaveLength(1);
  return hits[0];
}

let db: PGlite;
beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA IF NOT EXISTS ${SCHEMA};
    CREATE TABLE public.pipeline_stage_config (
      id uuid PRIMARY KEY, name text, slug text,
      is_terminal boolean NOT NULL DEFAULT false,
      required_documents jsonb NOT NULL DEFAULT '[]'::jsonb
    );
    CREATE TABLE public.procore_sync_state (
      crm_entity_type text, crm_entity_id uuid, entity_type text,
      sync_status text, updated_at timestamptz
    );
    CREATE TABLE ${SCHEMA}.deals (
      id uuid PRIMARY KEY, deal_number text, name text, stage_id uuid, proposal_status text,
      is_active boolean NOT NULL DEFAULT true, procore_project_id text,
      stage_entered_at timestamptz, last_activity_at timestamptz, updated_at timestamptz DEFAULT now()
    );
    CREATE TABLE ${SCHEMA}.files (id uuid PRIMARY KEY, deal_id uuid, category text, is_active boolean DEFAULT true);
    CREATE TABLE ${SCHEMA}.emails (id uuid PRIMARY KEY, deal_id uuid, direction text, sent_at timestamptz);
    CREATE TABLE ${SCHEMA}.activities (id uuid PRIMARY KEY, deal_id uuid, occurred_at timestamptz, type text);
    CREATE TABLE ${SCHEMA}.tasks (id uuid PRIMARY KEY, deal_id uuid, origin_rule text, dedupe_key text, status text);

    INSERT INTO public.pipeline_stage_config (id, name, slug, is_terminal) VALUES
      ('${STAGE_OPEN}', 'Estimate Sent to Client', 'estimate_sent', false),
      ('${STAGE_WON}',  'Won',  'won',  true),
      ('${STAGE_LOST}', 'Lost', 'lost', true);

    -- The 'missing_next_task' branch fires for any deal with no open task and 3+ days of silence. The three
    -- closed deals are made much STALER than the open one, so under the LIMIT they outrank it on age.
    INSERT INTO ${SCHEMA}.deals (id, deal_number, name, stage_id, stage_entered_at, last_activity_at) VALUES
      ('${U("d001")}', 'DFW-4-OPEN',  'Open Job',  '${STAGE_OPEN}', now() - interval '10 days', now() - interval '10 days'),
      ('${U("d002")}', 'DFW-4-WON',   'Won Job',   '${STAGE_WON}',  now() - interval '300 days', now() - interval '300 days'),
      ('${U("d003")}', 'DFW-4-WON2',  'Won Job 2', '${STAGE_WON}',  now() - interval '299 days', now() - interval '299 days'),
      ('${U("d004")}', 'DFW-4-LOST',  'Lost Job',  '${STAGE_LOST}', now() - interval '298 days', now() - interval '298 days');
  `);
});

describe("the AI-disconnect admin-task generator", () => {
  it("returns the open deal and none of the closed ones", async () => {
    const sql = (await captureDisconnectSql()).replace(/\$\{schemaName\}/g, SCHEMA);
    const { rows } = await db.query<{ deal_number: string }>(sql);
    expect(rows.map((r) => r.deal_number)).toEqual(["DFW-4-OPEN"]);
  });

  it("no longer lets older CLOSED deals consume the LIMIT 10 window", async () => {
    const sql = (await captureDisconnectSql()).replace(/\$\{schemaName\}/g, SCHEMA);
    // Nine closed deals, every one staler than the open deal: on the old query they would fill the window
    // and the live disconnect would never be seen. This is the starvation the filter fixes.
    for (let i = 0; i < 9; i += 1) {
      await db.query(
        `INSERT INTO ${SCHEMA}.deals (id, deal_number, name, stage_id, stage_entered_at, last_activity_at)
         VALUES ($1, $2, 'Closed filler', $3, now() - ($4 || ' days')::interval, now() - ($4 || ' days')::interval)`,
        [U(`e${i}01`), `DFW-4-OLD${i}`, STAGE_WON, String(400 + i)]
      );
    }
    const { rows } = await db.query<{ deal_number: string }>(sql);
    expect(rows.map((r) => r.deal_number)).toContain("DFW-4-OPEN");
    expect(rows.filter((r) => r.deal_number.startsWith("DFW-4-OLD"))).toHaveLength(0);
  });
});

/**
 * The DIGEST is a separate job from the admin-task generator above, reads the same disconnect predicates,
 * and had no terminal filter on the CTE that feeds its counts (only on its at-risk query). That made it the
 * sharpest edge of this whole change: one of its disconnect predicates is `open_task_count = 0`, so the act
 * of draining debris tasks off closed deals would have turned every drained deal into a fresh
 * "follow-through gap" — the cleanup manufacturing the very disconnect it reports, and emailing every
 * director a number the page it links to (which IS gated) does not agree with.
 */
describe("the AI-disconnect digest", () => {
  async function captureDigestBaseSql(): Promise<string> {
    const captured: string[] = [];
    queryMock.mockReset();
    queryMock.mockImplementation(async (sql: string) => {
      captured.push(sql);
      if (sql.includes("FROM public.offices")) return { rows: [{ id: U("0f1"), slug: "beta", name: "Beta" }] };
      if (sql.includes("FROM information_schema.schemata")) return { rows: [{ schema_name: SCHEMA }] };
      if (sql.includes("pg_try_advisory_lock")) return { rows: [{ acquired: true }] };
      if (sql.includes("FROM public.users")) return { rows: [{ id: U("ad1") }] };
      return { rows: [], rowCount: 0 };
    });
    const { runAiDisconnectDigest } = await import("../../src/jobs/ai-disconnect-digest.js");
    await runAiDisconnectDigest();
    const hits = captured.filter((s) => s.includes("open_task_count") && s.includes("FROM"));
    expect(hits.length).toBeGreaterThan(0);
    return hits[0];
  }

  // EXECUTED, not read. The fixture holds one open deal and three closed ones, and every one of them has
  // zero open tasks -- i.e. all four satisfy the `open_task_count = 0` disconnect predicate. So the counts
  // this query returns are exactly the discriminator: 1 if closed deals are excluded, 4 if they are not.
  it("counts only the open deal, though all four look like follow-through gaps", async () => {
    const sql = (await captureDigestBaseSql()).replace(/\$\{schemaName\}/g, SCHEMA);
    const { rows } = await db.query<{ total_disconnects: number; follow_through_gaps: number }>(sql);
    expect(rows[0].total_disconnects).toBe(1);
    expect(rows[0].follow_through_gaps).toBe(1);
  });

  it("and the drain cannot inflate it: emptying a closed deal's tasks changes nothing", async () => {
    const sql = (await captureDigestBaseSql()).replace(/\$\{schemaName\}/g, SCHEMA);
    // Give the Won deal an open task, as the backlog did, then retire it exactly as the drain does.
    await db.query(
      `INSERT INTO ${SCHEMA}.tasks (id, deal_id, origin_rule, dedupe_key, status)
       VALUES ($1, $2, 'inbound_email_reply_needed', 'k1', 'pending')`,
      [U("f001"), U("d002")]
    );
    const before = await db.query<{ total_disconnects: number }>(sql);
    await db.query(`UPDATE ${SCHEMA}.tasks SET status = 'dismissed' WHERE id = $1`, [U("f001")]);
    const after = await db.query<{ total_disconnects: number }>(sql);

    // Without the gate the drain would have moved this from 1 to 2 -- the cleanup manufacturing a
    // disconnect, and emailing every director about it.
    expect(before.rows[0].total_disconnects).toBe(1);
    expect(after.rows[0].total_disconnects).toBe(1);
  });
});
