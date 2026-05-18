import { describe, expect, it, vi } from "vitest";

const {
  mapNoteToActivity,
  mapCallToActivity,
  mapMeetingToActivity,
  mapEmailToRecords,
  writeAtomic,
} = await import("../../../src/modules/migration/deal-activity-backfill-service.js");

function makeEngagement(overrides: Partial<any> = {}) {
  const overrideProperties = overrides.properties ?? {};
  const overrideAssociations = overrides.associations ?? {};
  return {
    id: "hs-1",
    objectType: "note",
    ...overrides,
    properties: {
      hs_timestamp: "2026-05-01T12:34:56.000Z",
      hubspot_owner_id: "owner-1",
      ...overrideProperties,
    },
    associations: {
      deals: { results: [{ id: "hubspot-deal-1" }] },
      ...overrideAssociations,
    },
  };
}

function createTransactionalDb() {
  const state = {
    emails: [] as Array<Record<string, unknown>>,
    activities: [] as Array<Record<string, unknown>>,
    ledger: [] as Array<Record<string, unknown>>,
  };

  const db = {
    transaction: async (callback: (tx: any) => Promise<unknown>) => {
      const staged = {
        emails: [...state.emails],
        activities: [...state.activities],
        ledger: [...state.ledger],
      };

      let emailIdCounter = staged.emails.length + 1;
      let activityIdCounter = staged.activities.length + 1;
      let ledgerIdCounter = staged.ledger.length + 1;

      const tx = {
        execute: async (_query: unknown) => [],
        select: (_selection: unknown) => ({
          from: (_table: unknown) => ({
            where: (_predicate: unknown) => ({
              limit: async (_count: number) => staged.ledger.slice(0, 1),
            }),
          }),
        }),
        insert: (_table: unknown) => ({
          values: (payload: Record<string, unknown>) => ({
            onConflictDoUpdate: (_config: unknown) => ({
              returning: async () => {
                if ("graphMessageId" in payload) {
                  const row = { id: `email-${emailIdCounter++}`, ...payload };
                  staged.emails.push(row);
                  return [row];
                }
                if ("hubspotObjectType" in payload) {
                  const existingIndex = staged.ledger.findIndex(
                    (row) =>
                      row.tenantSchema === payload.tenantSchema &&
                      row.hubspotObjectType === payload.hubspotObjectType &&
                      row.hubspotObjectId === payload.hubspotObjectId
                  );
                  const row = {
                    id: existingIndex >= 0 ? staged.ledger[existingIndex].id : `ledger-${ledgerIdCounter++}`,
                    ...payload,
                  };
                  if (existingIndex >= 0) staged.ledger[existingIndex] = row;
                  else staged.ledger.push(row);
                  return [row];
                }
                if ("sourceEntityType" in payload) {
                  if (payload.subject === "force failure") throw new Error("activity insert failed");
                  const row = { id: `activity-${activityIdCounter++}`, ...payload };
                  staged.activities.push(row);
                  return [row];
                }
                throw new Error("Unexpected insert payload");
              },
            }),
            returning: async () => {
              if ("graphMessageId" in payload) {
                const row = { id: `email-${emailIdCounter++}`, ...payload };
                staged.emails.push(row);
                return [row];
              }
              if ("hubspotObjectType" in payload) {
                const row = { id: `ledger-${ledgerIdCounter++}`, ...payload };
                staged.ledger.push(row);
                return [row];
              }
              if ("sourceEntityType" in payload) {
                if (payload.subject === "force failure") throw new Error("activity insert failed");
                const row = { id: `activity-${activityIdCounter++}`, ...payload };
                staged.activities.push(row);
                return [row];
              }
              throw new Error("Unexpected insert payload");
            },
          }),
        }),
      };

      const result = await callback(tx);
      state.emails = staged.emails;
      state.activities = staged.activities;
      state.ledger = staged.ledger;
      return result;
    },
  };

  return { db, state };
}

