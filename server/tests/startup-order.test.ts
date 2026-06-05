import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("API startup order", () => {
  it("binds the HTTP server before running blocking startup migrations", () => {
    const indexSource = fs.readFileSync(path.resolve("src/index.ts"), "utf8");

    const listenIndex = indexSource.indexOf("app.listen(");
    const startupMigrationIndex = indexSource.indexOf("ensureAuditLogPhase1Columns(pool)");

    expect(listenIndex).toBeGreaterThanOrEqual(0);
    expect(startupMigrationIndex).toBeGreaterThanOrEqual(0);
    expect(listenIndex).toBeLessThan(startupMigrationIndex);
  });
});
