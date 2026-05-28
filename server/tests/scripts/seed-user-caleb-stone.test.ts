import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  assertNoExistingUser,
  assertUserRoleEnumHasRep,
  buildOfficeAccessInsert,
  buildUsersInsert,
  parseSeedCalebArgs,
  resolveCreatedByUserId,
  resolveProvisioningOffices,
  runSeedCalebStone,
  type ExistingUserRow,
  type OfficeRow,
  type OperatorRow,
  type QueryableClient,
} from "../../../scripts/seed-user-caleb-stone.js";

// Real Dallas office UUID the script hard-pins (an office id, not customer/rep PII). The
// happy-path fixtures must use it so the office-UUID startup check passes.
const DALLAS_ID = "802f4260-983b-4f4a-b538-9cc2c7740703";
const ATLANTA_ID = "11111111-1111-1111-1111-111111111111";
const DFW_ID = "22222222-2222-2222-2222-222222222222";

function officeFixtures(overrides: Partial<OfficeRow>[] = []): OfficeRow[] {
  const base: OfficeRow[] = [
    { id: DALLAS_ID, name: "Dallas Office", slug: "dallas", is_active: true },
    { id: ATLANTA_ID, name: "Atlanta", slug: "atlanta", is_active: true },
    { id: DFW_ID, name: "DFW Office", slug: "dfw", is_active: false },
  ];
  return overrides.length ? (overrides as OfficeRow[]) : base;
}

interface MockOpts {
  offices?: OfficeRow[];
  enumLabels?: string[];
  existingUser?: ExistingUserRow[];
  operators?: OperatorRow[];
  verifyRow?: Record<string, unknown>;
  emptyOfficeAccessReturning?: boolean;
}

function makeClient(opts: MockOpts = {}) {
  const offices = opts.offices ?? officeFixtures();
  const enumLabels = opts.enumLabels ?? ["admin", "director", "rep", "construction", "field_contractor"];
  const existingUser = opts.existingUser ?? [];
  const operators = opts.operators ?? [];
  const calls: Array<{ text: string; values?: unknown[] }> = [];

  const query = vi.fn(async (text: string, values?: unknown[]) => {
    calls.push({ text, values });
    if (text.includes("FROM public.offices")) return { rows: offices };
    if (text.includes("pg_enum")) return { rows: enumLabels.map((label) => ({ label })) };
    if (text.includes("WHERE lower(email) = lower($1)")) return { rows: existingUser };
    if (text.includes("ANY($1::text[]) AND is_active = true")) return { rows: operators };
    if (/INSERT INTO public\.users/.test(text)) {
      return { rows: [{ id: values?.[0], email: values?.[1], role: "rep", office_id: values?.[5] }] };
    }
    if (/INSERT INTO public\.user_office_access/.test(text)) {
      if (opts.emptyOfficeAccessReturning) return { rows: [] };
      return { rows: [{ id: "access-1", user_id: values?.[0], office_id: values?.[1], role_override: null }] };
    }
    if (text.includes("has_atlanta_access")) {
      return { rows: [opts.verifyRow ?? { id: values?.[0], has_atlanta_access: true, office_access_count: 1 }] };
    }
    return { rows: [] }; // BEGIN / COMMIT / ROLLBACK / anything else
  });

  return { client: { query } as QueryableClient, query, calls };
}

const silentLogger = () => ({ log: vi.fn(), warn: vi.fn(), error: vi.fn() });

function hasInsert(calls: Array<{ text: string }>): boolean {
  return calls.some((c) => /INSERT/i.test(c.text));
}
function hasBegin(calls: Array<{ text: string }>): boolean {
  return calls.some((c) => c.text.trim() === "BEGIN");
}
function touchesLocalAuth(calls: Array<{ text: string }>): boolean {
  return calls.some((c) => c.text.includes("user_local_auth"));
}

describe("seed-user-caleb-stone — arg parsing", () => {
  it("requires exactly one of --dry-run / --commit", () => {
    expect(parseSeedCalebArgs(["--dry-run"])).toEqual({ commit: false });
    expect(parseSeedCalebArgs(["--commit"])).toEqual({ commit: true });
    expect(() => parseSeedCalebArgs([])).toThrow(/Specify --dry-run/);
    expect(() => parseSeedCalebArgs(["--commit", "--dry-run"])).toThrow(/not both/);
    expect(() => parseSeedCalebArgs(["--bogus"])).toThrow(/Unknown argument/);
  });
});

