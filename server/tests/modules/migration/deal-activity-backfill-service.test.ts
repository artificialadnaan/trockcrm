import { companies, contacts, deals } from "@trock-crm/shared/schema";
import { describe, expect, it } from "vitest";

const {
  findTargetEntityForHubspotEngagement,
  findDealForHubspotEngagement,
  htmlToPlainText,
  mapNoteToActivity,
  mapCallToActivity,
  mapMeetingToActivity,
  mapEmailToRecords,
  writeAtomic,
  writeLedgerOnly,
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
      companies: { results: [] },
      contacts: { results: [] },
      ...overrideAssociations,
    },
  };
}

function makeDealTarget() {
  return {
    type: "deal" as const,
    id: "deal-1",
    entity: { id: "deal-1", name: "Jefferson on The Lake", hubspotDealId: "hubspot-deal-1" },
    hubspotDealIds: ["hubspot-deal-1"],
    hubspotCompanyIds: [],
    hubspotContactIds: [],
  };
}

function makeCompanyTarget() {
  return {
    type: "company" as const,
    id: "company-1",
    entity: { id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null },
    hubspotDealIds: [],
    hubspotCompanyIds: ["hubspot-company-1"],
    hubspotContactIds: [],
  };
}

function makeContactTarget() {
  return {
    type: "contact" as const,
    id: "contact-1",
    entity: {
      id: "contact-1",
      firstName: "Jane",
      lastName: "Client",
      companyId: "company-1",
      hubspotContactId: "hubspot-contact-1",
    },
    hubspotDealIds: [],
    hubspotCompanyIds: [],
    hubspotContactIds: ["hubspot-contact-1"],
  };
}

