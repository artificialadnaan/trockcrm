import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ROOT = resolve(__dirname, "../../..");

const SOURCE_FILES = [
  "src/modules/activities/routes.ts",
  "src/modules/ai-copilot/routes.ts",
  "src/modules/deals/routes.ts",
  "src/modules/tasks/routes.ts",
  "src/modules/tasks/service.ts",
];

describe("copilot requestedBy enqueue audit", () => {
  it("keeps requestedBy on every ai_refresh_copilot enqueue site", () => {
    for (const relativePath of SOURCE_FILES) {
      const contents = readFileSync(resolve(SERVER_ROOT, relativePath), "utf8");
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
