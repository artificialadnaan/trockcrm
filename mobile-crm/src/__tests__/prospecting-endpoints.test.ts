import * as prospecting from "../api/endpoints/prospecting";
import { ApiError } from "../api/client";
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
 * The dedup envelope is the trap on this surface, and it is the kind that ships.
 *
 * `POST /contacts` and `POST /companies` answer **200** — not 201 — with `{ <entity>: null,
 * dedupWarning: true, suggestions }` when they suspect a duplicate. Anything that treats 2xx as success
 * reads an id off null and carries `undefined` into the activity it then creates, attaching a rep's
 * visit to nothing. Modelled as a union so the id is unreachable without first handling duplicates.
 */
describe("create endpoints — the 200-is-not-success trap", () => {
  it("reports a company dedup 200 as duplicates, NOT as a created company", async () => {
    const { fetcher } = recording({
      company: null,
      dedupWarning: true,
      suggestions: [{ id: "c9", name: "Palm Villas HOA" }],
    });
    const res = await prospecting.createCompany(fetcher, { name: "Palm Villas HOA" });
    expect(res.created).toBeUndefined();
    expect(res.duplicates).toEqual([{ id: "c9", name: "Palm Villas HOA" }]);
  });

  it("reports a contact dedup 200 the same way", async () => {
    const { fetcher } = recording({
      contact: null,
      dedupWarning: true,
      suggestions: [{ id: "ct9", firstName: "Dana", lastName: "Reyes" }],
    });
    const res = await prospecting.createContact(fetcher, {
      firstName: "Dana",
      lastName: "Reyes",
      category: "property_manager",
    });
    expect(res.created).toBeUndefined();
    expect(res.duplicates?.[0]?.id).toBe("ct9");
  });

  it("returns the entity on a genuine 201", async () => {
    const { fetcher } = recording({ company: { id: "c1", name: "Palm Villas HOA" } });
    const res = await prospecting.createCompany(fetcher, { name: "Palm Villas HOA" });
    expect(res.created).toEqual({ id: "c1", name: "Palm Villas HOA" });
    expect(res.duplicates).toBeUndefined();
  });

  it("treats a null entity with no dedupWarning as duplicates rather than success", async () => {
    // Defensive: whatever produced a null entity, the one thing we must not do is hand a caller an id
    // that does not exist.
    const { fetcher } = recording({ company: null });
    const res = await prospecting.createCompany(fetcher, { name: "X" });
    expect(res.created).toBeUndefined();
    expect(res.duplicates).toEqual([]);
  });

  it("does NOT send skipDedupCheck — the duplicate prompt is the feature", async () => {
    // "Did you mean Palm Villas HOA?" is exactly what should happen when a rep types a company that
    // already exists. Suppressing it is how a field tool creates duplicate #5.
    const { fetcher, calls } = recording({ company: { id: "c1", name: "X" } });
    await prospecting.createCompany(fetcher, { name: "X" });
    expect((calls[0].opts.body as Record<string, unknown>).skipDedupCheck).toBeUndefined();
  });
});

describe("reverse geocode", () => {
  it("treats a null address as 'ask them', not as an error", async () => {
    // The route always answers 200: no Mapbox token, junk coordinate, upstream non-2xx and timeout all
    // arrive as { address: null }. A rep with no signal needs the manual picker, not an error screen.
    const { fetcher, calls } = recording({ address: null });
    await expect(prospecting.reverseGeocode(fetcher, 21.3, -157.8)).resolves.toBeNull();
    expect(calls[0].path).toBe("/address/reverse");
    expect(calls[0].opts.query).toMatchObject({ lat: "21.3", lng: "-157.8" });
  });

  it("passes the canonical address through with its coordinates", async () => {
    const { fetcher } = recording({
      address: { id: "a1", label: "1420 Bishop St", address: "1420 Bishop St", city: "Dallas", state: "TX", zip: "75201", lat: 21.3, lng: -157.8 },
    });
    const res = await prospecting.reverseGeocode(fetcher, 21.3, -157.8);
    // The coordinates are what get stored on a newly created property; dropping them here is what
    // would leave it unfindable by distance on the next visit.
    expect(res).toMatchObject({ address: "1420 Bishop St", lat: 21.3, lng: -157.8 });
  });
});

