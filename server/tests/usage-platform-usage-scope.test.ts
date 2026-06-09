import { describe, expect, it } from "vitest";
import { resolveRepScope } from "../src/modules/usage/read-service.js";

describe("platform-usage endpoint scoping", () => {
  it("a rep can never widen scope to another rep via the query param", () => {
    expect(resolveRepScope({ role: "rep", userId: "rep-1" }, "rep-2")).toEqual(["rep-1"]);
  });
});
