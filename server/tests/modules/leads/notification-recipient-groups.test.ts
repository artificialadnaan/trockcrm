import fs from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { notificationRecipientAssignments, notificationRecipientGroups, users } from "@trock-crm/shared/schema";
import { NOTIFICATION_RECIPIENT_GROUPS } from "@trock-crm/shared/types";
import {
  getNotificationRecipientGroup,
  getNotificationRecipients,
  resolveNotificationRecipients,
  updateNotificationRecipientAssignments,
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

  const tx = {
    delete: vi.fn(() => ({ where: vi.fn(async () => { state.assignedUserIds = []; }) })),
    insert: vi.fn(() => ({
      values: vi.fn(async (rows: Array<{ userId: string }>) => {
        state.assignedUserIds = rows.map((row) => row.userId);
      }),
    })),
  };

  return {
    state,
    tx,
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
            // NOT pre-filtered on isActive, mirroring the query: the resolver does that split itself now,
            // because "no deliverable recipients" and "nothing assigned" have to stay distinguishable.
            if (selectedTable === notificationRecipientGroups && fields && "email" in fields) {
              return Promise.resolve(
                state.people
                  .filter((person) => state.assignedUserIds.includes(person.id))
                  .map((person) => ({ ...toRecipient(person), isActive: person.isActive !== false })),
              );
            }
            // The assignment WRITE reads the CURRENT membership first, so the gates can be applied to the
            // change rather than to the whole submitted set.
            if (selectedTable === notificationRecipientAssignments) {
              return Promise.resolve(state.assignedUserIds.map((userId) => ({ userId })));
            }
            // The assignment WRITE checks the named users exist and reads role + isActive back for the gates.
            if (selectedTable === users && fields && "id" in fields) {
              return Promise.resolve(
                state.people.map((person) => ({
                  id: person.id,
                  role: person.role,
                  isActive: person.isActive !== false,
                })),
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
      transaction: vi.fn(async (callback: (handle: typeof tx) => Promise<void>) => callback(tx)),
    } as never,
  };
}

const PEOPLE: Person[] = [
  { id: "admin-1", email: "admin@example.com", displayName: "Admin", role: "admin" },
  { id: "director-1", email: "director@example.com", displayName: "Director", role: "director" },
  { id: "rep-1", email: "rep@example.com", displayName: "Rep", role: "rep" },
  { id: "inactive-admin", email: "inactive@example.com", displayName: "Inactive", role: "admin", isActive: false },
  { id: "retired-rep", email: "retired@example.com", displayName: "Retired", role: "rep", isActive: false },
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

  it("does NOT widen to every admin and director when the only assignee has been deactivated", async () => {
    // The sharp one. The assignment read filters on `users.isActive`, so an assignment to somebody who
    // later leaves resolves to zero rows — and zero rows is the exact condition that fires the fallback.
    // Offboarding the assigned approver would therefore mail a working approve/decline link to EVERY
    // active admin and director, on a path where the token is the only authentication and `decided_by` is
    // recorded NULL. An empty result from a FILTERED read is not "nothing is configured".
    const { db } = buildTenantDb({ assignedUserIds: ["inactive-admin"], people: PEOPLE });

    const resolution = await resolveNotificationRecipients(db, "lead_due_diligence", {
      fallbackToAdminsAndDirectors: true,
    });

    expect(resolution.recipients).toEqual([]);
    expect(resolution.fallbackApplied).toBe(false);
    // Surfaced rather than swallowed: this group needs an admin, and saying so is the whole point.
    expect(resolution.inactiveAssignedUserIds).toEqual(["inactive-admin"]);
  });

  it("still widens when the group genuinely has no assignment rows at all", async () => {
    // The distinction that makes the guard above meaningful rather than a blanket disable.
    const { db } = buildTenantDb({ assignedUserIds: [], people: PEOPLE });

    const resolution = await resolveNotificationRecipients(db, "lead_due_diligence", {
      fallbackToAdminsAndDirectors: true,
    });

    expect(resolution.recipients.map((recipient) => recipient.userId)).toEqual(["admin-1", "director-1"]);
    expect(resolution.fallbackApplied).toBe(true);
  });

  it("mails the active assignees and reports the deactivated ones alongside them", async () => {
    const { db } = buildTenantDb({ assignedUserIds: ["director-1", "inactive-admin"], people: PEOPLE });

    const resolution = await resolveNotificationRecipients(db, "lead_due_diligence", {
      fallbackToAdminsAndDirectors: true,
    });

    expect(resolution.recipients.map((recipient) => recipient.userId)).toEqual(["director-1"]);
    expect(resolution.assignedUserIds).toEqual(["director-1"]);
    expect(resolution.inactiveAssignedUserIds).toEqual(["inactive-admin"]);
  });
});

