import { describe, expect, it, vi } from "vitest";
import { notificationRecipientGroups, users } from "@trock-crm/shared/schema";
import { NOTIFICATION_RECIPIENT_GROUPS } from "@trock-crm/shared/types";
import {
  getNotificationRecipientGroup,
  getNotificationRecipients,
} from "../../../src/modules/leads/due-diligence-service";

/**
 * The recipient-group machinery was written for exactly one group and then reused for a second and a
 * third, which is when both of its single-key assumptions became defects:
 *
 *   • the admin/director fallback was gated on `key !== "lead_due_diligence"`, so a new key returned an
 *     EMPTY recipient list and the caller mailed nobody — no throw, no log, no bounce;
 *   • the well-known registry was a one-entry record, so any other key 404'd out of the admin page and
 *     could never be assigned in the first place.
 *
 * These cover the key-agnostic shape: the fallback is a per-key option and the registry is a list.
 */

interface Person {
  id: string;
  email: string;
  displayName: string;
  role: string;
  isActive?: boolean;
}

function buildTenantDb(options: {
  group?: { id: string; key: string; name: string; description: string } | null;
  assignedUserIds?: string[];
  people?: Person[];
}) {
  const state = {
    group: options.group ?? null,
    assignedUserIds: options.assignedUserIds ?? [],
    people: options.people ?? [],
    insertedRow: null as unknown,
  };

  const toRecipient = (person: Person) => ({
    userId: person.id,
    email: person.email,
    displayName: person.displayName,
  });

  return {
    state,
    db: {
      select: vi.fn((fields?: Record<string, unknown>) => {
        let selectedTable: unknown = null;
        const chain: Record<string, unknown> = {
          from: vi.fn((table: unknown) => {
            selectedTable = table;
            return chain;
          }),
          innerJoin: vi.fn(() => chain),
          where: vi.fn(() => {
            // The assignment read joins groups → assignments → users; the fallback reads users directly.
            if (selectedTable === notificationRecipientGroups && fields && "email" in fields) {
              return Promise.resolve(
                state.people
                  .filter((person) => state.assignedUserIds.includes(person.id) && person.isActive !== false)
                  .map(toRecipient),
              );
            }
            if (selectedTable === users) {
              return Promise.resolve(
                state.people
                  .filter((person) => ["admin", "director"].includes(person.role) && person.isActive !== false)
                  .map(toRecipient),
              );
            }
            return chain;
          }),
          limit: vi.fn(async () => (selectedTable === notificationRecipientGroups && state.group ? [state.group] : [])),
        };
        return chain;
      }),
      insert: vi.fn(() => ({
        values: vi.fn((values: { key: string; name: string; description: string }) => ({
          onConflictDoNothing: vi.fn(() => ({
            returning: vi.fn(async () => {
              if (state.group) return [];
              state.group = { id: `created-${values.key}`, ...values };
              state.insertedRow = { ...state.group };
              return [state.group];
            }),
          })),
        })),
      })),
    } as never,
  };
}

const PEOPLE: Person[] = [
  { id: "admin-1", email: "admin@example.com", displayName: "Admin", role: "admin" },
  { id: "director-1", email: "director@example.com", displayName: "Director", role: "director" },
  { id: "rep-1", email: "rep@example.com", displayName: "Rep", role: "rep" },
  { id: "inactive-admin", email: "inactive@example.com", displayName: "Inactive", role: "admin", isActive: false },
];

describe("getNotificationRecipients", () => {
  it("returns the assigned recipients for any key", async () => {
    const { db } = buildTenantDb({ assignedUserIds: ["rep-1"], people: PEOPLE });

    await expect(getNotificationRecipients(db, "bid_due_date_report")).resolves.toEqual([
      { userId: "rep-1", email: "rep@example.com", displayName: "Rep" },
    ]);
  });

  it("falls back to active admins and directors for ANY key that opts in, not just lead_due_diligence", async () => {
    const { db } = buildTenantDb({ assignedUserIds: [], people: PEOPLE });

    await expect(
      getNotificationRecipients(db, "bid_due_date_report", { fallbackToAdminsAndDirectors: true }),
    ).resolves.toEqual([
      { userId: "admin-1", email: "admin@example.com", displayName: "Admin" },
      { userId: "director-1", email: "director@example.com", displayName: "Director" },
    ]);
  });

  it("returns nothing when a key that did not opt in has no assignments", async () => {
    const { db } = buildTenantDb({ assignedUserIds: [], people: PEOPLE });

    await expect(getNotificationRecipients(db, "marketing_expense_approver")).resolves.toEqual([]);
  });

  it("does not add the fallback on top of an explicit assignment", async () => {
    const { db } = buildTenantDb({ assignedUserIds: ["rep-1"], people: PEOPLE });

    await expect(
      getNotificationRecipients(db, "bid_due_date_report", { fallbackToAdminsAndDirectors: true }),
    ).resolves.toEqual([{ userId: "rep-1", email: "rep@example.com", displayName: "Rep" }]);
  });
});

describe("the well-known group registry", () => {
  it("registers the two keys the upcoming reports need", () => {
    expect(NOTIFICATION_RECIPIENT_GROUPS.map((group) => group.key)).toEqual(
      expect.arrayContaining(["lead_due_diligence", "bid_due_date_report", "marketing_expense_approver"]),
    );
  });

  // Parametrised over the registry rather than over a copied list: an entry added to `shared` that the
  // server cannot lazy-create is an admin page that 404s the moment somebody clicks it.
  it.each(NOTIFICATION_RECIPIENT_GROUPS.map((group) => [group.key, group.name] as const))(
    "lazy-creates %s instead of 404ing",
    async (key, name) => {
      const { db, state } = buildTenantDb({ group: null });

      const result = await getNotificationRecipientGroup(db, key);

      expect(result.group.id).toBe(`created-${key}`);
      expect(state.insertedRow).toMatchObject({ key, name });
    },
  );

  it("still throws 404 for a key nobody registered", async () => {
    const { db } = buildTenantDb({ group: null });

    await expect(getNotificationRecipientGroup(db, "some_other_unknown_key")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("keeps the lead_due_diligence fallback wired to its group read", async () => {
    // The admin page shows "current recipients" from this call. Before anyone is assigned, DD has always
    // shown the admins and directors who would actually receive the mail; the new keys have not.
    const withFallback = buildTenantDb({ group: null, assignedUserIds: [], people: PEOPLE });
    const withoutFallback = buildTenantDb({ group: null, assignedUserIds: [], people: PEOPLE });

    const dd = await getNotificationRecipientGroup(withFallback.db, "lead_due_diligence");
    const bid = await getNotificationRecipientGroup(withoutFallback.db, "bid_due_date_report");

    expect(dd.recipients.map((recipient) => recipient.userId)).toEqual(["admin-1", "director-1"]);
    expect(bid.recipients).toEqual([]);
  });
});
