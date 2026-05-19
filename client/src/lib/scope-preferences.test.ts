// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  readStoredScopePreference,
  resolvePreferredScope,
  writeStoredScopePreference,
} from "./scope-preferences";

describe("scope-preferences", () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    window.localStorage.clear();
  });

  it("defaults to mine when neither URL nor storage has a scope", () => {
    expect(resolvePreferredScope({ requestedScope: null, userId: "user-1" })).toBe("mine");
  });

  it("uses the persisted scope when the URL is silent", () => {
    writeStoredScopePreference("user-1", "all");
    expect(resolvePreferredScope({ requestedScope: null, userId: "user-1" })).toBe("all");
    expect(readStoredScopePreference("user-1")).toBe("all");
  });

  it("lets the URL override the persisted scope", () => {
    writeStoredScopePreference("user-1", "all");
    expect(resolvePreferredScope({ requestedScope: "mine", userId: "user-1" })).toBe("mine");
  });

  it("ignores invalid stored values", () => {
    window.localStorage.setItem("pipeline-scope-preference:user-1", "bogus");
    expect(resolvePreferredScope({ requestedScope: null, userId: "user-1" })).toBe("mine");
  });
});
