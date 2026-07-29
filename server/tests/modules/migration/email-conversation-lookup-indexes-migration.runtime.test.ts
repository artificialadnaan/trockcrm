import { readFileSync } from "fs";
import { resolve } from "path";
import { describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { emails, emailThreadBindings } from "@trock-crm/shared/schema";
import { tenantSchemaSql } from "../../helpers/tenant-schema-from-drizzle.js";

/**
 * Migration 0202 indexes the two conversation-id predicates the email thread reassign/unassign feature
 * drives: `emails.graph_conversation_id` (previously UNINDEXED — 4 SELECTs to open a thread, 6 SELECTs
 * + 1 UPDATE to detach one) and the mailbox-LESS `email_thread_bindings` lookup that
 * uq_email_thread_bindings_active_conversation cannot seek on because it is led by mailbox_account_id.
 *
 * Two things are pinned here, and the second is the one a string-shape test alone would miss:
 *   1. FILE SHAPE — both required blocks. A tenant migration carrying only the DO-loop (existing
 *      offices) or only the TENANT_SCHEMA block (new offices provisioned by
 *      server/src/modules/office/service.ts) is a latent bug, so their presence is asserted, not assumed.
 *   2. REAL BEHAVIOUR against PGlite — applied twice it is a no-op the second time, and it does not
 *      abort on a tenant that has `emails` but no `email_thread_bindings`. That combination is not
 *      hypothetical: migration 0028 creates email_thread_bindings only in a DO-loop over ALREADY
 *      EXISTING office_% schemas and ships no TENANT_SCHEMA block of its own, so an office provisioned
 *      today has emails (from 0001) and no bindings table. Without the to_regclass guard this migration
 *      would fail that office's provisioning outright.
 */
const migrationPath = resolve(
  import.meta.dirname,
  "../../../../migrations/0202_email_conversation_lookup_indexes.sql"
);

const EMAILS_IDX = "emails_graph_conversation_sent_at_idx";
const BINDINGS_IDX = "email_thread_bindings_active_conversation_idx";

const sql = readFileSync(migrationPath, "utf8");

/** The TENANT_SCHEMA section, extracted and rewritten exactly the way the office provisioner does it. */
function tenantBlockFor(schemaName: string): string {
  const startMarker = "-- TENANT_SCHEMA_START";
  const endMarker = "-- TENANT_SCHEMA_END";
  const startIdx = sql.indexOf(startMarker);
  const endIdx = sql.indexOf(endMarker);
  return sql
    .substring(startIdx + startMarker.length, endIdx)
    .trim()
    .replace(/office_dallas/g, schemaName);
}

/** The executable SQL with `--` comment lines stripped, for assertions that must not read the prose. */
function statementsOnly(text: string): string {
  return text
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("--"))
    .join("\n");
}

async function indexNamesIn(pg: PGlite, schemaName: string): Promise<string[]> {
  const { rows } = await pg.query<{ indexname: string }>(
    `SELECT indexname FROM pg_indexes WHERE schemaname = $1 AND indexname IN ($2, $3) ORDER BY indexname`,
    [schemaName, EMAILS_IDX, BINDINGS_IDX]
  );
  return rows.map((row) => row.indexname);
}

describe("migration 0202 — email conversation lookup indexes (file shape)", () => {
  it("carries BOTH the per-office DO loop and the TENANT_SCHEMA block", () => {
    // Existing offices.
    expect(sql).toContain("DO $tenant$");
    expect(sql).toContain("nspname LIKE 'office\\_%' ESCAPE '\\'");
    // New offices, cloned by server/src/modules/office/service.ts.
    expect(sql).toContain("-- TENANT_SCHEMA_START");
    expect(sql).toContain("-- TENANT_SCHEMA_END");
  });

  it("declares both indexes in BOTH blocks, so new offices are not left behind", () => {
    const doLoop = sql.slice(0, sql.indexOf("-- TENANT_SCHEMA_START"));
    const tenantBlock = tenantBlockFor("office_dallas");

    for (const block of [doLoop, tenantBlock]) {
      expect(block).toContain(EMAILS_IDX);
      expect(block).toContain(BINDINGS_IDX);
    }
  });

  it("makes emails partial on graph_conversation_id and keyed for the sent_at/id ordering", () => {
    // sent_at AND id: the thread reads order by `sent_at ASC, id ASC`, and sent_at ties are the normal
    // case (one row per mailbox, every copy carrying the sender's timestamp).
    expect(sql).toContain(
      "ON %I.emails (graph_conversation_id, sent_at, id) WHERE graph_conversation_id IS NOT NULL"
    );
  });

  it("makes the bindings index mailbox-LESS and non-unique, matching 0028's partial predicate", () => {
    expect(sql).toContain(
      "ON %I.email_thread_bindings (provider, provider_conversation_id) WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL"
    );
    // Several mailboxes may each hold an active binding for one conversation — a unique index here
    // would reject exactly the multi-mailbox threads the reassign feature exists to move.
    expect(sql).not.toMatch(new RegExp(`CREATE UNIQUE INDEX[^;]*${BINDINGS_IDX}`));
  });

  it("guards every table with to_regclass and stays non-CONCURRENT", () => {
    expect(sql).toContain("to_regclass(format('%I.emails', tenant_schema))");
    expect(sql).toContain("to_regclass(format('%I.email_thread_bindings', tenant_schema))");
    expect(sql).toContain("to_regclass('office_dallas.email_thread_bindings')");
    // CREATE INDEX CONCURRENTLY cannot run inside the DO/txn block the runner executes this file in.
    // Checked against the DDL only — the header comment discusses CONCURRENTLY by name.
    expect(statementsOnly(sql)).not.toContain("CONCURRENTLY");
  });
});