describe("deal activity backfill service", () => {
  it("maps a note engagement into an activity payload", () => {
    const result = mapNoteToActivity({
      engagement: makeEngagement({
        objectType: "note",
        properties: { hs_note_body: "HubSpot note body" },
      }),
      deal: { id: "deal-1" },
      userId: "user-1",
    });

    expect(result).toMatchObject({
      type: "note",
      responsibleUserId: "user-1",
      performedByUserId: "user-1",
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
      dealId: "deal-1",
      body: "HubSpot note body",
      occurredAt: new Date("2026-05-01T12:34:56.000Z"),
    });
  });

  it("maps a call engagement with duration minutes and outcome", () => {
    const result = mapCallToActivity({
      engagement: makeEngagement({
        objectType: "call",
        properties: {
          hs_call_title: "Intro Call",
          hs_call_body: "Talked through scope",
          hs_call_duration: "180000",
          hs_call_outcome: "connected",
        },
      }),
      deal: { id: "deal-1" },
      userId: "user-1",
    });

    expect(result).toMatchObject({
      type: "call",
      subject: "Intro Call",
      body: "Talked through scope",
      durationMinutes: 3,
      outcome: "connected",
    });
  });

  it("maps a meeting engagement using meeting start time when present", () => {
    const result = mapMeetingToActivity({
      engagement: makeEngagement({
        objectType: "meeting",
        properties: {
          hs_meeting_title: "Site Walk",
          hs_meeting_body: "Met on site",
          hs_meeting_start_time: "2026-05-10T09:00:00.000Z",
        },
      }),
      deal: { id: "deal-1" },
      userId: "user-1",
    });

    expect(result).toMatchObject({
      type: "meeting",
      subject: "Site Walk",
      body: "Met on site",
      occurredAt: new Date("2026-05-10T09:00:00.000Z"),
    });
  });

  it("maps an email engagement into email and companion activity records", () => {
    const result = mapEmailToRecords({
      engagement: makeEngagement({
        id: "hs-email-1",
        objectType: "email",
        properties: {
          hs_email_subject: "Proposal Follow Up",
          hs_email_text: "Checking in on the proposal.",
          hs_email_direction: "INCOMING_EMAIL",
          hs_attachment_ids: "12345;67890",
          hs_email_headers: JSON.stringify({
            from: { email: "client@example.com" },
            to: [{ email: "rep@trock.com" }],
            cc: [{ email: "director@trock.com" }],
          }),
        },
      }),
      deal: { id: "deal-1" },
      userId: "user-1",
    });

    expect(result.email).toMatchObject({
      graphMessageId: "hubspot:hs-email-1",
      direction: "inbound",
      fromAddress: "client@example.com",
      toAddresses: ["rep@trock.com"],
      ccAddresses: ["director@trock.com"],
      subject: "Proposal Follow Up",
      dealId: "deal-1",
      assignedEntityType: "deal",
      assignedEntityId: "deal-1",
      userId: "user-1",
      hasAttachments: true,
    });
    expect(result.activity).toMatchObject({
      type: "email",
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
      dealId: "deal-1",
      subject: "Proposal Follow Up",
    });
  });

  it("writes a note activity and ledger atomically", async () => {
    const { db, state } = createTransactionalDb();

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "note",
        hubspotObjectId: "hs-note-1",
        targetEntityType: "deal",
        targetEntityId: "deal-1",
        status: "imported",
        sourcePayload: { id: "hs-note-1" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        dealId: "deal-1",
        body: "Imported note",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.activityId).toBe("activity-1");
    expect(result.emailId).toBeNull();
    expect(result.didImport).toBe(true);
    expect(state.activities).toHaveLength(1);
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      activityId: "activity-1",
      emailId: null,
      status: "imported",
    });
  });

  it("rolls back activity and ledger writes together when activity insertion fails", async () => {
    const { db, state } = createTransactionalDb();

    await expect(
      writeAtomic(db as any, {
        ledger: {
          tenantSchema: "office_dallas",
          hubspotObjectType: "note",
          hubspotObjectId: "hs-note-2",
          targetEntityType: "deal",
          targetEntityId: "deal-1",
          status: "imported",
          sourcePayload: { id: "hs-note-2" },
        },
        activity: {
          type: "note",
          responsibleUserId: "user-1",
          performedByUserId: "user-1",
          sourceEntityType: "deal",
          sourceEntityId: "deal-1",
          dealId: "deal-1",
          subject: "force failure",
          occurredAt: new Date("2026-05-01T00:00:00.000Z"),
        },
      })
    ).rejects.toThrow("activity insert failed");

    expect(state.activities).toHaveLength(0);
    expect(state.ledger).toHaveLength(0);
  });

  it("writes email, companion activity, and ledger in one transaction", async () => {
    const { db, state } = createTransactionalDb();

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "email",
        hubspotObjectId: "hs-email-3",
        targetEntityType: "deal",
        targetEntityId: "deal-1",
        status: "imported",
        sourcePayload: { id: "hs-email-3" },
      },
      email: {
        graphMessageId: "hubspot:hs-email-3",
        direction: "outbound",
        fromAddress: "rep@trock.com",
        toAddresses: ["client@example.com"],
        ccAddresses: [],
        subject: "Proposal",
        bodyPreview: "Proposal",
        bodyHtml: "<p>Proposal</p>",
        hasAttachments: false,
        contactId: null,
        dealId: "deal-1",
        assignedEntityType: "deal",
        assignedEntityId: "deal-1",
        assignmentConfidence: "high",
        assignmentAmbiguityReason: null,
        userId: "user-1",
        sentAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      activity: {
        type: "email",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        dealId: "deal-1",
        subject: "Proposal",
        body: "Proposal",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.emailId).toBe("email-1");
    expect(result.activityId).toBe("activity-1");
    expect(result.didImport).toBe(true);
    expect(state.emails).toHaveLength(1);
    expect(state.activities).toHaveLength(1);
    expect(state.activities[0]?.emailId).toBe("email-1");
    expect(state.ledger[0]).toMatchObject({
      activityId: "activity-1",
      emailId: "email-1",
      status: "imported",
    });
  });

  it("promotes a previously skipped ledger row to imported on rerun", async () => {
    const { db, state } = createTransactionalDb();

    state.ledger.push({
      id: "ledger-1",
      tenantSchema: "office_dallas",
      hubspotObjectType: "note",
      hubspotObjectId: "hs-note-3",
      targetEntityType: null,
      targetEntityId: null,
      status: "skipped_unmapped_user",
      skipReason: "missing user mapping",
      sourcePayload: { id: "hs-note-3" },
      activityId: null,
      emailId: null,
    });

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "note",
        hubspotObjectId: "hs-note-3",
        targetEntityType: "deal",
        targetEntityId: "deal-1",
        status: "imported",
        sourcePayload: { id: "hs-note-3" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        dealId: "deal-1",
        body: "Imported after repair",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.activityId).toBe("activity-1");
    expect(state.ledger).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      id: "ledger-1",
      targetEntityType: "deal",
      targetEntityId: "deal-1",
      status: "imported",
      skipReason: null,
      activityId: "activity-1",
      emailId: null,
    });
  });

  it("returns the existing imported ledger target without duplicating activity rows", async () => {
    const { db, state } = createTransactionalDb();

    state.ledger.push({
      id: "ledger-1",
      tenantSchema: "office_dallas",
      hubspotObjectType: "note",
      hubspotObjectId: "hs-note-4",
      targetEntityType: "deal",
      targetEntityId: "deal-1",
      status: "imported",
      skipReason: null,
      sourcePayload: { id: "hs-note-4" },
      activityId: "activity-existing",
      emailId: null,
    });

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "note",
        hubspotObjectId: "hs-note-4",
        targetEntityType: "deal",
        targetEntityId: "deal-1",
        status: "imported",
        sourcePayload: { id: "hs-note-4" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "deal",
        sourceEntityId: "deal-1",
        dealId: "deal-1",
        body: "Should not duplicate",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result).toEqual({ activityId: "activity-existing", emailId: null, didImport: false });
    expect(state.activities).toHaveLength(0);
    expect(state.ledger).toHaveLength(1);
  });

  it("rejects invalid source timestamps instead of rewriting history to now", () => {
    expect(() =>
      mapNoteToActivity({
        engagement: makeEngagement({
          objectType: "note",
          properties: {
            hs_timestamp: "not-a-date",
            hs_note_body: "bad timestamp",
          },
        }),
        deal: { id: "deal-1" },
        userId: "user-1",
      })
    ).toThrow("Invalid HubSpot engagement timestamp");
  });
});
