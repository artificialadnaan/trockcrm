import { describe, it, expect } from "vitest";
import { isDemoSessionResponse } from "./demo-session";

const res = (ok: boolean, json: () => Promise<unknown>) => ({ ok, json });

describe("isDemoSessionResponse", () => {
  it("true only for a 200 with { authenticated: true }", async () => {
    expect(await isDemoSessionResponse(res(true, async () => ({ authenticated: true })))).toBe(true);
  });

  it("false for a 200 SPA-shell HTML response (json() throws) — the CRM cross-service case", async () => {
    expect(
      await isDemoSessionResponse(
        res(true, async () => {
          throw new SyntaxError("Unexpected token < in JSON");
        })
      )
    ).toBe(false);
  });

  it("false for a 200 whose JSON lacks authenticated:true", async () => {
    expect(await isDemoSessionResponse(res(true, async () => ({ authenticated: false })))).toBe(false);
    expect(await isDemoSessionResponse(res(true, async () => ({})))).toBe(false);
  });

  it("false for a non-200 even if the body says authenticated:true", async () => {
    expect(await isDemoSessionResponse(res(false, async () => ({ authenticated: true })))).toBe(false);
  });
});
