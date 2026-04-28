import { describe, expect, it } from "vitest";
import { toJsonSafe } from "../../src/lib/json-safe.js";

describe("toJsonSafe", () => {
  it("serializes deal payloads with bigint values instead of throwing", () => {
    const payload = {
      deal: {
        id: "crm-originated",
        procoreProjectId: 9007199254740993n,
        sourceLeadId: "lead-1",
      },
    };

    expect(() => JSON.stringify(payload)).toThrow(TypeError);
    expect(toJsonSafe(payload)).toEqual({
      deal: {
        id: "crm-originated",
        procoreProjectId: "9007199254740993",
        sourceLeadId: "lead-1",
      },
    });
  });
});
