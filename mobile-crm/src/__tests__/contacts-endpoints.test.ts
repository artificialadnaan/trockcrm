import * as contacts from "../api/endpoints/contacts";
import type { Fetcher } from "../api/endpoints/auth";

function recording(result: unknown = {}) {
  const calls: Array<{ path: string; opts: Record<string, unknown> }> = [];
  const fetcher = (async (path: string, opts: Record<string, unknown> = {}) => {
    calls.push({ path, opts });
    return result;
  }) as unknown as Fetcher;
  return { fetcher, calls };
}

/**
 * The contacts/companies routes use FOUR different envelope conventions, and a wrong guess renders an
 * empty screen rather than throwing. These pin each one against the server's actual res.json(...).
 */
describe("response envelopes", () => {
  it("GET /contacts returns the service result directly, not wrapped again", async () => {
    const { fetcher } = recording({ contacts: [{ id: "c1" }], pagination: { total: 1 } });
    const res = await contacts.listContacts(fetcher);
    expect(res.contacts).toHaveLength(1);
    expect(res.pagination?.total).toBe(1);
  });

  it("GET /contacts/:id unwraps { contact }", async () => {
    const { fetcher } = recording({ contact: { id: "c1", firstName: "Pat" } });
    await expect(contacts.getContact(fetcher, "c1")).resolves.toMatchObject({ firstName: "Pat" });
  });

  it("GET /contacts/:id/deals unwraps { associations }, NOT a bare deal list", async () => {
    const { fetcher } = recording({ associations: [{ id: "a1", deal: { id: "d1" } }] });
    const res = await contacts.getContactDeals(fetcher, "c1");
    expect(res[0].deal?.id).toBe("d1");
  });

  it("GET /companies/:id unwraps { company }", async () => {
    const { fetcher } = recording({ company: { id: "co1", name: "Acme" } });
    await expect(contacts.getCompany(fetcher, "co1")).resolves.toMatchObject({ name: "Acme" });
  });

  it("GET /companies/:id/contacts unwraps { contacts }", async () => {
    const { fetcher } = recording({ contacts: [{ id: "c1" }] });
    await expect(contacts.getCompanyContacts(fetcher, "co1")).resolves.toHaveLength(1);
  });

  it.each([
    ["contacts", () => contacts.listContacts(recording({}).fetcher)],
    ["companies", () => contacts.listCompanies(recording({}).fetcher)],
  ])("%s list degrades to an empty array when the key is absent", async (_case, run) => {
    // A screen doing .map() on undefined crashes; an empty list renders an empty state.
    const res = (await run()) as { contacts?: unknown[]; companies?: unknown[] };
    expect(res.contacts ?? res.companies).toEqual([]);
  });
});

describe("query params", () => {
  it("omits a whitespace-only search", async () => {
    const { fetcher, calls } = recording({ contacts: [] });
    await contacts.listContacts(fetcher, { search: "   " });
    expect((calls[0].opts.query as Record<string, unknown>).search).toBeUndefined();
  });

  it("drops page 0, which buildQuery would otherwise transmit", async () => {
    const { fetcher, calls } = recording({ contacts: [] });
    await contacts.listContacts(fetcher, { page: 0 });
    expect((calls[0].opts.query as Record<string, unknown>).page).toBeUndefined();
  });
});

describe("contactCompanyName", () => {
  it("prefers the JOINED company name over the free-text one", () => {
    // The web list, detail header and company filter all coalesce in this order. Diverging here would
    // break "filter by what you can see" — the filter would not match the label shown on the row.
    expect(
      contacts.contactCompanyName({ linkedCompanyName: "Acme Corp", companyName: "acme (old)" }),
    ).toBe("Acme Corp");
  });

  it("falls back to free text when there is no linked company", () => {
    // Imported contacts frequently have only the free-text value.
    expect(contacts.contactCompanyName({ linkedCompanyName: null, companyName: "Acme" })).toBe("Acme");
  });

  it("returns null when neither exists", () => {
    expect(contacts.contactCompanyName({ linkedCompanyName: null, companyName: null })).toBeNull();
  });
});

describe("contactPhone", () => {
  it("prefers mobile — it is the number that reaches someone on a job site", () => {
    expect(contacts.contactPhone({ mobile: "555-0100", phone: "555-0200" })).toBe("555-0100");
  });

  it("falls back to the landline", () => {
    expect(contacts.contactPhone({ mobile: null, phone: "555-0200" })).toBe("555-0200");
  });

  it("returns null when there is no number at all, so the call button can be hidden", () => {
    expect(contacts.contactPhone({ mobile: null, phone: null })).toBeNull();
  });
});

