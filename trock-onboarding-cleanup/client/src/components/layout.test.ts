import { describe, expect, it } from "vitest";
import { mainCrmPasswordChangeUrl } from "./layout";

describe("mainCrmPasswordChangeUrl", () => {
  it("sends users with pending password changes back to the main CRM", () => {
    expect(mainCrmPasswordChangeUrl()).toBe("https://trockcrm.com");
  });
});
