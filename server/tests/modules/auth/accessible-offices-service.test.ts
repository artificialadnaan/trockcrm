import { beforeEach, describe, expect, it, vi } from "vitest";

const poolQueryMock = vi.hoisted(() => vi.fn());

vi.mock("../../../src/db.js", () => ({
  pool: {
    query: poolQueryMock,
  },
}));

import { getAccessibleOffices } from "../../../src/modules/auth/service.js";

describe("getAccessibleOffices", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns secondary offices even when the access row has no role override", async () => {
    poolQueryMock.mockResolvedValueOnce({
      rows: [
        { id: "office-1", name: "North Office", slug: "north" },
        { id: "office-2", name: "South Office", slug: "south" },
      ],
    });

    const offices = await getAccessibleOffices("director-1", "director", "office-1");

    expect(poolQueryMock).toHaveBeenCalledOnce();
    expect(String(poolQueryMock.mock.calls[0]?.[0])).toContain("FROM public.user_office_access");
    expect(String(poolQueryMock.mock.calls[0]?.[0])).not.toContain("role_override IN");
    expect(offices).toEqual([
      { id: "office-1", name: "North Office", slug: "north" },
      { id: "office-2", name: "South Office", slug: "south" },
    ]);
  });
});