describe("property match", () => {
  it("omits absent coordinates instead of sending them as empty strings", async () => {
    // Number("") is 0 server-side, so a blank lat would read as a point at the equator rather than as
    // an absent one — a bad position instead of no position.
    const { fetcher, calls } = recording({ matches: [] });
    await prospecting.matchProperties(fetcher, { lat: null, lng: null, address: "1420 Bishop St" });
    const query = calls[0].opts.query as Record<string, unknown>;
    expect(query.lat).toBeUndefined();
    expect(query.lng).toBeUndefined();
    expect(query.address).toBe("1420 Bishop St");
  });

  it("degrades to an empty list rather than undefined", async () => {
    const { fetcher } = recording({});
    await expect(prospecting.matchProperties(fetcher, { lat: 1, lng: 2 })).resolves.toEqual([]);
  });
});

describe("logActivity", () => {
  it("sends `type` and `body` — the names the server actually reads", async () => {
    // Sending activityType/notes made every note submission fail silently once already.
    const { fetcher, calls } = recording({ activity: { id: "a1" } });
    await prospecting.logActivity(fetcher, {
      propertyId: "p1",
      type: "site_visit",
      body: "Met the super",
      outcome: "Walk the roof next week",
    });
    expect(calls[0].path).toBe("/activities");
    expect(calls[0].opts.method).toBe("POST");
    expect(calls[0].opts.body).toMatchObject({
      propertyId: "p1",
      type: "site_visit",
      body: "Met the super",
    });
  });

  it("unwraps { activity }", async () => {
    const { fetcher } = recording({ activity: { id: "a1" } });
    await expect(prospecting.logActivity(fetcher, { propertyId: "p1", type: "note" })).resolves.toEqual({
      id: "a1",
    });
  });
});

describe("hasActivityTarget", () => {
  it("mirrors the server's 'Activity target is required'", () => {
    expect(prospecting.hasActivityTarget({})).toBe(false);
    expect(prospecting.hasActivityTarget({ propertyId: "p1" })).toBe(true);
    expect(prospecting.hasActivityTarget({ companyId: "c1" })).toBe(true);
    expect(prospecting.hasActivityTarget({ contactId: "ct1" })).toBe(true);
    expect(prospecting.hasActivityTarget({ dealId: "d1" })).toBe(true);
    expect(prospecting.hasActivityTarget({ leadId: "l1" })).toBe(true);
  });

  it("does not count an empty-string id as a target", () => {
    // An empty id would pass a truthiness check written carelessly and 400 at the server.
    expect(prospecting.hasActivityTarget({ propertyId: "" })).toBe(false);
  });
});

describe("contact field names", () => {
  it("sends jobTitle, not title", async () => {
    // The contacts service reads and persists `jobTitle`. An unknown `title` is forwarded and silently
    // dropped, so a rep types a role, sees no error, and the role is simply gone.
    const { fetcher, calls } = recording({ contact: { id: "ct1", firstName: "Dana", lastName: "Reyes" } });
    await prospecting.createContact(fetcher, {
      firstName: "Dana",
      lastName: "Reyes",
      category: "property_manager",
      jobTitle: "Property Manager",
    });
    const body = calls[0].opts.body as Record<string, unknown>;
    expect(body.jobTitle).toBe("Property Manager");
    expect(body.title).toBeUndefined();
  });
});

