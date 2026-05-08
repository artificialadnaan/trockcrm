import { describe, expect, it, vi } from "vitest";

const connectMock = vi.hoisted(() => vi.fn());

vi.mock("../db.js", () => ({
  pool: {
    connect: connectMock,
  },
}));

import { runRepPerformanceRollup } from "./rep-performance-rollup.js";

describe("rep performance rollup stale account count", () => {
  it("computes stale_account_count from company/property last_activity_at using period_end and office scoping", async () => {
    const queries: string[] = [];
    const params: unknown[][] = [];
    const client = {
      query: vi.fn(async (sql: string, queryParams?: unknown[]) => {
        queries.push(sql);
        params.push(queryParams ?? []);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
    const insertParams = params[queries.findIndex((query) => query.includes("INSERT INTO public.rep_performance_snapshots"))];

    expect(insertSql).toContain("stale_accounts AS (");
    expect(insertSql).toContain("JOIN public.users account_rep");
    expect(insertSql).toContain("account_rep.office_id = $4");
    expect(insertSql).toContain("company' AS account_type");
    expect(insertSql).toContain("property' AS account_type");
    expect(insertSql).toContain("last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval");
    expect(insertSql).not.toContain("last_activity_at < NOW()");
    expect(insertSql).toContain("stale_account_count");
    expect(insertSql).toContain("COALESCE(sa.stale_account_count, 0)");
    expect(insertParams).toEqual(["mtd", "2026-05-01", "2026-05-07", "office-1", "North", 30]);
  });

  it("scopes deals join to period_end so future deals do not backfill past snapshots", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
    const staleCompanyBranch = /JOIN office_north\.companies c[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?UNION/.exec(
      insertSql ?? ""
    )?.[0];
    const stalePropertyBranch = /JOIN office_north\.properties p[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?\) accounts/.exec(
      insertSql ?? ""
    )?.[0];

    expect(staleCompanyBranch).toContain("AND d.created_at::date <= $3::date");
    expect(stalePropertyBranch).toContain("AND d.created_at::date <= $3::date");
  });

  it("stale_account_count includes accounts that were stale during the period regardless of current is_active", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
    const staleCompanyBranch = /JOIN office_north\.companies c[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?UNION/.exec(
      insertSql ?? ""
    )?.[0];
    const stalePropertyBranch = /JOIN office_north\.properties p[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?\) accounts/.exec(
      insertSql ?? ""
    )?.[0];

    expect(staleCompanyBranch).toContain("c.last_activity_at IS NOT NULL");
    expect(staleCompanyBranch).toContain(
      "c.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval"
    );
    expect(staleCompanyBranch).not.toContain("c.is_active = true");
    expect(stalePropertyBranch).toContain("p.last_activity_at IS NOT NULL");
    expect(stalePropertyBranch).toContain(
      "p.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval"
    );
    expect(stalePropertyBranch).not.toContain("p.is_active = true");
  });

  it("treats accounts with activity on the cutoff date evening as stale by end-of-day", async () => {
    const queries: string[] = [];
    const client = {
      query: vi.fn(async (sql: string) => {
        queries.push(sql);
        if (sql.includes("SELECT id, slug, name FROM public.offices")) {
          return { rows: [{ id: "office-1", slug: "north", name: "North" }], rowCount: 1 };
        }
        return { rows: [], rowCount: sql.includes("INSERT INTO public.rep_performance_snapshots") ? 1 : 0 };
      }),
      release: vi.fn(),
    };
    connectMock.mockResolvedValue(client);

    await runRepPerformanceRollup(new Date("2026-05-07T12:00:00.000Z"));

    const insertSql = queries.find((query) => query.includes("INSERT INTO public.rep_performance_snapshots"));
    const staleCompanyBranch = /JOIN office_north\.companies c[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?UNION/.exec(
      insertSql ?? ""
    )?.[0];
    const stalePropertyBranch = /JOIN office_north\.properties p[\s\S]*?WHERE d\.assigned_rep_id IS NOT NULL[\s\S]*?\) accounts/.exec(
      insertSql ?? ""
    )?.[0];

    expect(staleCompanyBranch).toContain(
      "c.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval"
    );
    expect(stalePropertyBranch).toContain(
      "p.last_activity_at < ($3::date + interval '1 day')::timestamptz - ($6::int || ' days')::interval"
    );
  });
});