describe("categoryLabel", () => {
  it("turns snake_case enum tokens into display text", () => {
    expect(contacts.categoryLabel("property_manager")).toBe("Property manager");
  });

  it("falls back to the raw token for an unknown value rather than hiding it", () => {
    // A category added server-side should stay visible, not silently vanish from the UI.
    expect(contacts.categoryLabel("newly_added_category")).toBe("newly_added_category");
  });

  it.each([null, undefined, ""])("renders nothing for %p", (value) => {
    expect(contacts.categoryLabel(value as string | null)).toBe("");
  });
});

describe("GET /companies pagination shape", () => {
  it("reads the TOP-LEVEL total/page/limit, which is not where /contacts puts them", async () => {
    // companies/service.ts returns { companies, total, page, limit, ... } — flat. Reading a `pagination`
    // object (the /contacts convention) yielded undefined for every field, so a caller could never learn
    // there was a second page. Two sibling endpoints, two conventions, no type error either way.
    const { fetcher } = recording({
      companies: [{ id: "co1" }],
      total: 214,
      page: 2,
      limit: 50,
      pipelineTotal: "0",
      staleCount: 0,
    });
    const res = await contacts.listCompanies(fetcher, { page: 2 });
    expect(res.total).toBe(214);
    expect(res.page).toBe(2);
    expect(res.limit).toBe(50);
  });
});

describe("GET /contacts/:id/deals", () => {
  function association(id: string, deal: Record<string, unknown> | null) {
    return { id, deal };
  }

  it("drops soft-deleted deals", async () => {
    // association-service.ts joins tenant.deals with NO is_active predicate — the only read path in the
    // app that doesn't. A deleted deal keeps its association row and comes back looking live, giving the
    // rep a tappable row that opens a detail screen for a deal that no longer exists.
    const { fetcher } = recording({
      associations: [
        association("a1", { id: "d1", name: "Live", isActive: true }),
        association("a2", { id: "d2", name: "Deleted", isActive: false }),
      ],
    });
    const res = await contacts.getContactDeals(fetcher, "c1");
    expect(res.map((a) => a.deal?.id)).toEqual(["d1"]);
  });

  it("keeps a deal whose isActive is absent rather than hiding it", async () => {
    // `!== false`, not `=== true`: an omitted or redacted flag is unknown, and hiding real work on a
    // missing field is a worse failure than showing one stale row.
    const { fetcher } = recording({
      associations: [association("a1", { id: "d1", name: "No flag" })],
    });
    await expect(contacts.getContactDeals(fetcher, "c1")).resolves.toHaveLength(1);
  });

  it("drops associations with no deal at all", async () => {
    const { fetcher } = recording({ associations: [association("a1", null)] });
    await expect(contacts.getContactDeals(fetcher, "c1")).resolves.toHaveLength(0);
  });
});

describe("phone extensions", () => {
  it.each([
    ["214-555-1212 ext 3", "2145551212", "3"],
    ["214-555-1212 ext. 3", "2145551212", "3"],
    ["214-555-1212 x104", "2145551212", "104"],
    ["(214) 555-1212 extension 22", "2145551212", "22"],
    ["214-555-1212 #45", "2145551212", "45"],
  ])("splits %s", (input, number, extension) => {
    expect(contacts.phoneParts(input)).toEqual({ number, extension });
  });

  it.each([
    ["214-555-1212", "2145551212"],
    ["+1 (214) 555-1212", "+12145551212"],
    ["  214.555.1212  ", "2145551212"],
  ])("leaves %s alone when there is no extension", (input, number) => {
    expect(contacts.phoneParts(input)).toEqual({ number, extension: null });
  });

  it("does not fold the extension into the number", () => {
    // The original sanitiser stripped every non-digit, turning this into the ELEVEN-digit 21455512123 —
    // a different number entirely. Tapping Call then dialled a stranger, with nothing on screen to say so.
    expect(contacts.telUrl("214-555-1212 ext 3")).not.toBe("tel:21455512123");
  });

  it("dials the extension after a pause", () => {
    // Commas are the dialer's pause convention; the digits after them are sent as DTMF once connected.
    expect(contacts.telUrl("214-555-1212 ext 3")).toBe("tel:2145551212,,3");
  });

  it("keeps a plain number plain", () => {
    expect(contacts.telUrl("+1 (214) 555-1212")).toBe("tel:+12145551212");
  });

  it("never puts an extension in an SMS URL", () => {
    // You cannot text an extension; including it would address the message to a nonexistent number.
    expect(contacts.smsUrl("214-555-1212 ext 3")).toBe("sms:2145551212");
  });
});
