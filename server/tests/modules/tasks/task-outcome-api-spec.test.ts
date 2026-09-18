import { describe, expect, it } from "vitest";
import { apiSpec } from "../../../src/api-spec.js";

type JsonObject = Record<string, unknown>;

function requestBodySchema(path: string): JsonObject {
  const paths = apiSpec.paths as Record<string, Record<string, JsonObject>>;
  const operation = paths[path]?.post;
  const requestBody = operation?.requestBody as JsonObject | undefined;
  const content = requestBody?.content as JsonObject | undefined;
  const json = content?.["application/json"] as JsonObject | undefined;
  return json?.schema as JsonObject;
}

function resolutionNoteSchemas(): Array<[string, JsonObject]> {
  const transition = requestBodySchema("/api/tasks/{id}/transition");
  const terminalTransition = ((transition.oneOf as JsonObject[]) ?? []).find((branch) => {
    const properties = branch.properties as JsonObject | undefined;
    const status = properties?.nextStatus as JsonObject | undefined;
    return (status?.enum as unknown[] | undefined)?.includes("completed");
  });

  return [
    ["terminal transition", (terminalTransition?.properties as JsonObject).resolutionNote as JsonObject],
    ["complete", (requestBodySchema("/api/tasks/{id}/complete").properties as JsonObject).resolutionNote as JsonObject],
    ["dismiss", (requestBodySchema("/api/tasks/{id}/dismiss").properties as JsonObject).resolutionNote as JsonObject],
  ];
}

describe("OpenAPI spec — task outcomes", () => {
  it("documents the same nonblank, capped explanation rule that the task service enforces", () => {
    for (const [label, resolutionNote] of resolutionNoteSchemas()) {
      expect(resolutionNote, `${label} resolutionNote schema`).toMatchObject({
        type: "string",
        minLength: 1,
        maxLength: 2000,
        pattern: "\\S",
      });
    }
  });
});
