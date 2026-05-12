import { describe, expect, it, vi } from "vitest";
import { notificationRecipientGroups } from "@trock-crm/shared/schema";
import { getNotificationRecipientGroup } from "../../../src/modules/leads/due-diligence-service";

interface MockState {
  group: { id: string; key: string; name: string; description: string } | null;
  insertedRow: unknown;
}

function buildMockTenantDb(initialState: MockState) {
  const state = { ...initialState };
  let selectedTable: unknown = null;

  function selectChain() {
    const chain: Record<string, unknown> = {
      from: vi.fn((table: unknown) => {
        selectedTable = table;
        return chain;
      }),
      innerJoin: vi.fn(() => chain),
      where: vi.fn(() => {
        if (selectedTable === notificationRecipientGroups) return chain;
        return Promise.resolve([]);
      }),
      limit: vi.fn(async () => {
        if (selectedTable === notificationRecipientGroups) {
          return state.group ? [state.group] : [];
        }
        return [];
      }),
    };
    return chain;
  }

  return {
    state,
    db: {
      select: vi.fn(() => selectChain()),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key: string; name: string; description: string }) => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (state.group) return [];
              state.group = {
                id: "newly-created-group-id",
                key: values.key,
                name: values.name,
                description: values.description,
              };
              state.insertedRow = { ...state.group };
              return [state.group];
            }),
          })),
        })),
      })),
    } as never,
  };
}

describe("getNotificationRecipientGroup lazy upsert", () => {
  it("returns the existing group when one is already present", async () => {
    const { db, state } = buildMockTenantDb({
      group: {
        id: "existing-group",
        key: "lead_due_diligence",
        name: "Lead Due Diligence",
        description: "Recipients",
      },
      insertedRow: null,
    });
    const result = await getNotificationRecipientGroup(db, "lead_due_diligence");
    expect(result.group.id).toBe("existing-group");
    expect(state.insertedRow).toBeNull();
  });

  it("lazy-creates the well-known lead_due_diligence group when it is missing in the DB", async () => {
    const { db, state } = buildMockTenantDb({ group: null, insertedRow: null });
    const result = await getNotificationRecipientGroup(db, "lead_due_diligence");
    expect(result.group.id).toBe("newly-created-group-id");
    expect(state.insertedRow).toMatchObject({
      key: "lead_due_diligence",
      name: "Lead Due Diligence",
    });
  });

  it("still throws 404 for unknown group keys (no auto-create for arbitrary names)", async () => {
    const { db } = buildMockTenantDb({ group: null, insertedRow: null });
    await expect(getNotificationRecipientGroup(db, "some_other_unknown_key")).rejects.toMatchObject({
      statusCode: 404,
    });
  });
});
