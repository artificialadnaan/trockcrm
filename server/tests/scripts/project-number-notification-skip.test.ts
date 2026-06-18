import { describe, expect, it, vi } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import {
  applyProjectNumberEmailSkipSetting,
  shouldSkipProjectNumberEmail,
} from "../../../scripts/lib/project-number-notification.js";

describe("project number notification script skip helper", () => {
  it("recognizes truthy SKIP_PROJECT_NUMBER_EMAIL values", () => {
    expect(shouldSkipProjectNumberEmail({ SKIP_PROJECT_NUMBER_EMAIL: "true" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldSkipProjectNumberEmail({ SKIP_PROJECT_NUMBER_EMAIL: "1" } as NodeJS.ProcessEnv)).toBe(true);
    expect(shouldSkipProjectNumberEmail({ SKIP_PROJECT_NUMBER_EMAIL: "false" } as NodeJS.ProcessEnv)).toBe(false);
    expect(shouldSkipProjectNumberEmail({} as NodeJS.ProcessEnv)).toBe(false);
  });

  it("sets the transaction-local database flag only when requested", async () => {
    const client = { query: vi.fn().mockResolvedValue({ rows: [] }) };

    await applyProjectNumberEmailSkipSetting(client, { SKIP_PROJECT_NUMBER_EMAIL: "true" } as NodeJS.ProcessEnv);
    expect(client.query).toHaveBeenCalledWith("SELECT set_config('app.skip_project_number_email', 'true', true)");

    client.query.mockClear();
    await applyProjectNumberEmailSkipSetting(client, {} as NodeJS.ProcessEnv);
    expect(client.query).not.toHaveBeenCalled();
  });

  it("keeps the bid-board excluded bulk-create script opted out of notifications", () => {
    const script = fs.readFileSync(
      // Resolve relative to this test file (mirrors the import on line 8), not process.cwd() — the
      // gate runs vitest from the server/ workspace dir, where cwd-relative "scripts/..." misses the
      // repo-root scripts/ dir. From server/tests/scripts/, ../../../scripts is the repo root.
      path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../scripts/create-bidboard-excluded-real-projects.js"),
      "utf8"
    );

    expect(script).toContain("SELECT set_config('app.skip_project_number_email', 'true', true)");
    expect(script.indexOf("BEGIN")).toBeLessThan(script.indexOf("app.skip_project_number_email"));
    expect(script.indexOf("app.skip_project_number_email")).toBeLessThan(script.indexOf("created.push(await insertDeal"));
  });
});
