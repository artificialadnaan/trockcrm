import { PGlite } from "@electric-sql/pglite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  fetchOpenOrphans,
  parseReplayArgs,
  replayOrphans,
} from "../../src/scripts/replay-synchub-relay-orphans.js";
import type { SyncHubRelayResult } from "../../src/modules/synchub/procore-project-relay-service.js";

/**
 * Real-SQL guard for the orphan-replay backfill. Proves the ORCHESTRATION against PGlite:
 *  - resolution uses the FIXED relay predicate (findDealsByProjectNumber): project_number match,
 *    CO-child exclusion, ambiguity, no-match;
 *  - only exactly-one-match orphans are replayed (0/>1 skipped, left open — never a duplicate orphan);
 *  - dry-run writes NOTHING; --commit marks linked orphans resolved and is idempotent.
 * The actual linking is the relay's job (covered by the relay's own tests); here it is a recording stub.
 */

const OFFICE_ID = "00000000-0000-4000-8000-000000000001";

let db: PGlite;
const client = () =>
  ({ query: (sql: string, params?: unknown[]) => db.query(sql, params as any[]) }) as any;

function recordingRelay() {
  const calls: unknown[] = [];
  const fn = async (input: unknown, _deps: { client: unknown }): Promise<SyncHubRelayResult> => {
    calls.push(input);
    return { status: "linked", dealId: "linked-deal", officeId: OFFICE_ID };
  };
  return { fn, calls };
}

async function orphanStatuses(): Promise<Record<string, string>> {
  const { rows } = await db.query(
    "SELECT id, status FROM public.synchub_webhook_orphans ORDER BY id"
  );
  const out: Record<string, string> = {};
  for (const r of rows as any[]) out[String(r.id)] = String(r.status);
  return out;
}

beforeEach(async () => {
  db = new PGlite();
  await db.exec(`
    CREATE SCHEMA office_main;
    CREATE TABLE public.offices (
      id text PRIMARY KEY, slug text, is_active boolean NOT NULL DEFAULT true, created_at timestamptz DEFAULT now()
    );
    INSERT INTO public.offices (id, slug, is_active) VALUES ('${OFFICE_ID}', 'main', true);

    CREATE TABLE office_main.deals (
      id text PRIMARY KEY, name text, deal_number text, project_number text,
      procore_project_id bigint, is_change_order boolean NOT NULL DEFAULT false, is_active boolean NOT NULL DEFAULT true
    );
    INSERT INTO office_main.deals (id, name, deal_number, project_number, is_change_order, is_active) VALUES
      ('d-hubspot',  'Tides at Park Lane', 'HS-1',           'DFW-1-13126-af', false, true),
      ('d-collide-a','Collide via project','HS-2',           'DFW-2-00000-aa', false, true),
      ('d-collide-b','Collide via deal',   'DFW-2-00000-aa', NULL,             false, true),
      ('d-parent',   'Has change orders',  'HS-3',           'DFW-7-77777-pp', false, true),
      ('d-co-child', 'CO #1',              NULL,             'DFW-7-77777-pp', true,  true);

    CREATE TABLE public.synchub_webhook_orphans (
      id text PRIMARY KEY, project_number text, procore_portfolio_project_id text,
      project_name text, raw_payload jsonb, status text NOT NULL DEFAULT 'open',
      resolved_at timestamptz, received_at timestamptz DEFAULT now()
    );
  `);
  // Seed orphans: O1 resolvable (project_number), O2 no-match, O3 ambiguous, O4 CO-parent, O5 already resolved.
  const seed = (id: string, num: string, pid: string, status = "open") =>
    db.query(
      `INSERT INTO public.synchub_webhook_orphans (id, project_number, procore_portfolio_project_id, project_name, raw_payload, status)
       VALUES ($1,$2,$3,$4,$5::jsonb,$6)`,
      [id, num, pid, num, JSON.stringify({ eventType: "procore.project.created", procore: { portfolioProjectId: pid, projectNumber: num, companyId: "CO" } }), status]
    );
  await seed("o1", "DFW-1-13126-af", "111");
  await seed("o2", "ATL-1-99999-xx", "222");
  await seed("o3", "DFW-2-00000-aa", "333");
  await seed("o4", "DFW-7-77777-pp", "444");
  await seed("o5", "DFW-1-13126-af", "555", "resolved");
});

afterEach(async () => {
  await db?.close();
});

describe("replay-synchub-relay-orphans", () => {
  it("parses --commit / --dry-run and rejects both", () => {
    expect(parseReplayArgs(["node", "s"]).mode).toBe("dry-run");
    expect(parseReplayArgs(["node", "s", "--commit"]).mode).toBe("commit");
    expect(() => parseReplayArgs(["node", "s", "--commit", "--dry-run"]).mode).toThrow();
  });

  it("fetches only open orphans", async () => {
    const orphans = await fetchOpenOrphans(client());
    expect(orphans.map((o) => o.id).sort()).toEqual(["o1", "o2", "o3", "o4"]);
  });

  it("dry-run categorizes each orphan and writes nothing", async () => {
    const { fn, calls } = recordingRelay();
    const report = await replayOrphans(client(), { mode: "dry-run", relay: fn });

    expect(report.counts.would_link).toBe(2); // o1 (project_number) + o4 (CO parent, child excluded)
    expect(report.counts.skipped_no_match).toBe(1); // o2
    expect(report.counts.skipped_ambiguous).toBe(1); // o3
    expect(calls).toHaveLength(0); // dry-run never invokes the relay

    expect(await orphanStatuses()).toEqual({ o1: "open", o2: "open", o3: "open", o4: "open", o5: "resolved" });
  });

  it("commit replays only single-match orphans, marks them resolved, and leaves 0/>1 open", async () => {
    const { fn, calls } = recordingRelay();
    const report = await replayOrphans(client(), { mode: "commit", relay: fn });

    expect(report.counts.linked).toBe(2);
    expect(report.counts.skipped_no_match).toBe(1);
    expect(report.counts.skipped_ambiguous).toBe(1);
    // Relay invoked ONLY for the two single-match orphans (never for no-match / ambiguous).
    expect(calls).toHaveLength(2);
    const numbers = calls.map((c: any) => c.procore.projectNumber).sort();
    expect(numbers).toEqual(["DFW-1-13126-af", "DFW-7-77777-pp"]);

    expect(await orphanStatuses()).toEqual({ o1: "resolved", o2: "open", o3: "open", o4: "resolved", o5: "resolved" });
  });

  it("is idempotent — a second commit re-selects only the still-open orphans and links nothing", async () => {
    const first = recordingRelay();
    await replayOrphans(client(), { mode: "commit", relay: first.fn });

    const second = recordingRelay();
    const report = await replayOrphans(client(), { mode: "commit", relay: second.fn });

    expect(report.total).toBe(2); // only o2 + o3 remain open
    expect(report.counts.linked).toBe(0);
    expect(second.calls).toHaveLength(0);
    expect(report.counts.skipped_no_match).toBe(1);
    expect(report.counts.skipped_ambiguous).toBe(1);
  });
});
