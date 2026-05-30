import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

// Locks the safety-critical shape of the forward stage-history backstop (migration 0143).
// The trigger's runtime behaviour (exactly one row per path, "Created in", timestamps) is
// proven by the read-only post-deploy verification; this test prevents a future edit from
// silently dropping a property that would either duplicate rows, write to the wrong schema,
// or break a stage change.
const migrationSql = readFileSync(
  new URL("../../../../migrations/0143_reenable_forward_stage_history.sql", import.meta.url),
  "utf8",
);
const sql = migrationSql.toLowerCase();

describe("0143 forward stage-history backstop trigger", () => {
  it("re-creates the function and (re)attaches the trigger idempotently", () => {
    expect(sql).toContain("create or replace function public.record_stage_history()");
    expect(sql).toMatch(/drop trigger if exists stage_history_trigger on/);
    expect(sql).toMatch(/create trigger stage_history_trigger\s+after insert or update on/);
    expect(sql).toMatch(/execute function public\.record_stage_history\(\)/);
  });

  it("de-dupes against the app's explicit insert via the transaction-local skip flag", () => {
    expect(sql).toContain("current_setting('app.skip_stage_history_trigger', true)");
    // when the flag is set, the trigger returns without recording (no duplicate of the app row)
    expect(sql).toMatch(/app\.skip_stage_history_trigger[\s\S]*?=\s*'1'[\s\S]*?return new/);
  });

  it("records creation (from NULL) and genuine stage changes, but not no-op updates", () => {
    expect(sql).toContain("tg_op = 'insert'");
    // no-op guard: an UPDATE that did not change stage_id records nothing
    expect(sql).toContain("is not distinct from");
    // creation row carries a NULL from-stage ("Created in")
    expect(sql).toMatch(/values \(\$1, null, \$2/);
  });

  it("is schema-safe regardless of the caller's search_path (uses TG_TABLE_SCHEMA)", () => {
    expect(sql).toContain("tg_table_schema");
    expect(sql).toMatch(/format\(\s*'insert into %i\.deal_stage_history/);
  });

  it("never breaks a stage change: resolves an actor, skips if none, guards the insert", () => {
    // actor chain for the NOT NULL + FK changed_by column: session user -> assigned rep -> creator
    expect(sql).toContain("app.current_user_id");
    expect(sql).toContain("new.assigned_rep_id");
    expect(sql).toContain("new.created_by_user_id");
    // record only when an actor resolves; skip the row otherwise (never a NOT NULL violation)
    expect(sql).toMatch(/v_actor is not null/);
    // best-effort: history recording can never roll back the stage change that fired it
    expect(sql).toContain("exception when others then");
  });

  it("applies to existing offices (tenant loop) and future offices (provisioning block)", () => {
    expect(sql).toMatch(/like 'office\\_%'/); // DO-loop over existing office_* schemas
    expect(migrationSql).toContain("-- TENANT_SCHEMA_START");
    expect(migrationSql).toContain("-- TENANT_SCHEMA_END");
  });
});