describe("migration 0202 — email conversation lookup indexes (applied to a real database)", () => {
  it("is idempotent, and skips tenants without email_thread_bindings instead of failing", async () => {
    const pg = new PGlite();
    try {
      // A normal tenant, and one that has emails but never got email_thread_bindings (the 0028 gap).
      await pg.exec(tenantSchemaSql("office_dallas", [emails, emailThreadBindings]));
      await pg.exec(tenantSchemaSql("office_atlanta", [emails]));

      await pg.exec(sql);
      const afterFirst = {
        dallas: await indexNamesIn(pg, "office_dallas"),
        atlanta: await indexNamesIn(pg, "office_atlanta"),
      };

      expect(afterFirst.dallas).toEqual([BINDINGS_IDX, EMAILS_IDX]);
      expect(afterFirst.atlanta).toEqual([EMAILS_IDX]);

      // Replayed — the runner re-runs a file whenever public._migrations was not stamped.
      await pg.exec(sql);
      expect(await indexNamesIn(pg, "office_dallas")).toEqual(afterFirst.dallas);
      expect(await indexNamesIn(pg, "office_atlanta")).toEqual(afterFirst.atlanta);
    } finally {
      await pg.close();
    }
  });

  it("provisions a NEW office through the TENANT_SCHEMA block, twice, without error", async () => {
    const pg = new PGlite();
    try {
      // Exactly what an office provisioned today looks like: emails from 0001, no bindings table.
      await pg.exec(tenantSchemaSql("office_newoffice", [emails]));
      await pg.exec(tenantBlockFor("office_newoffice"));
      await pg.exec(tenantBlockFor("office_newoffice"));
      expect(await indexNamesIn(pg, "office_newoffice")).toEqual([EMAILS_IDX]);

      // And once 0028's gap is closed, the same block indexes the bindings table too.
      await pg.exec(tenantSchemaSql("office_withbindings", [emails, emailThreadBindings]));
      await pg.exec(tenantBlockFor("office_withbindings"));
      await pg.exec(tenantBlockFor("office_withbindings"));
      expect(await indexNamesIn(pg, "office_withbindings")).toEqual([BINDINGS_IDX, EMAILS_IDX]);
    } finally {
      await pg.close();
    }
  });

  it("gives the mailbox-LESS binding lookup a seek the 0028 unique index cannot", async () => {
    const pg = new PGlite();
    try {
      await pg.exec(tenantSchemaSql("office_dallas", [emails, emailThreadBindings]));
      // The pre-existing index from 0028, so the planner has to CHOOSE between the two.
      await pg.exec(`
        CREATE UNIQUE INDEX uq_email_thread_bindings_active_conversation
          ON office_dallas.email_thread_bindings (mailbox_account_id, provider, provider_conversation_id)
          WHERE detached_at IS NULL AND provider_conversation_id IS NOT NULL;
      `);
      await pg.exec(`
        INSERT INTO office_dallas.email_thread_bindings
          (mailbox_account_id, provider, provider_conversation_id, deal_id, binding_source, confidence, detached_at)
        SELECT gen_random_uuid(), 'microsoft_graph', 'conv-' || (g % 800), gen_random_uuid(),
               'manual', 'high', CASE WHEN g % 2 = 0 THEN now() ELSE NULL END
        FROM generate_series(1, 4000) g;
      `);
      await pg.exec(sql);
      await pg.exec("ANALYZE office_dallas.email_thread_bindings;");

      const { rows } = await pg.query<{ "QUERY PLAN": string }>(`
        EXPLAIN SELECT deal_id FROM office_dallas.email_thread_bindings
        WHERE provider = 'microsoft_graph' AND provider_conversation_id = 'conv-42' AND detached_at IS NULL
      `);
      const plan = rows.map((row) => row["QUERY PLAN"]).join("\n");

      // The point of the new index: led by the columns this query actually filters on, so the planner
      // seeks rather than walking the whole unique index with the conditions applied as a filter.
      expect(plan).toContain(BINDINGS_IDX);
      expect(plan).not.toContain("uq_email_thread_bindings_active_conversation");
    } finally {
      await pg.close();
    }
  });
});
