import { describe, expect, it } from "vitest";
import { importExternalUsers } from "../../../src/modules/admin/user-import-service.js";

function createDependencies() {
  const users = new Map<string, any>();
  const identities: Array<Record<string, any>> = [];
  let nextId = 1;

  return {
    users,
    identities,
    dependencies: {
      async getOfficeBySlug(slug: string) {
        if (slug !== "dallas") return null;
        return { id: "office-dallas", slug: "dallas", isActive: true };
      },
      async getUserByEmail(email: string) {
        return users.get(email) ?? null;
      },
      async createUser(input: {
        email: string;
        displayName: string;
        officeId: string;
        role: "rep";
      }) {
        const user = {
          id: `user-${nextId++}`,
          email: input.email,
          displayName: input.displayName,
          officeId: input.officeId,
          role: input.role,
          isActive: true,
        };
        users.set(user.email, user);
        return user;
      },
      async upsertExternalIdentity(input: Record<string, any>) {
        identities.push(input);
      },
    },
  };
}

describe("importExternalUsers", () => {
  it("creates new Dallas rep users from the union of HubSpot and Procore", async () => {
    const state = createDependencies();

    const result = await importExternalUsers({
      dependencies: state.dependencies,
      fetchHubspotOwners: async () => [
        {
          id: "hs-1",
          email: "rep1@example.com",
          firstName: "Rep",
          lastName: "One",
        },
      ],
      fetchProcoreUsers: async () => [
        {
          id: 44,
          email_address: "rep2@example.com",
          name: "Rep Two",
        },
      ],
    });

    expect(result.createdCount).toBe(2);
    expect(result.matchedExistingCount).toBe(0);
    expect(result.scannedCount).toBe(2);
    expect([...state.users.values()].map((user) => user.role)).toEqual([
      "rep",
      "rep",
    ]);
    expect([...state.users.values()].map((user) => user.officeId)).toEqual([
      "office-dallas",
      "office-dallas",
    ]);
  });

  it("preserves role and office for existing CRM users matched by email", async () => {
    const state = createDependencies();
    state.users.set("director@example.com", {
      id: "existing-1",
      email: "director@example.com",
      displayName: "Existing Director",
      role: "director",
      officeId: "office-houston",
      isActive: true,
    });

    const result = await importExternalUsers({
      dependencies: state.dependencies,
      fetchHubspotOwners: async () => [
        {
          id: "hs-2",
          email: "director@example.com",
          firstName: "Updated",
          lastName: "Name",
        },
      ],
      fetchProcoreUsers: async () => [],
    });

    expect(result.createdCount).toBe(0);
    expect(result.matchedExistingCount).toBe(1);
    expect(state.users.get("director@example.com")).toMatchObject({
      role: "director",
      officeId: "office-houston",
    });
    expect(state.identities).toHaveLength(1);
    expect(state.identities[0]).toMatchObject({
      userId: "existing-1",
      sourceSystem: "hubspot",
      externalUserId: "hs-2",
    });
  });

  it("collapses duplicate emails across both systems into one CRM user", async () => {
    const state = createDependencies();

    const result = await importExternalUsers({
      dependencies: state.dependencies,
      fetchHubspotOwners: async () => [
        {
          id: "hs-3",
          email: "shared@example.com",
          firstName: "Shared",
          lastName: "Person",
        },
      ],
      fetchProcoreUsers: async () => [
        {
          id: 99,
          email_address: "shared@example.com",
          name: "Shared Person",
        },
      ],
    });

    expect(result.scannedCount).toBe(1);
    expect(result.createdCount).toBe(1);
    expect(state.identities).toHaveLength(2);
  });
});
