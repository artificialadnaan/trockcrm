import { describe, expect, it, vi } from "vitest";
import { updateCompany } from "../../../src/modules/companies/service.js";

describe("company generic update ownership guard", () => {
  it("rejects owner changes through the generic company patch path", async () => {
    const tenantDb = {
      update: vi.fn(),
    };

    await expect(
      updateCompany(tenantDb as never, "company-1", {
        ownerId: "rep-2",
      } as never)
    ).rejects.toMatchObject({ statusCode: 403 });

    expect(tenantDb.update).not.toHaveBeenCalled();
  });

  it("rejects malformed patch payloads with a controlled 4xx instead of throwing TypeError", async () => {
    const tenantDb = {
      update: vi.fn(),
    };

    await expect(updateCompany(tenantDb as never, "company-1", null as never)).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(updateCompany(tenantDb as never, "company-1", "not-an-object" as never)).rejects.toMatchObject({
      statusCode: 400,
    });

    await expect(updateCompany(tenantDb as never, "company-1", [] as never)).rejects.toMatchObject({
      statusCode: 400,
    });

    expect(tenantDb.update).not.toHaveBeenCalled();
  });
});