describe("resolveNotificationRecipients", () => {
  it("says whether the group row exists, so a job can log 'not configured' instead of mailing nobody", async () => {
    // Group rows are created lazily by the admin page. A job that reads a key nobody has visited gets the
    // same empty array as a key an admin deliberately emptied, and the two need different log lines — the
    // silent-nobody failure this whole PR is named after.
    const missing = buildTenantDb({ group: null, assignedUserIds: [], people: PEOPLE });
    const present = buildTenantDb({
      group: { id: "g1", key: "marketing_expense_approver", name: "Marketing Expense Approver", description: "" },
      assignedUserIds: [],
      people: PEOPLE,
    });

    await expect(resolveNotificationRecipients(missing.db, "marketing_expense_approver")).resolves.toMatchObject({
      recipients: [],
      groupExists: false,
    });
    await expect(resolveNotificationRecipients(present.db, "marketing_expense_approver")).resolves.toMatchObject({
      recipients: [],
      groupExists: true,
    });
  });
});

describe("updateNotificationRecipientAssignments role gate", () => {
  const GROUP = { id: "g1", key: "lead_due_diligence", name: "Lead Due Diligence", description: "" };

  it("refuses to make a non-admin/director a due-diligence approver", async () => {
    // The page filters the picker, but the API is what an admin's browser actually talks to. A DD
    // assignment hands out an approve/decline token that needs no login, so this cannot be UI-only.
    const { db, state } = buildTenantDb({ group: GROUP, assignedUserIds: ["admin-1"], people: PEOPLE });

    await expect(
      updateNotificationRecipientAssignments(db, "lead_due_diligence", ["rep-1"]),
    ).rejects.toMatchObject({ statusCode: 400 });

    expect(state.assignedUserIds).toEqual(["admin-1"]);
  });

  it("names the offending user and the roles that are allowed", async () => {
    const { db } = buildTenantDb({ group: GROUP, assignedUserIds: [], people: PEOPLE });

    await expect(
      updateNotificationRecipientAssignments(db, "lead_due_diligence", ["rep-1"]),
    ).rejects.toMatchObject({ message: expect.stringContaining("rep-1") });
  });

  it("refuses to assign a DEACTIVATED user, whatever their role", async () => {
    // Not merely a wasted mailbox. An assignment nobody can deliver to resolves to zero active recipients,
    // and for a group with a fallback that is indistinguishable from "nobody is assigned" — so the one
    // thing this gate exists to prevent, a non-approver receiving approval links, arrives by the back door.
    const { db, state } = buildTenantDb({ group: GROUP, assignedUserIds: ["admin-1"], people: PEOPLE });

    await expect(
      updateNotificationRecipientAssignments(db, "lead_due_diligence", ["inactive-admin"]),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("inactive-admin") });

    expect(state.assignedUserIds).toEqual(["admin-1"]);
  });

  it("refuses a deactivated user on an unrestricted group too", async () => {
    // No `assignableRoles` on this key, so the role gate never runs — the active check has to be its own.
    const { db } = buildTenantDb({
      group: { id: "g2", key: "bid_due_date_report", name: "Bid Due Date Report", description: "" },
      assignedUserIds: [],
      people: PEOPLE,
    });

    await expect(
      updateNotificationRecipientAssignments(db, "bid_due_date_report", ["retired-rep"]),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("retired-rep") });
  });

  it("lets an admin REMOVE an assignee whose role has drifted out of policy", async () => {
    // The mirror of the two refusals above. Validating the resulting SET rather than the CHANGE means a
    // rule that blocks you from LEAVING a bad state, which is worse than no rule — the bad state becomes
    // permanent. `rep-1` was assigned while they were a director; the admin is here to take them off.
    const { db, state } = buildTenantDb({
      group: GROUP,
      assignedUserIds: ["director-1", "rep-1"],
      people: PEOPLE,
    });

    await updateNotificationRecipientAssignments(db, "lead_due_diligence", ["director-1"]);

    expect(state.assignedUserIds).toEqual(["director-1"]);
  });

  it("lets a drifted assignee be KEPT, so the page is savable at all", async () => {
    // What the admin page actually submits: everything currently assigned, including the drifted entry it
    // is about to let them untick. Rejecting this is the lockout — every save fails on their presence.
    const { db, state } = buildTenantDb({
      group: GROUP,
      assignedUserIds: ["director-1", "rep-1"],
      people: PEOPLE,
    });

    await updateNotificationRecipientAssignments(db, "lead_due_diligence", ["director-1", "rep-1"]);

    expect(state.assignedUserIds).toEqual(["director-1", "rep-1"]);
  });

  it("still refuses to ADD a disallowed user who is not already assigned", async () => {
    // The add path must keep biting, or the remove fix has simply deleted the rule.
    const { db, state } = buildTenantDb({ group: GROUP, assignedUserIds: ["director-1"], people: PEOPLE });

    await expect(
      updateNotificationRecipientAssignments(db, "lead_due_diligence", ["director-1", "rep-1"]),
    ).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining("rep-1") });

    expect(state.assignedUserIds).toEqual(["director-1"]);
  });

  it("lets a DEACTIVATED assignee be KEPT, for the same reason as a drifted one", async () => {
    // The is_active gate has the identical lockout shape as the role gate, and it is the likelier of the
    // two: the page submits everyone currently assigned, so once an assignee is offboarded a set-based
    // check refuses every save — including the one that would take them off.
    const { db, state } = buildTenantDb({
      group: GROUP,
      assignedUserIds: ["director-1", "inactive-admin"],
      people: PEOPLE,
    });

    await updateNotificationRecipientAssignments(db, "lead_due_diligence", ["director-1", "inactive-admin"]);

    expect(state.assignedUserIds).toEqual(["director-1", "inactive-admin"]);
  });

  it("lets a DEACTIVATED assignee be removed as well", async () => {
    const { db, state } = buildTenantDb({
      group: GROUP,
      assignedUserIds: ["director-1", "inactive-admin"],
      people: PEOPLE,
    });

    await updateNotificationRecipientAssignments(db, "lead_due_diligence", ["director-1"]);

    expect(state.assignedUserIds).toEqual(["director-1"]);
  });

  it("still accepts admins and directors for due diligence", async () => {
    const { db, state } = buildTenantDb({ group: GROUP, assignedUserIds: [], people: PEOPLE });

    await updateNotificationRecipientAssignments(db, "lead_due_diligence", ["admin-1", "director-1"]);

    expect(state.assignedUserIds).toEqual(["admin-1", "director-1"]);
  });

  it("lets a rep onto an unrestricted group — that is the whole point of the bid due date report", async () => {
    const { db, state } = buildTenantDb({
      group: { id: "g2", key: "bid_due_date_report", name: "Bid Due Date Report", description: "" },
      assignedUserIds: [],
      people: PEOPLE,
    });

    await updateNotificationRecipientAssignments(db, "bid_due_date_report", ["rep-1"]);

    expect(state.assignedUserIds).toEqual(["rep-1"]);
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

  it("has no duplicate keys — two entries sharing a key would render two sections over one state slot", () => {
    const keys = NOTIFICATION_RECIPIENT_GROUPS.map((group) => group.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("warns about the WIDENING, not about silence, for every group that has a fallback", () => {
    // Emptying a group with a fallback does not stop the mail, it sends it to every admin and director.
    // Copy that says the opposite is what talks an admin into doing it.
    for (const group of NOTIFICATION_RECIPIENT_GROUPS.filter((entry) => entry.fallbackToAdminsAndDirectors)) {
      expect(group.emptyWarning, `${group.key} does not mention who receives it instead`).toMatch(
        /admins? and directors?/i,
      );
      expect(group.emptyWarning, `${group.key} claims the mail stops`).not.toMatch(
        /will not be sent|no longer|stop(s|ped)? /i,
      );
    }
  });

  it("restricts due-diligence membership to admins and directors, and restricts nothing else", () => {
    // DD recipients are mailed a decision token that authenticates on its own, so membership here is a
    // permission. The other two are mailing lists and must stay open — the bid report goes to a `rep`.
    const byKey = Object.fromEntries(NOTIFICATION_RECIPIENT_GROUPS.map((group) => [group.key, group]));
    expect(byKey.lead_due_diligence.assignableRoles).toEqual(["admin", "director"]);
    expect(byKey.bid_due_date_report.assignableRoles).toBeUndefined();
    expect(byKey.marketing_expense_approver.assignableRoles).toBeUndefined();
  });

  // The lazy upsert only fires when an admin opens the page. Until then a job reading the key sees an
  // empty list it cannot distinguish from a deliberately emptied one, so every registered key needs a row
  // that exists at deploy time. A fourth entry added with no migration fails here rather than in the field.
  //
  // Scanned rather than named: which FILE owns a given seed is not a fact worth asserting, and hardcoding
  // one couples this to a migration number. These get renumbered — this file was 0232 until a stacked
  // branch turned out to have claimed 0232 through 0237. All three strings must appear in the SAME file,
  // so a name that drifted from the registry cannot be satisfied by some other migration mentioning it.
  it.each(NOTIFICATION_RECIPIENT_GROUPS.map((group) => [group.key, group] as const))(
    "seeds a %s group row in a migration, not only on first page view",
    (key, definition) => {
      const migrationsDir = new URL("../../../../migrations/", import.meta.url);
      const seedingFiles = fs
        .readdirSync(migrationsDir)
        .filter((name) => name.endsWith(".sql"))
        .map((name) => fs.readFileSync(new URL(name, migrationsDir), "utf8"))
        .filter((sql) => sql.includes(`'${key}'`));

      expect(seedingFiles.length, `no migration seeds ${key}`).toBeGreaterThan(0);
      expect(
        seedingFiles.some(
          (sql) => sql.includes(`'${definition.name}'`) && sql.includes(`'${definition.description}'`),
        ),
        `${key}'s seeded name/description have drifted from the registry`,
      ).toBe(true);
    },
  );

  it("still throws 404 for a key nobody registered", async () => {
    const { db } = buildTenantDb({ group: null });

    await expect(getNotificationRecipientGroup(db, "some_other_unknown_key")).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("reports the fallback as a fallback, so the admin page cannot freeze it into a static list", async () => {
    // The page pre-ticks what it is told is ASSIGNED. Handing it the fallback under the same name means
    // the first Save writes those people in as real rows and the fallback never fires again — a director
    // hired next year silently stops receiving DD, and the list still looks right.
    const { db } = buildTenantDb({ group: null, assignedUserIds: [], people: PEOPLE });

    const result = await getNotificationRecipientGroup(db, "lead_due_diligence");

    expect(result.recipients.map((recipient) => recipient.userId)).toEqual(["admin-1", "director-1"]);
    expect(result.assignedUserIds).toEqual([]);
    expect(result.fallbackApplied).toBe(true);
  });

  it("reports real assignments as assigned", async () => {
    const { db } = buildTenantDb({ group: null, assignedUserIds: ["director-1"], people: PEOPLE });

    const result = await getNotificationRecipientGroup(db, "lead_due_diligence");

    expect(result.assignedUserIds).toEqual(["director-1"]);
    expect(result.fallbackApplied).toBe(false);
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
