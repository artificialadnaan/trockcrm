import { describe, expect, it, vi } from "vitest";
import {
  buildContactHasLinkedActiveDealSql,
  getContacts,
} from "../../../src/modules/contacts/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

// Flatten a Drizzle SQL/`and(...)` object to a single text blob so we can assert the column references,
// the EXISTS/JOIN shape, and the bound param VALUES (Drizzle wraps plain JS values as Param objects with
// a `.value` field — so a role enum or a search term surfaces here as text).
function flattenSqlChunks(value: unknown): string {
  const chunks = (value as { queryChunks?: unknown[] }).queryChunks ?? [];
  return chunks
    .map((chunk) => {
      if (typeof chunk === "string") return chunk;
      if (chunk && typeof chunk === "object" && "value" in chunk) {
        return String((chunk as { value: unknown }).value);
      }
      if (chunk && typeof chunk === "object" && "queryChunks" in chunk) {
        return flattenSqlChunks(chunk);
      }
      return String(chunk);
    })
    .join(" ");
}

// Chainable, awaitable mock of the tenant Drizzle handle. Every method returns the same chain so the
// builder pattern works; awaiting it yields []. We record each `.where()`/`.orderBy()` argument so the
// composed WHERE + ORDER BY can be asserted without a database.
function makeCaptureDb() {
  const whereCalls: unknown[] = [];
  const orderByCalls: unknown[][] = [];
  const chain: any = {
    select: () => chain,
    from: () => chain,
    leftJoin: () => chain,
    innerJoin: () => chain,
    where: (cond: unknown) => {
      whereCalls.push(cond);
      return chain;
    },
    orderBy: (...args: unknown[]) => {
      orderByCalls.push(args);
      return chain;
    },
    limit: () => chain,
    offset: () => chain,
    then: (resolve: (rows: unknown[]) => unknown) => resolve([]),
  };
  return { db: chain, whereCalls, orderByCalls };
}

describe("buildContactHasLinkedActiveDealSql", () => {
  it("is an EXISTS over contact_deal_associations INNER JOIN deals, gated on the deal being active", () => {
    const sqlText = flattenSqlChunks(buildContactHasLinkedActiveDealSql());

    expect(sqlText).toContain("EXISTS");
    expect(sqlText).toContain("contact_deal_associations");
    expect(sqlText).toContain("INNER JOIN deals");
    expect(sqlText).toContain("d.is_active = true");
    // correlated to the outer contact row
    expect(sqlText).toContain('"contacts"."id"');
  });
});

describe("getContacts WHERE composition", () => {
  it("AND-composes linked-deals + role + search into the list WHERE (over the full set before LIMIT)", async () => {
    const { db, whereCalls, orderByCalls } = makeCaptureDb();

    await getContacts(db, {
      hasLinkedDeals: true,
      role: "project_manager",
      search: "acme",
      sortBy: "last_touch_at",
      sortDir: "desc",
    });

    // getContacts issues: cardCounts WHERE, countResult WHERE, then the row-query WHERE. The row-query
    // WHERE is the last one captured and carries the full composed predicate.
    const listWhere = flattenSqlChunks(whereCalls[whereCalls.length - 1]);

    // linked-deals filter present
    expect(listWhere).toContain("contact_deal_associations");
    expect(listWhere).toContain("INNER JOIN deals");
    expect(listWhere).toContain("d.is_active = true");
    // role filter (the enum value is a bound param value, surfaced by the flattener)
    expect(listWhere).toContain("project_manager");
    // search filter (the term is a bound param value inside the unified ILIKE search)
    expect(listWhere).toContain("acme");

    // The last_touch_at sort STILL emits the GREATEST expression DESC NULLS LAST, plus the id tiebreak.
    const orderArgs = orderByCalls[orderByCalls.length - 1];
    const orderText = orderArgs.map(flattenSqlChunks).join(" | ");
    expect(orderText).toContain("GREATEST");
    expect(orderText).toContain("DESC NULLS LAST");
    // A stable ascending tiebreak (asc(contacts.id)) is appended as a SECOND ORDER BY arg so OFFSET
    // pagination is deterministic when last_touch_at ties. (The Column object flattens to "[object
    // Object]", so we assert the ASC direction of the dedicated second arg rather than the column name.)
    expect(orderArgs.length).toBe(2);
    expect(flattenSqlChunks(orderArgs[1]).toLowerCase()).toContain("asc");
  });

  it("omits the linked-deals EXISTS from the WHERE when the filter is not set", async () => {
    const { db, whereCalls } = makeCaptureDb();

    await getContacts(db, { role: "owner_principal" });

    // The linked-deals COUNT subquery lives in the SELECT, never the WHERE, so an unfiltered list must not
    // carry the contact_deal_associations + active-deal predicate in any captured WHERE.
    for (const w of whereCalls) {
      expect(flattenSqlChunks(w)).not.toContain("INNER JOIN deals");
    }
  });
});
