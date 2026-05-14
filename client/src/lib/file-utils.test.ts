import { describe, expect, it } from "vitest";
import { getMimeIconType, isAllowedExtension, isAllowedMimeType, validateFileForUpload } from "./file-utils";

describe("file upload utility validation", () => {
  it("accepts downloaded email files for lead and deal file uploads", () => {
    expect(isAllowedMimeType("message/rfc822")).toBe(true);
    expect(isAllowedMimeType("application/vnd.ms-outlook")).toBe(true);
    expect(isAllowedExtension("customer-scope.eml")).toBe(true);
    expect(isAllowedExtension("outlook-message.msg")).toBe(true);

    expect(validateFileForUpload(new File(["From: test@example.com\n\nBody"], "customer-scope.eml", { type: "message/rfc822" }))).toBeNull();
    expect(validateFileForUpload(new File(["msg"], "outlook-message.msg", { type: "application/vnd.ms-outlook" }))).toBeNull();
    expect(getMimeIconType("message/rfc822")).toBe("email");
    expect(getMimeIconType("application/vnd.ms-outlook")).toBe("email");
  });
});