describe("company search", () => {
  it("does not query below two characters", async () => {
    // The fallback picker searches as the rep types; a one-character query returns most of the office
    // and costs a round trip on a truck's connection to do it.
    const { fetcher, calls } = recording({ companies: [] });
    await expect(prospecting.searchCompanies(fetcher, "a")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("unwraps { companies }", async () => {
    const { fetcher, calls } = recording({ companies: [{ id: "c1", name: "Palm Villas HOA" }] });
    await expect(prospecting.searchCompanies(fetcher, "palm")).resolves.toHaveLength(1);
    expect(calls[0].path).toBe("/companies/search");
    expect((calls[0].opts.query as Record<string, unknown>).q).toBe("palm");
  });
});

describe("contact search", () => {
  it("does not query below two characters", async () => {
    const { fetcher, calls } = recording({ contacts: [] });
    await expect(prospecting.searchContacts(fetcher, "a")).resolves.toEqual([]);
    expect(calls).toHaveLength(0);
  });

  it("reads GET /contacts?search= rather than inventing a second search route", async () => {
    // Deliberately the SAME list the Contacts tab reads: a dedicated route would be a second
    // definition of what "finding a person" means, and the two would drift.
    const { fetcher, calls } = recording({
      contacts: [{ id: "ct1", firstName: "Dana", lastName: "Reyes", companyName: "Palm Villas HOA" }],
    });
    await expect(prospecting.searchContacts(fetcher, "dana")).resolves.toHaveLength(1);
    expect(calls[0].path).toBe("/contacts");
    expect((calls[0].opts.query as Record<string, unknown>).search).toBe("dana");
  });

  it("survives a response with no contacts array", async () => {
    const { fetcher } = recording({});
    await expect(prospecting.searchContacts(fetcher, "dana")).resolves.toEqual([]);
  });
});

describe("activity source entity", () => {
  it("states the source explicitly so a contact cannot steal it from the property", async () => {
    // inferSourceEntity ranks contact ABOVE property, so attaching a newly created person re-anchored
    // the visit from the building to the person — changing what the record is about, and where it
    // shows, with nothing to notice.
    const { fetcher, calls } = recording({ activity: { id: "a1" } });
    await prospecting.logActivity(fetcher, {
      propertyId: "p1",
      companyId: "c1",
      contactId: "ct1",
      sourceEntityType: "property",
      sourceEntityId: "p1",
      type: "site_visit",
      body: "Met the super",
    });
    expect(calls[0].opts.body).toMatchObject({ sourceEntityType: "property", sourceEntityId: "p1" });
  });
});

describe("match query forwards every disproving signal", () => {
  it("sends city, state and zip", async () => {
    const { fetcher, calls } = recording({ matches: [] });
    await prospecting.matchProperties(fetcher, {
      lat: 21.3,
      lng: -157.8,
      address: "100 Main St",
      city: "Dallas",
      state: "TX",
      zip: "75201",
    });
    expect(calls[0].opts.query).toMatchObject({ city: "Dallas", state: "TX", zip: "75201" });
  });
});


describe("contactCompanyLabel — which employer is shown", () => {
  it("prefers the JOINED company over the free-text column", () => {
    // Both were present and disagreeing is the case that matters: the free-text field goes stale when a
    // contact is re-linked, and showing it labels the person with a former employer.
    expect(
      prospecting.contactCompanyLabel({
        id: "c1",
        firstName: "Dana",
        lastName: "Reyes",
        companyName: "Old Text Co",
        linkedCompanyName: "Palm Villas HOA",
      }),
    ).toBe("Palm Villas HOA");
  });

  it("falls back to the free-text column when there is no link", () => {
    expect(
      prospecting.contactCompanyLabel({
        id: "c1",
        firstName: "Dana",
        lastName: "Reyes",
        companyName: "Unlinked Co",
      }),
    ).toBe("Unlinked Co");
  });

  it("returns null when neither is known, so the caller can say so", () => {
    expect(
      prospecting.contactCompanyLabel({ id: "c1", firstName: "Dana", lastName: "Reyes" }),
    ).toBeNull();
  });
});

describe("createProperty", () => {
  it("forwards lat/lng — the whole point of creating it from a capture", () => {
    // properties.lat/lng existed for years with nothing writing them, so distance matching could never
    // find an API-created property. A capture that dropped them would recreate that defect exactly.
    const { fetcher, calls } = recording({ property: { id: "p1", name: "1420 Bishop St", companyId: "co1" } });
    return prospecting
      .createProperty(fetcher, {
        companyId: "co1",
        name: "1420 Bishop St",
        address: "1420 Bishop St",
        city: "Dallas",
        state: "TX",
        zip: "75201",
        lat: 32.7767,
        lng: -96.797,
      })
      .then(() => {
        const body = calls[0].opts.body as Record<string, unknown>;
        expect(body.lat).toBe(32.7767);
        expect(body.lng).toBe(-96.797);
        expect(calls[0].path).toBe("/properties");
      });
  });
});
