import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const SOURCE_FILES = [
  "server/src/modules/activities/routes.ts",
  "server/src/modules/ai-copilot/routes.ts",
  "server/src/modules/deals/routes.ts",
  "server/src/modules/tasks/routes.ts",
  "server/src/modules/tasks/service.ts",
];

describe("copilot requestedBy enqueue audit", () => {
  it("keeps requestedBy on every ai_refresh_copilot enqueue site", () => {
    for (const relativePath of SOURCE_FILES) {
      const contents = readFileSync(resolve(process.cwd(), relativePath), "utf8");
      const enqueueBlocks = contents
        .split('jobType: "ai_refresh_copilot"')
        .slice(1)
        .map((segment) => segment.slice(0, 260));

      expect(enqueueBlocks.length, `${relativePath} should contain at least one ai_refresh_copilot enqueue`).toBeGreaterThan(0);
      for (const block of enqueueBlocks) {
        expect(block, `${relativePath} is missing requestedBy on an ai_refresh_copilot enqueue`).toContain(
          "requestedBy"
        );
      }
    }
  });
});
