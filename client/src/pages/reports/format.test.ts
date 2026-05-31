import { describe, expect, it } from "vitest";
import { usd, int, signed } from "./format";

// GREY-3: the shared report formatters must guard null/undefined so a newly-nullable field surfaces as an
// em dash ("—"), never the string "undefined". Locks the defense-in-depth so callers don't need `?? 0`.
describe("report formatters guard null/undefined", () => {
  it("usd formats numbers (incl. 0) and renders — for null/undefined", () => {
    expect(usd(2410000)).toBe("$2,410,000");
    expect(usd(0)).toBe("$0");
    expect(usd(null)).toBe("—");
    expect(usd(undefined)).toBe("—");
  });

  it("int formats with separators (incl. 0) and renders — for null/undefined", () => {
    expect(int(47)).toBe("47");
    expect(int(1234567)).toBe("1,234,567");
    expect(int(0)).toBe("0");
    expect(int(null)).toBe("—");
    expect(int(undefined)).toBe("—");
  });

  it("signed prefixes +, keeps -, leaves 0 unsigned, and renders — for null/undefined", () => {
    expect(signed(5)).toBe("+5");
    expect(signed(-3)).toBe("-3");
    expect(signed(0)).toBe("0");
    expect(signed(null)).toBe("—");
    expect(signed(undefined)).toBe("—");
  });
});
