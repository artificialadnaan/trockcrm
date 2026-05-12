import { describe, expect, it } from "vitest";
import { sql } from "drizzle-orm";
import {
  buildOfficeExistsMatcher,
  buildOfficeMatcher,
  OFFICE_UUID_PATTERN,
  pickQueryValue,
} from "./office-filter.js";

const columns = {
  officeId: sql`o.id`,
  officeSlug: sql`o.slug`,
  officeName: sql`o.name`,
};

describe("buildOfficeMatcher", () => {
  it("returns null when value is undefined, empty, or 'all'", () => {
    expect(buildOfficeMatcher(undefined, columns)).toBeNull();
    expect(buildOfficeMatcher(null, columns)).toBeNull();
    expect(buildOfficeMatcher("", columns)).toBeNull();
    expect(buildOfficeMatcher("   ", columns)).toBeNull();
    expect(buildOfficeMatcher("all", columns)).toBeNull();
    expect(buildOfficeMatcher("ALL", columns)).toBeNull();
  });

  it("returns a SQL fragment with id, slug, name clauses when value present", () => {
    const result = buildOfficeMatcher("dallas", columns);
    expect(result).not.toBeNull();
    // drizzle SQL objects have queryChunks; serialize by reading them.
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("o.id");
    expect(serialized).toContain("o.slug");
    expect(serialized).toContain("o.name");
    // The value "dallas" appears as a parameter binding.
    expect(serialized).toContain("dallas");
  });

  it("includes dealOfficeCode clause when provided", () => {
    const result = buildOfficeMatcher("dallas", {
      ...columns,
      dealOfficeCode: sql`d.office_code`,
    });
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("d.office_code");
  });

  it("trims surrounding whitespace before matching", () => {
    const result = buildOfficeMatcher("  dallas  ", columns);
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("dallas");
    expect(serialized).not.toContain("  dallas  ");
  });
});

describe("buildOfficeExistsMatcher", () => {
  it("returns null for empty/all values", () => {
    expect(buildOfficeExistsMatcher(undefined)).toBeNull();
    expect(buildOfficeExistsMatcher("")).toBeNull();
    expect(buildOfficeExistsMatcher("all")).toBeNull();
  });

  it("returns an EXISTS SQL fragment when value present", () => {
    const result = buildOfficeExistsMatcher("dallas");
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    expect(serialized).toContain("offices office_scope");
    expect(serialized).toContain("u.office_id");
    expect(serialized).toContain("d.office_code");
  });

  it("emits a top-level d.office_code OR clause so legacy codes still match", () => {
    // A legacy office_code value that does not correspond to any offices row
    // (e.g. historical short codes) must still match deals carrying that code.
    // The fix wraps the EXISTS lookup in an OR with a direct d.office_code
    // match so the matcher does not require an offices-table hit first.
    const result = buildOfficeExistsMatcher("fwd-001");
    expect(result).not.toBeNull();
    const serialized = JSON.stringify(result);
    // The d.office_code direct equality must appear OUTSIDE the EXISTS subquery
    // — easiest proxy: it should appear before the first `EXISTS` token.
    const existsIndex = serialized.indexOf("EXISTS");
    const directIndex = serialized.indexOf("d.office_code");
    expect(directIndex).toBeGreaterThan(-1);
    expect(directIndex).toBeLessThan(existsIndex);
  });
});

describe("pickQueryValue", () => {
  it("returns the first non-empty trimmed string", () => {
    expect(pickQueryValue(undefined, "", "hello", "world")).toBe("hello");
  });

  it("skips empty and whitespace-only strings", () => {
    expect(pickQueryValue("", "   ", "value")).toBe("value");
  });

  it("returns undefined when no candidate is present", () => {
    expect(pickQueryValue(undefined, "", "   ")).toBeUndefined();
    expect(pickQueryValue()).toBeUndefined();
  });

  it("flattens array candidates and skips empty entries", () => {
    expect(pickQueryValue(["", " "], ["", "found"])).toBe("found");
  });

  it("trims the returned value", () => {
    expect(pickQueryValue("   spaced   ")).toBe("spaced");
  });

  it("skips object values (e.g. Express ParsedQs nested objects) without throwing", () => {
    // Express ParsedQs can produce { [key]: object } for repeated params like `?a[b]=c`
    expect(pickQueryValue({ nested: "object" }, "fallback")).toBe("fallback");
    expect(pickQueryValue({ nested: "object" })).toBeUndefined();
  });
});

describe("OFFICE_UUID_PATTERN", () => {
  it("matches canonical UUIDs", () => {
    expect(OFFICE_UUID_PATTERN.test("11111111-2222-3333-4444-555555555555")).toBe(true);
  });

  it("rejects non-UUID strings", () => {
    expect(OFFICE_UUID_PATTERN.test("dallas")).toBe(false);
    expect(OFFICE_UUID_PATTERN.test("not-a-uuid")).toBe(false);
  });
});
