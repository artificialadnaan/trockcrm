import { afterAll, describe, expect, it, vi } from "vitest";

vi.stubEnv("RESEND_API_KEY", "");

const { sendSystemEmail } = await import("../../src/lib/resend-client.js");

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("required email transport", () => {
  it("fails closed when a credential email cannot be delivered", async () => {
    const errorSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);

    await expect(sendSystemEmail(
      "field@example.com",
      "Reset password",
      "<p>Reset link</p>",
      { requireConfiguredTransport: true },
    )).resolves.toBe(false);

    expect(errorSpy).toHaveBeenCalledWith("[Email] Required email transport is not configured");
    errorSpy.mockRestore();
  });
});
