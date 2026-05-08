import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

describe("properties linkedValue list/detail consistency", () => {
  it("keeps linkedValue aggregation in SQL instead of JS float math", () => {
    const serviceSource = readFileSync(
      resolve(process.cwd(), "src/modules/properties/service.ts"),
      "utf8"
    );

    expect(serviceSource).not.toContain("reduce((sum, deal)");
    expect(serviceSource.split("linkedValue: sql<string>`COALESCE(SUM(COALESCE").length - 1).toBeGreaterThanOrEqual(2);
    expect(serviceSource).toContain("linkedValueRows[0]?.linkedValue ?? \"0\"");
  });
});