describe("seed-user-caleb-stone — office resolution", () => {
  it("resolves Dallas (primary) and Atlanta (extra) on the happy path", () => {
    const { dallas, atlanta } = resolveProvisioningOffices(officeFixtures(), DALLAS_ID);
    expect(dallas.id).toBe(DALLAS_ID);
    expect(dallas.slug).toBe("dallas");
    expect(atlanta.id).toBe(ATLANTA_ID);
    expect(atlanta.slug).toBe("atlanta");
  });

  it("refuses when the Dallas UUID does not match the expected id", () => {
    const offices = officeFixtures([
      { id: "deadbeef-0000-0000-0000-000000000000", name: "Dallas Office", slug: "dallas", is_active: true },
      { id: ATLANTA_ID, name: "Atlanta", slug: "atlanta", is_active: true },
    ]);
    expect(() => resolveProvisioningOffices(offices, DALLAS_ID)).toThrow(/UUID mismatch/);
  });

  it("refuses when slug=dallas is inactive (the DFW trap)", () => {
    const offices = officeFixtures([
      { id: DALLAS_ID, name: "Dallas Office", slug: "dallas", is_active: false },
      { id: ATLANTA_ID, name: "Atlanta", slug: "atlanta", is_active: true },
    ]);
    expect(() => resolveProvisioningOffices(offices, DALLAS_ID)).toThrow(/not active/);
  });

  it("refuses when Atlanta is missing", () => {
    const offices = officeFixtures([
      { id: DALLAS_ID, name: "Dallas Office", slug: "dallas", is_active: true },
    ]);
    expect(() => resolveProvisioningOffices(offices, DALLAS_ID)).toThrow(/Atlanta office \(slug=atlanta\) not found/);
  });

  it("refuses when Atlanta is inactive", () => {
    const offices = officeFixtures([
      { id: DALLAS_ID, name: "Dallas Office", slug: "dallas", is_active: true },
      { id: ATLANTA_ID, name: "Atlanta", slug: "atlanta", is_active: false },
    ]);
    expect(() => resolveProvisioningOffices(offices, DALLAS_ID)).toThrow(/Atlanta office .* is not active/);
  });
});

describe("seed-user-caleb-stone — guards", () => {
  it("requires the user_role enum to include 'rep'", () => {
    expect(() => assertUserRoleEnumHasRep(["admin", "director", "rep"])).not.toThrow();
    expect(() => assertUserRoleEnumHasRep(["admin", "director"])).toThrow(/does not include 'rep'/);
  });

  it("refuses to overwrite an existing user", () => {
    expect(() => assertNoExistingUser([])).not.toThrow();
    expect(() =>
      assertNoExistingUser([
        {
          id: "existing-1",
          email: "someone@example.test",
          display_name: "Existing Placeholder",
          role: "rep",
          office_id: DALLAS_ID,
          is_active: true,
        },
      ])
    ).toThrow(/already exists/);
  });

  it("resolves created_by by operator priority, else null", () => {
    const rows: OperatorRow[] = [
      { id: "op-admin", email: "admin@trockgc.com", is_active: true },
      { id: "op-adnaan", email: "adnaan@trockgc.com", is_active: true },
    ];
    expect(resolveCreatedByUserId(rows)).toBe("op-adnaan"); // adnaan@ has higher priority
    expect(resolveCreatedByUserId([{ id: "x", email: "admin@trockgc.com", is_active: false }])).toBeNull();
    expect(resolveCreatedByUserId([])).toBeNull();
  });
});

describe("seed-user-caleb-stone — SQL builders", () => {
  it("builds a users INSERT pinned to role=rep, with email lowercased, that never touches user_local_auth", () => {
    const stmt = buildUsersInsert({
      userId: "u-1",
      email: "Mixed.Case@Example.TEST", // placeholder mixed-case to prove lowercasing
      displayName: "Placeholder Person",
      firstName: "Placeholder",
      lastName: "Person",
      dallasOfficeId: DALLAS_ID,
      createdByUserId: null,
    });
    expect(stmt.text).toContain("INSERT INTO public.users");
    expect(stmt.text).toContain("'rep'::user_role");
    expect(stmt.text).not.toContain("user_local_auth");
    expect(stmt.text).not.toContain("password");
    expect(stmt.values[1]).toBe("mixed.case@example.test");
    expect(stmt.values[5]).toBe(DALLAS_ID);
    expect(stmt.values[6]).toBeNull(); // created_by_user_id passthrough
  });

  it("builds a single Atlanta office-access INSERT and nothing else", () => {
    const stmt = buildOfficeAccessInsert({ userId: "u-1", atlantaOfficeId: ATLANTA_ID });
    expect(stmt.text).toContain("INSERT INTO public.user_office_access");
    expect(stmt.text).not.toContain("user_local_auth");
    expect(stmt.values).toEqual(["u-1", ATLANTA_ID]);
  });
});

