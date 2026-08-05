// The OpenAPI spec is a READ SURFACE for the deal's scope title, and it drifted twice.
//
// `/api/docs` and every client generated from it are how an external caller learns a field exists. A
// field the runtime accepts but the spec omits reads to those callers as "not supported" — which is the
// same class of silent gap as a column written on one path and not another, just aimed at a different
// audience. It was missed on the Deal schema and the POST body in one round, and on the PATCH body in
// the next, so this stops relying on a reviewer noticing a third time.
//
// The rule is mechanical and derived from the property rather than from a list of sites: scope_title
// exists to complement `description`, so ANY deal write body that documents `description` must document
// `scopeTitle` too. A new deal endpoint added later inherits the check for free.
import { describe, expect, it } from "vitest";
import { DEAL_SCOPE_TITLE_MAX_LENGTH } from "@trock-crm/shared/types";
import { apiSpec } from "../../../src/api-spec.js";

type JsonObject = Record<string, unknown>;

function requestBodyProperties(operation: unknown): JsonObject | null {
  const schema = (operation as JsonObject | undefined)?.requestBody as JsonObject | undefined;
  const content = schema?.content as JsonObject | undefined;
  const json = content?.["application/json"] as JsonObject | undefined;
  const body = json?.schema as JsonObject | undefined;
  return (body?.properties as JsonObject | undefined) ?? null;
}

/** Every documented write operation under a /api/deals* path, as [label, properties]. */
function dealWriteBodies(): Array<[string, JsonObject]> {
  const paths = apiSpec.paths as Record<string, Record<string, unknown>>;
  const found: Array<[string, JsonObject]> = [];
  for (const [path, operations] of Object.entries(paths)) {
    if (!path.startsWith("/api/deals")) continue;
    for (const method of ["post", "put", "patch"] as const) {
      const properties = requestBodyProperties(operations[method]);
      if (properties) found.push([`${method.toUpperCase()} ${path}`, properties]);
    }
  }
  return found;
}

describe("OpenAPI spec — scopeTitle is documented wherever description is", () => {
  it("declares scopeTitle on the Deal response schema, capped and nullable", () => {
    const schemas = (apiSpec.components as JsonObject).schemas as Record<string, JsonObject>;
    const deal = schemas.Deal.properties as Record<string, JsonObject>;

    expect(deal.scopeTitle).toBeDefined();
    expect(deal.scopeTitle.type).toBe("string");
    expect(deal.scopeTitle.nullable).toBe(true);
    // The documented cap must be the SAME number the API enforces and the column stores. A spec that
    // advertises a wider field teaches integrators to send values the API will reject.
    expect(deal.scopeTitle.maxLength).toBe(DEAL_SCOPE_TITLE_MAX_LENGTH);
  });

  it("finds the deal write bodies it is meant to be checking", () => {
    // Guard against the check silently passing because the traversal matched nothing (a renamed path
    // prefix, a restructured requestBody). Both the create and the update body must be in the set.
    const labels = dealWriteBodies().map(([label]) => label);
    expect(labels).toContain("POST /api/deals");
    expect(labels).toContain("PATCH /api/deals/{id}");
  });

  it("documents scopeTitle in EVERY deal write body that documents description", () => {
    for (const [label, properties] of dealWriteBodies()) {
      if (!("description" in properties)) continue;
      expect(properties.scopeTitle, `${label} documents description but not scopeTitle`).toBeDefined();
      const scopeTitle = properties.scopeTitle as JsonObject;
      expect(scopeTitle.maxLength, `${label} scopeTitle cap`).toBe(DEAL_SCOPE_TITLE_MAX_LENGTH);
    }
  });

  it("tells a caller how the write is rejected, so a 400 is actionable rather than mysterious", () => {
    const paths = apiSpec.paths as Record<string, Record<string, JsonObject>>;
    for (const [path, method] of [
      ["/api/deals", "post"],
      ["/api/deals/{id}", "patch"],
    ] as const) {
      const responses = paths[path][method].responses as Record<string, JsonObject>;
      expect(String(responses["400"]?.description), `${method} ${path} 400`).toContain(
        "SCOPE_TITLE_INVALID"
      );
    }
  });
});
