import { beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({
  users: [
    {
      id: "user-1",
      email: "director@trock.dev",
      displayName: "James Director",
      role: "director",
      officeId: "office-atlanta",
      isActive: true,
    },
  ],
  offices: [
    {
      id: "office-dallas",
      slug: "dallas",
      name: "Dallas",
      isActive: true,
    },
  ],
}));

const schemaSentinels = vi.hoisted(() => ({
  offices: "offices",
  users: "users",
  userOfficeAccess: "user_office_access",
}));

vi.mock("@trock-crm/shared/schema", () => schemaSentinels);

vi.mock("../../../src/db.js", () => {
  const chainSelect = {
    from(table: unknown) {
      return {
        where(condition: any) {
          const queryText = JSON.stringify(condition);
          if (table === schemaSentinels.users) {
            const emailMatch = queryText.match(/director@trock\.dev/);
            const idMatch = queryText.match(/user-1|user-2/);
            const rows = state.users.filter((row) =>
              emailMatch ? row.email === "director@trock.dev" : idMatch ? queryText.includes(row.id) : true
            );
            return { limit: async () => rows.slice(0, 1) };
          }

          if (table === schemaSentinels.offices) {
            const rows = state.offices.filter((row) => queryText.includes("dallas") ? row.slug === "dallas" : true);
            return { limit: async () => rows.slice(0, 1) };
          }

          if (table === schemaSentinels.userOfficeAccess) {
            return { limit: async () => [] };
          }

          return { limit: async () => [] };
        },
      };
    },
  };

  return {
    db: {
      select: vi.fn(() => chainSelect),
      update: vi.fn(() => ({
        set(values: any) {
          return {
            where() {
              return {
                returning: async () => {
                  state.users = state.users.map((row) =>
                    row.id === "user-1" ? { ...row, officeId: values.officeId } : row
                  );
                  return [state.users.find((row) => row.id === "user-1")];
                },
              };
            },
          };
        },
      })),
    },
  };
});

describe("ensureDevUserPrimaryOffice", () => {
  beforeEach(() => {
    state.users = [
      {
        id: "user-1",
        email: "director@trock.dev",
        displayName: "James Director",
        role: "director",
        officeId: "office-atlanta",
        isActive: true,
      },
    ];
    state.offices = [
      {
        id: "office-dallas",
        slug: "dallas",
        name: "Dallas",
        isActive: true,
      },
    ];
  });

  it("moves dev users to the preferred demo office", async () => {
    const { ensureDevUserPrimaryOffice } = await import("../../../src/modules/auth/service.js");

    const updated = await ensureDevUserPrimaryOffice("user-1", "dallas");

    expect(updated?.officeId).toBe("office-dallas");
    expect(state.users[0]?.officeId).toBe("office-dallas");
  });

  it("leaves non-dev users unchanged", async () => {
    state.users = [
      {
        id: "user-2",
        email: "someone@example.com",
        displayName: "Real User",
        role: "director",
        officeId: "office-atlanta",
        isActive: true,
      },
    ];

    const { ensureDevUserPrimaryOffice } = await import("../../../src/modules/auth/service.js");
    const updated = await ensureDevUserPrimaryOffice("user-2", "dallas");

    expect(updated?.officeId).toBe("office-atlanta");
  });
});