describe("seed-user-caleb-stone — orchestrator", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it("dry-run performs ZERO writes (no INSERT, no BEGIN, no user_local_auth)", async () => {
    const { client, calls } = makeClient();
    const writeSnapshot = vi.fn();
    const result = await runSeedCalebStone({
      client,
      argv: ["--dry-run"],
      logger: silentLogger(),
      writeSnapshot,
    });

    expect(result.mode).toBe("DRY-RUN");
    expect(result.committed).toBe(false);
    expect(result.dallasOfficeId).toBe(DALLAS_ID);
    expect(result.atlantaOfficeId).toBe(ATLANTA_ID);
    expect(hasInsert(calls)).toBe(false);
    expect(hasBegin(calls)).toBe(false);
    expect(touchesLocalAuth(calls)).toBe(false);
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it("aborts on Dallas UUID mismatch without writing", async () => {
    const { client, calls } = makeClient({
      offices: officeFixtures([
        { id: "deadbeef-0000-0000-0000-000000000000", name: "Dallas Office", slug: "dallas", is_active: true },
        { id: ATLANTA_ID, name: "Atlanta", slug: "atlanta", is_active: true },
      ]),
    });
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot: vi.fn() })
    ).rejects.toThrow(/UUID mismatch/);
    expect(hasInsert(calls)).toBe(false);
    expect(hasBegin(calls)).toBe(false);
  });

  it("aborts when Atlanta is missing without writing", async () => {
    const { client, calls } = makeClient({
      offices: officeFixtures([{ id: DALLAS_ID, name: "Dallas Office", slug: "dallas", is_active: true }]),
    });
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot: vi.fn() })
    ).rejects.toThrow(/Atlanta/);
    expect(hasInsert(calls)).toBe(false);
    expect(hasBegin(calls)).toBe(false);
  });

  it("aborts when a cstone user already exists, without writing", async () => {
    const { client, calls } = makeClient({
      existingUser: [
        {
          id: "existing-1",
          email: "someone@example.test",
          display_name: "Existing Placeholder",
          role: "rep",
          office_id: DALLAS_ID,
          is_active: true,
        },
      ],
    });
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot: vi.fn() })
    ).rejects.toThrow(/already exists/);
    expect(hasInsert(calls)).toBe(false);
    expect(hasBegin(calls)).toBe(false);
  });

  it("aborts when the user_role enum lacks 'rep', without writing", async () => {
    const { client, calls } = makeClient({ enumLabels: ["admin", "director"] });
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot: vi.fn() })
    ).rejects.toThrow(/does not include 'rep'/);
    expect(hasInsert(calls)).toBe(false);
    expect(hasBegin(calls)).toBe(false);
  });

  it("commit path inserts users + Atlanta access, snapshots BEFORE commit, never touches user_local_auth", async () => {
    const { client, query, calls } = makeClient();
    const writeSnapshot = vi.fn();
    const result = await runSeedCalebStone({
      client,
      argv: ["--commit"],
      logger: silentLogger(),
      now: () => new Date("2026-05-28T12:00:00.000Z"),
      tmpDir: "/tmp/fake-tmp",
      writeSnapshot,
    });

    expect(result.committed).toBe(true);
    expect(result.snapshotPath).toContain("/tmp/fake-tmp/seed-user-cstone-");
    expect(touchesLocalAuth(calls)).toBe(false);

    const usersInsert = calls.find((c) => /INSERT INTO public\.users/.test(c.text));
    expect(usersInsert).toBeDefined();
    expect(usersInsert!.text).toContain("'rep'::user_role");
    expect(usersInsert!.values?.[1]).toBe("cstone@trockgc.com"); // lowercased target
    expect(usersInsert!.values?.[5]).toBe(DALLAS_ID);

    const accessInsert = calls.find((c) => /INSERT INTO public\.user_office_access/.test(c.text));
    expect(accessInsert).toBeDefined();
    expect(accessInsert!.values?.[1]).toBe(ATLANTA_ID);

    // snapshot must be written before COMMIT
    const commitCallIdx = calls.findIndex((c) => c.text.trim() === "COMMIT");
    expect(commitCallIdx).toBeGreaterThan(-1);
    const commitOrder = query.mock.invocationCallOrder[commitCallIdx]!;
    const snapshotOrder = writeSnapshot.mock.invocationCallOrder[0]!;
    expect(snapshotOrder).toBeLessThan(commitOrder);
  });

  it("rolls back (no COMMIT) when an INSERT returns no row", async () => {
    const { client, calls } = makeClient({ emptyOfficeAccessReturning: true });
    const writeSnapshot = vi.fn();
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot })
    ).rejects.toThrow(/did not return a row/i);

    expect(calls.some((c) => c.text.trim() === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.text.trim() === "COMMIT")).toBe(false);
    expect(writeSnapshot).not.toHaveBeenCalled();
  });

  it("rolls back (no COMMIT) when in-transaction verification finds no Atlanta access", async () => {
    const { client, calls } = makeClient({
      verifyRow: { id: "u", has_atlanta_access: false, office_access_count: 0 },
    });
    const writeSnapshot = vi.fn();
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot })
    ).rejects.toThrow(/verification failed/i);

    expect(calls.some((c) => c.text.trim() === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.text.trim() === "COMMIT")).toBe(false);
    expect(writeSnapshot).not.toHaveBeenCalled(); // verification aborts before the snapshot write
  });

  it("rolls back (no COMMIT) when the snapshot write fails", async () => {
    const { client, calls } = makeClient();
    const writeSnapshot = vi.fn(() => {
      throw new Error("disk full");
    });
    await expect(
      runSeedCalebStone({ client, argv: ["--commit"], logger: silentLogger(), writeSnapshot })
    ).rejects.toThrow(/disk full/);

    expect(calls.some((c) => c.text.trim() === "ROLLBACK")).toBe(true);
    expect(calls.some((c) => c.text.trim() === "COMMIT")).toBe(false);
  });
});
