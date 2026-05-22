import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const repoRoot = path.resolve(import.meta.dirname, "../../..");

function readJson<T>(relativePath: string): T {
  const absolutePath = path.join(repoRoot, relativePath);
  return JSON.parse(readFileSync(absolutePath, "utf8")) as T;
}

function readText(relativePath: string): string {
  return readFileSync(path.join(repoRoot, relativePath), "utf8");
}

describe("build gate configuration", () => {
  it("runs the production build and a test-inclusive typecheck in the pre-merge gate", () => {
    const packageJson = readJson<{ scripts?: Record<string, string> }>("package.json");

    expect(packageJson.scripts?.["check:premerge"]).toContain("npm run build");
    expect(packageJson.scripts?.["check:premerge"]).toContain("npm run typecheck:tests:all");
    expect(packageJson.scripts?.["typecheck:tests:all"]).toContain("--workspaces");
    expect(packageJson.scripts?.["typecheck:tests"]).toBeUndefined();
  });

  it("runs the pre-merge gate on pull requests and merge queue groups", () => {
    const workflow = readText(".github/workflows/premerge-build-gate.yml");

    expect(workflow).toContain("pull_request:");
    expect(workflow).toContain("merge_group:");
    expect(workflow).toContain("npm run check:premerge");
    expect(workflow).toContain("node-version: 22");
  });

  it("uses build-specific tsconfig files that exclude colocated tests from shipped builds", () => {
    const sharedPackage = readJson<{ scripts?: Record<string, string> }>("shared/package.json");
    const serverPackage = readJson<{ scripts?: Record<string, string> }>("server/package.json");
    const workerPackage = readJson<{ scripts?: Record<string, string> }>("worker/package.json");
    const clientPackage = readJson<{ scripts?: Record<string, string> }>("client/package.json");
    const clientFieldPackage = readJson<{ scripts?: Record<string, string> }>(
      "client-field/package.json",
    );

    expect(sharedPackage.scripts?.build).toContain("tsconfig.build.json");
    expect(sharedPackage.scripts?.build).toContain("--clean");
    expect(serverPackage.scripts?.build).toContain("tsconfig.build.json");
    expect(serverPackage.scripts?.build).toContain("--clean");
    expect(workerPackage.scripts?.build).toContain("tsconfig.build.json");
    expect(workerPackage.scripts?.build).toContain("--clean");
    expect(clientPackage.scripts?.build).toContain("tsconfig.build.json");
    expect(clientPackage.scripts?.build).toContain("--clean");
    expect(clientFieldPackage.scripts?.build).toContain("tsconfig.build.json");
    expect(clientFieldPackage.scripts?.build).toContain("--clean");

    for (const configPath of [
      "shared/tsconfig.build.json",
      "server/tsconfig.build.json",
      "worker/tsconfig.build.json",
      "client/tsconfig.build.json",
      "client-field/tsconfig.build.json",
    ]) {
      const config = readJson<{ exclude?: string[] }>(configPath);

      expect(config.exclude).toEqual(
        expect.arrayContaining([
          "src/**/*.test.ts",
          "src/**/*.test.tsx",
          "src/**/*.spec.ts",
          "src/**/*.spec.tsx",
        ]),
      );
    }
  });

  it("points production build project references at shared's build tsconfig", () => {
    for (const configPath of ["server/tsconfig.build.json", "worker/tsconfig.build.json"]) {
      const config = readJson<{ references?: Array<{ path: string }> }>(configPath);

      expect(config.references).toContainEqual({ path: "../shared/tsconfig.build.json" });
      expect(config.references).not.toContainEqual({ path: "../shared" });
    }
  });
});
