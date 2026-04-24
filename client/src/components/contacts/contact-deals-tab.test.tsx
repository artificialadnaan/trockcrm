import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

describe("ContactDealsTab", () => {
  it("routes the empty-state CTA to seeded deal creation", () => {
    const source = readFileSync(resolve(__dirname, "./contact-deals-tab.tsx"), "utf8");

    expect(source).toContain('navigate(`/deals/new?${params.toString()}`)');
    expect(source).not.toContain('navigate(`/leads/new?${params.toString()}`)');
  });
});