function createLookupDb(input: {
  dealRows?: Array<Record<string, unknown>>;
  companyRows?: Array<Record<string, unknown>>;
  contactRows?: Array<Record<string, unknown>>;
}) {
  const dealRows = input.dealRows ?? [];
  const companyRows = input.companyRows ?? [];
  const contactRows = input.contactRows ?? [];
  return {
    select: (_selection: unknown) => ({
      from: (table: unknown) => ({
        where: async (_predicate: unknown) => {
          if (table === deals) return dealRows;
          if (table === companies) return companyRows;
          if (table === contacts) return contactRows;
          return [];
        },
      }),
    }),
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
  it("resolves a direct HubSpot deal association first", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        dealRows: [{ id: "deal-1", name: "Jefferson", hubspotDealId: "hubspot-deal-1" }],
      }) as any,
      makeEngagement().associations
    );

    expect(result).toMatchObject({
      type: "deal",
      id: "deal-1",
      entity: { name: "Jefferson" },
    });
  });

  it("falls back to company when no deal match exists", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        companyRows: [{ id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null }],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [{ id: "hubspot-deal-missing" }] },
          companies: { results: [{ id: "hubspot-company-1" }] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result).toMatchObject({
      type: "company",
      id: "company-1",
      entity: { name: "Acme Roofing" },
    });
  });

  it("falls back to contact when no deal or company match exists", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        contactRows: [
          {
            id: "contact-1",
            firstName: "Jane",
            lastName: "Client",
            companyId: "company-1",
            hubspotContactId: "hubspot-contact-1",
          },
        ],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [] },
          companies: { results: [] },
          contacts: { results: [{ id: "hubspot-contact-1" }] },
        },
      }).associations
    );

    expect(result).toMatchObject({
      type: "contact",
      id: "contact-1",
      entity: { firstName: "Jane", lastName: "Client" },
    });
  });

  it("keeps deal priority over company when both associations exist", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        dealRows: [{ id: "deal-1", name: "Jefferson", hubspotDealId: "hubspot-deal-1" }],
        companyRows: [{ id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null }],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [{ id: "hubspot-deal-1" }] },
          companies: { results: [{ id: "hubspot-company-1" }] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result.type).toBe("deal");
  });

  it("keeps company priority over contact when no deal match exists", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        companyRows: [{ id: "company-1", name: "Acme Roofing", hubspotCompanyId: "hubspot-company-1", hubspotId: null }],
        contactRows: [{ id: "contact-1", firstName: "Jane", lastName: "Client", companyId: "company-1", hubspotContactId: "hubspot-contact-1" }],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [] },
          companies: { results: [{ id: "hubspot-company-1" }] },
          contacts: { results: [{ id: "hubspot-contact-1" }] },
        },
      }).associations
    );

    expect(result.type).toBe("company");
  });

  it("returns ambiguous for multiple matched deals", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        dealRows: [
          { id: "deal-1", name: "One", hubspotDealId: "hubspot-deal-1" },
          { id: "deal-2", name: "Two", hubspotDealId: "hubspot-deal-2" },
        ],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [{ id: "hubspot-deal-1" }, { id: "hubspot-deal-2" }] },
          companies: { results: [] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result).toMatchObject({
      type: "ambiguous",
      reason: "Multiple active T Rock deals matched the HubSpot deal association",
    });
  });

  it("returns ambiguous for multiple matched companies", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({
        companyRows: [
          { id: "company-1", name: "Acme", hubspotCompanyId: "hubspot-company-1", hubspotId: null },
          { id: "company-2", name: "Bravo", hubspotCompanyId: "hubspot-company-2", hubspotId: null },
        ],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [] },
          companies: { results: [{ id: "hubspot-company-1" }, { id: "hubspot-company-2" }] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result).toMatchObject({
      type: "ambiguous",
      reason: "Multiple active T Rock companies matched the HubSpot company association",
    });
  });

  it("keeps the deal-only wrapper orphaned when only company ambiguity exists", async () => {
    const result = await findDealForHubspotEngagement(
      createLookupDb({
        companyRows: [
          { id: "company-1", name: "Acme", hubspotCompanyId: "hubspot-company-1", hubspotId: null },
          { id: "company-2", name: "Bravo", hubspotCompanyId: "hubspot-company-2", hubspotId: null },
        ],
      }) as any,
      makeEngagement({
        associations: {
          deals: { results: [] },
          companies: { results: [{ id: "hubspot-company-1" }, { id: "hubspot-company-2" }] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result).toEqual({
      status: "orphan",
      hubspotDealIds: [],
    });
  });

  it("returns orphan when no associations map anywhere", async () => {
    const result = await findTargetEntityForHubspotEngagement(
      createLookupDb({}) as any,
      makeEngagement({
        associations: {
          deals: { results: [] },
          companies: { results: [] },
          contacts: { results: [] },
        },
      }).associations
    );

    expect(result).toMatchObject({
      type: "orphan",
      reason: "HubSpot engagement had no deal, company, or contact associations",
    });
  });

  it("maps activities with entity-specific foreign keys", () => {
    const note = mapNoteToActivity({
      engagement: makeEngagement({
        objectType: "note",
        properties: {
          hs_note_body: "<div><p>HubSpot&nbsp;note <strong>body</strong></p></div>",
          createdate: "2026-04-30T10:11:12.000Z",
        },
      }),
      targetEntity: makeCompanyTarget(),
      userId: "user-1",
    });
    const call = mapCallToActivity({
      engagement: makeEngagement({
        objectType: "call",
        properties: {
          hs_call_title: "<div>Intro&nbsp;Call</div>",
          hs_call_body: "<div><p>Talked through <em>scope</em></p></div>",
          hs_call_duration: "180000",
          hs_call_outcome: "connected",
          createdate: "2026-05-01T08:30:00.000Z",
        },
      }),
      targetEntity: makeContactTarget(),
      userId: "user-1",
    });
    const meeting = mapMeetingToActivity({
      engagement: makeEngagement({
        objectType: "meeting",
        properties: {
          hs_meeting_title: "<div>Site Walk</div>",
          hs_meeting_body: "<div><p>Met on <strong>site</strong></p></div>",
          hs_meeting_start_time: "2026-05-10T09:00:00.000Z",
          createdate: "2026-05-02T08:00:00.000Z",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(note).toMatchObject({
      sourceEntityType: "company",
      sourceEntityId: "company-1",
      companyId: "company-1",
      dealId: null,
      contactId: null,
      body: "HubSpot note body",
      createdAt: new Date("2026-04-30T10:11:12.000Z"),
    });
    expect(call).toMatchObject({
      sourceEntityType: "contact",
      sourceEntityId: "contact-1",
      contactId: "contact-1",
      companyId: "company-1",
      dealId: null,
      durationMinutes: 3,
      outcome: "connected",
      subject: "Intro Call",
      body: "Talked through scope",
      createdAt: new Date("2026-05-01T08:30:00.000Z"),
    });
    expect(meeting).toMatchObject({
      sourceEntityType: "deal",
      sourceEntityId: "deal-1",
      dealId: "deal-1",
      companyId: null,
      contactId: null,
      subject: "Site Walk",
      body: "Met on site",
      occurredAt: new Date("2026-05-10T09:00:00.000Z"),
      createdAt: new Date("2026-05-02T08:00:00.000Z"),
    });
  });

  it("maps email and companion activity to the same non-deal entity", () => {
    const result = mapEmailToRecords({
      engagement: makeEngagement({
        id: "hs-email-1",
        objectType: "email",
        properties: {
          hs_email_subject: "Proposal Follow Up",
          hs_email_text: "<div><p>Checking in on the proposal.</p></div>",
          hs_email_html: "<div><p>Checking in on the <strong>proposal</strong>.</p></div>",
          hs_email_direction: "INCOMING_EMAIL",
          hs_attachment_ids: "12345;67890",
          createdate: "2026-05-03T07:00:00.000Z",
          hs_email_headers: JSON.stringify({
            from: { email: "client@example.com" },
            to: [{ email: "rep@trock.com" }],
            cc: [{ email: "director@trock.com" }],
          }),
        },
      }),
      targetEntity: makeContactTarget(),
      userId: "user-1",
    });

    expect(result.email).toMatchObject({
      contactId: "contact-1",
      dealId: null,
      assignedEntityType: "contact",
      assignedEntityId: "contact-1",
      assignmentStatus: "assigned",
      hasAttachments: true,
      bodyHtml: "<div><p>Checking in on the <strong>proposal</strong>.</p></div>",
      bodyPreview: "Checking in on the proposal.",
    });
    expect(result.activity).toMatchObject({
      sourceEntityType: "contact",
      sourceEntityId: "contact-1",
      contactId: "contact-1",
      dealId: null,
      companyId: "company-1",
      subject: "Proposal Follow Up",
      body: "Checking in on the proposal.",
      createdAt: new Date("2026-05-03T07:00:00.000Z"),
    });
  });

  it("converts common HubSpot HTML payloads to plain text", () => {
    expect(htmlToPlainText("<div><p>Hello&nbsp;<strong>world</strong> &amp; team</p></div>")).toBe(
      "Hello world & team"
    );
    expect(htmlToPlainText("&lt;div&gt;Hello&lt;/div&gt;")).toBe("Hello");
    expect(htmlToPlainText("Tom&rsquo;s &ldquo;quote&rdquo; &mdash; ok")).toBe("Tom’s “quote” — ok");
    expect(htmlToPlainText("<div>Broken<p>tag")).toBe("Broken tag");
    expect(htmlToPlainText("Value: &#9999999999; and &#x110000;")).toBe("Value: &#9999999999; and &#x110000;");
    expect(htmlToPlainText("")).toBe("");
    expect(htmlToPlainText(undefined)).toBe("");
    expect(htmlToPlainText(null)).toBe("");
  });

  it("gives attachment-only HubSpot notes a non-blank fallback body", () => {
    const note = mapNoteToActivity({
      engagement: makeEngagement({
        objectType: "note",
        properties: {
          hs_note_body: undefined,
          hs_attachment_ids: "12345;67890",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(note.body).toBe("HubSpot note imported without a text body. Attachments were present in HubSpot, but no inline text was available.");
  });

  it("maps HubSpot EMAIL direction as outbound and clamps long activity subjects", () => {
    const longSubject = "A".repeat(700);
    const result = mapEmailToRecords({
      engagement: makeEngagement({
        id: "hs-email-2",
        objectType: "email",
        properties: {
          hs_email_subject: longSubject,
          hs_email_text: "Outbound note",
          hs_email_direction: "EMAIL",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(result.email.direction).toBe("outbound");
    expect(result.email.subject).toBe(longSubject);
    expect(result.activity.subject).toHaveLength(500);
  });

  it("does not store opaque HubSpot call disposition GUIDs as outcomes", () => {
    const result = mapCallToActivity({
      engagement: makeEngagement({
        objectType: "call",
        properties: {
          hs_call_title: "Follow Up",
          hs_call_body: "Discussed next steps",
          hs_call_disposition: "f240bbac-87c9-4f6e-bf70-924b57d47db7",
          hs_call_status: "completed",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(result.outcome).toBe("completed");
  });

  it("preserves plain-text email addresses wrapped in angle brackets", () => {
    const result = mapEmailToRecords({
      engagement: makeEngagement({
        id: "hs-email-3",
        objectType: "email",
        properties: {
          hs_email_subject: "Forwarded Thread",
          hs_email_text: "From: Jane <jane@example.com>\nTo: Rep <rep@trock.com>",
          hs_email_direction: "INCOMING_EMAIL",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(result.activity.body).toBe("From: Jane <jane@example.com>\nTo: Rep <rep@trock.com>");
    expect(result.email.bodyHtml).toContain("&lt;jane@example.com&gt;");
  });

  it("preserves plain placeholder text that uses angle brackets", () => {
    const result = mapEmailToRecords({
      engagement: makeEngagement({
        id: "hs-email-4",
        objectType: "email",
        properties: {
          hs_email_subject: "Checklist",
          hs_email_text: "Discuss <materials> with PM",
          hs_email_direction: "INCOMING_EMAIL",
        },
      }),
      targetEntity: makeDealTarget(),
      userId: "user-1",
    });

    expect(result.activity.body).toBe("Discuss <materials> with PM");
  });

  it("writes a note activity and company-targeted ledger atomically", async () => {
    const { db, state } = createTransactionalDb();

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "note",
        hubspotObjectId: "hs-note-1",
        targetEntityType: "company",
        targetEntityId: "company-1",
        status: "imported",
        sourcePayload: { id: "hs-note-1" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "company",
        sourceEntityId: "company-1",
        companyId: "company-1",
        body: "Imported note",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.activityId).toBe("activity-1");
    expect(result.emailId).toBeNull();
    expect(state.activities).toHaveLength(1);
    expect(state.ledger[0]).toMatchObject({
      targetEntityType: "company",
      targetEntityId: "company-1",
      activityId: "activity-1",
      emailId: null,
      status: "imported",
    });
  });

  it("does not let a skip-path ledger write clobber an imported row", async () => {
    const { db, state } = createTransactionalDb();

    state.ledger.push({
      id: "ledger-1",
      tenantSchema: "office_dallas",
      hubspotObjectType: "note",
      hubspotObjectId: "hs-note-locked",
      targetEntityType: "deal",
      targetEntityId: "deal-1",
      status: "imported",
      skipReason: null,
      sourcePayload: { id: "hs-note-locked" },
      activityId: "activity-existing",
      emailId: null,
    });

    const result = await writeLedgerOnly(db as any, {
      tenantSchema: "office_dallas",
      hubspotObjectType: "note",
      hubspotObjectId: "hs-note-locked",
      targetEntityType: null,
      targetEntityId: null,
      status: "skipped_orphan",
      skipReason: "stale skip",
      sourcePayload: { id: "hs-note-locked" },
    });

    expect(result).toEqual({
      activityId: "activity-existing",
      emailId: null,
      didWrite: false,
    });
    expect(state.ledger[0]).toMatchObject({
      id: "ledger-1",
      targetEntityType: "deal",
      targetEntityId: "deal-1",
      status: "imported",
      skipReason: null,
      activityId: "activity-existing",
      emailId: null,
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

  it("writes email, companion activity, and contact-targeted ledger in one transaction", async () => {
    const { db, state } = createTransactionalDb();

    const result = await writeAtomic(db as any, {
      ledger: {
        tenantSchema: "office_dallas",
        hubspotObjectType: "email",
        hubspotObjectId: "hs-email-3",
        targetEntityType: "contact",
        targetEntityId: "contact-1",
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
        contactId: "contact-1",
        dealId: null,
        assignedEntityType: "contact",
        assignedEntityId: "contact-1",
        assignmentStatus: "assigned",
        assignmentConfidence: "high",
        assignmentAmbiguityReason: null,
        userId: "user-1",
        sentAt: new Date("2026-05-01T00:00:00.000Z"),
      },
      activity: {
        type: "email",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "contact",
        sourceEntityId: "contact-1",
        contactId: "contact-1",
        subject: "Proposal",
        body: "Proposal",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.emailId).toBe("email-1");
    expect(result.activityId).toBe("activity-1");
    expect(state.emails).toHaveLength(1);
    expect(state.activities[0]?.emailId).toBe("email-1");
    expect(state.ledger[0]).toMatchObject({
      targetEntityType: "contact",
      targetEntityId: "contact-1",
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
        targetEntityType: "company",
        targetEntityId: "company-1",
        status: "imported",
        sourcePayload: { id: "hs-note-3" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "company",
        sourceEntityId: "company-1",
        companyId: "company-1",
        body: "Imported after repair",
        occurredAt: new Date("2026-05-01T00:00:00.000Z"),
      },
    });

    expect(result.activityId).toBe("activity-1");
    expect(state.ledger[0]).toMatchObject({
      id: "ledger-1",
      targetEntityType: "company",
      targetEntityId: "company-1",
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
      targetEntityType: "contact",
      targetEntityId: "contact-1",
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
        targetEntityType: "contact",
        targetEntityId: "contact-1",
        status: "imported",
        sourcePayload: { id: "hs-note-4" },
      },
      activity: {
        type: "note",
        responsibleUserId: "user-1",
        performedByUserId: "user-1",
        sourceEntityType: "contact",
        sourceEntityId: "contact-1",
        contactId: "contact-1",
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
          properties: { hs_timestamp: "not-a-date", hs_note_body: "bad timestamp" },
        }),
        targetEntity: makeDealTarget(),
        userId: "user-1",
      })
    ).toThrow("Invalid HubSpot engagement timestamp");
  });
});
