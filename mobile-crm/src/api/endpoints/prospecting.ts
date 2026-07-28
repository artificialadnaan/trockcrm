import type { Fetcher } from "./auth";

/**
 * Field prospecting — capture a visit where it happens.
 *
 * Every envelope here is pinned against its route handler rather than inferred from a sibling. Two of
 * them are actively misleading (see CreateResult), and this surface has already shipped three separate
 * defects from assuming one endpoint's shape matched the next.
 */

/** A Mapbox address, canonical enough to store on a property. */
export type GeocodedAddress = {
  id: string;
  label: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  lat?: number;
  lng?: number;
};

/**
 * GET /address/reverse → `{ address }`, and `address` is NULL far more often than it is an error.
 *
 * The route always answers 200: a missing Mapbox token, a junk coordinate, a non-2xx from Mapbox or a
 * timeout all arrive as `{ address: null }`. That is deliberate — a rep standing in front of a building
 * with no signal needs the manual address picker, not an error screen. So null here means "ask them",
 * never "something broke".
 */
export async function reverseGeocode(
  fetcher: Fetcher,
  lat: number,
  lng: number,
): Promise<GeocodedAddress | null> {
  const res = await fetcher<{ address: GeocodedAddress | null }>("/address/reverse", {
    query: { lat: String(lat), lng: String(lng) },
  });
  return res.address ?? null;
}

export type PropertyMatchReason = "address" | "distance" | "address+distance";

export type PropertyMatch = {
  id: string;
  name: string;
  address: string | null;
  city: string | null;
  state: string | null;
  zip: string | null;
  companyId: string;
  companyName: string | null;
  /** Metres from the rep. Null when the property has no stored coordinates — most of them, today. */
  distanceMeters: number | null;
  reason: PropertyMatchReason;
  /**
   * "exact" — same building AND unit. "base" — same building, with a suite named on only one side
   * (a legacy record storing the tenancy against a building-level geocode). null — reached by
   * proximity alone.
   *
   * Rendered, not decoration: "base" must read as "is this the one?" rather than as a settled answer,
   * because confirming the wrong tenancy in a tower attaches the visit to the neighbour.
   */
  addressMatch: "exact" | "base" | null;
};

/**
 * GET /properties/match → `{ matches }`, ranked, each carrying WHY it matched.
 *
 * The reason is rendered, not decoration: "same address" and "40 m away" are different claims, and a
 * rep asked to confirm a building deserves to know which one is being made. An unexplained guess is how
 * the wrong property gets confirmed.
 */
export async function matchProperties(
  fetcher: Fetcher,
  params: {
    lat?: number | null;
    lng?: number | null;
    address?: string | null;
    /** Sent so the server can DISPROVE a match — "100 Main St" exists in every city. */
    city?: string | null;
    state?: string | null;
  },
): Promise<PropertyMatch[]> {
  const res = await fetcher<{ matches: PropertyMatch[] }>("/properties/match", {
    query: {
      lat: params.lat != null ? String(params.lat) : undefined,
      lng: params.lng != null ? String(params.lng) : undefined,
      address: params.address?.trim() || undefined,
      city: params.city?.trim() || undefined,
      state: params.state?.trim() || undefined,
    },
  });
  return res.matches ?? [];
}

export type DedupSuggestion = { id: string; name?: string; firstName?: string; lastName?: string };

/**
 * THE TRAP ON BOTH CREATE ENDPOINTS, and the reason this is a discriminated union.
 *
 * `POST /contacts` and `POST /companies` answer **200** — not 201 — with `{ <entity>: null,
 * dedupWarning: true, suggestions }` when they suspect a duplicate. A client that treats 2xx as success
 * reads `company.id` off null and either crashes or, worse, carries `undefined` into the activity it
 * then creates, attaching a rep's visit to nothing.
 *
 * Modelled as a union so that is not expressible: a caller cannot reach the id without first deciding
 * what to do about the duplicates. And for prospecting that branch is a FEATURE — "did you mean Palm
 * Villas HOA?" is exactly what should happen when a rep types a company name that already exists, which
 * is why `skipDedupCheck` is deliberately not sent.
 */
export type CreateResult<T> =
  | { created: T; duplicates?: undefined }
  | { created?: undefined; duplicates: DedupSuggestion[] };

function readCreateResult<T>(
  body: Record<string, unknown>,
  key: "contact" | "company" | "property",
): CreateResult<T> {
  const entity = body[key];
  if (body.dedupWarning === true || entity == null) {
    const suggestions = Array.isArray(body.suggestions) ? (body.suggestions as DedupSuggestion[]) : [];
    return { duplicates: suggestions };
  }
  return { created: entity as T };
}

export type CompanyRef = { id: string; name: string };

/** POST /companies → 201 `{ company }`, or 200 `{ company: null, dedupWarning, suggestions }`. */
export async function createCompany(
  fetcher: Fetcher,
  input: { name: string; address?: string; city?: string; state?: string; zip?: string; category?: string },
): Promise<CreateResult<CompanyRef>> {
  const body = await fetcher<Record<string, unknown>>("/companies", { method: "POST", body: input });
  return readCreateResult<CompanyRef>(body, "company");
}

export type ContactRef = { id: string; firstName: string; lastName: string };

/**
 * POST /contacts → 201 `{ contact }`, or 200 `{ contact: null, dedupWarning, suggestions }`.
 *
 * `firstName`, `lastName` AND `category` are all required — the route 400s without them, and `category`
 * is the one that is easy to miss because no UI field obviously corresponds to it.
 */
export async function createContact(
  fetcher: Fetcher,
  input: {
    firstName: string;
    lastName: string;
    category: string;
    title?: string;
    phone?: string;
    mobile?: string;
    email?: string;
    companyId?: string;
  },
): Promise<CreateResult<ContactRef>> {
  const body = await fetcher<Record<string, unknown>>("/contacts", { method: "POST", body: input });
  return readCreateResult<ContactRef>(body, "contact");
}

export type PropertyRef = { id: string; name: string; companyId: string };

/**
 * POST /properties → 201 `{ property }`. No dedup branch on this one — which is exactly why
 * /properties/match exists and must be consulted first.
 *
 * `lat`/`lng` are sent whenever a geocode produced them. Nothing on the server's write path populated
 * these columns before, so every property created through the API has null coordinates: without this,
 * the building a rep creates today cannot be found by distance tomorrow and the next visit makes
 * another copy.
 */
export async function createProperty(
  fetcher: Fetcher,
  input: {
    companyId: string;
    name: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    lat?: number;
    lng?: number;
  },
): Promise<PropertyRef> {
  const res = await fetcher<{ property: PropertyRef }>("/properties", { method: "POST", body: input });
  return res.property;
}

/** What the rep did. Mirrors ACTIVITY_TYPES; only the ones a field capture produces are offered. */
export const FIELD_ACTIVITY_TYPES = ["site_visit", "call", "meeting", "voicemail", "note"] as const;
export type FieldActivityType = (typeof FIELD_ACTIVITY_TYPES)[number];

export type ActivityTarget = {
  propertyId?: string;
  companyId?: string;
  contactId?: string;
  dealId?: string;
  leadId?: string;
};

/**
 * POST /activities → `{ activity }`.
 *
 * AT LEAST ONE TARGET IS MANDATORY. `source_entity_type`/`source_entity_id` are NOT NULL and the route
 * infers them from whichever id is present, answering 400 "Activity target is required" when none is —
 * which is why the capture screen resolves a property before it will let the log be submitted.
 *
 * `type` is required too, and the server reads `type`/`body`; sending `activityType`/`notes` made every
 * note submission fail silently once already.
 */
export async function logActivity(
  fetcher: Fetcher,
  input: ActivityTarget & {
    type: FieldActivityType;
    subject?: string;
    body?: string;
    outcome?: string;
    nextStep?: string;
    nextStepDueAt?: string;
    occurredAt?: string;
  },
): Promise<{ id: string }> {
  const res = await fetcher<{ activity: { id: string } }>("/activities", {
    method: "POST",
    body: input,
  });
  return res.activity;
}

/** Does this capture have somewhere to attach? The client-side twin of the route's 400. */
export function hasActivityTarget(target: ActivityTarget): boolean {
  return Boolean(target.propertyId || target.companyId || target.contactId || target.dealId || target.leadId);
}

export type LeadRef = { id: string; name: string | null; leadNumber?: string | null };

/**
 * POST /leads → 201 `{ lead }`. Requires exactly companyId + propertyId + name.
 *
 * Those three are what a capture already produces, which is why promotion needs no new creation path:
 * the endpoint that owns every rule about what a lead IS stays the only thing that makes one.
 *
 * A 400 here is a REQUIREMENTS refusal, not a bug — createLead can reject with a coded
 * missingRequirements payload, and the screen shows it rather than a generic failure.
 */
export async function createLeadFromCapture(
  fetcher: Fetcher,
  input: { companyId: string; propertyId: string; name: string },
): Promise<LeadRef> {
  const res = await fetcher<{ lead: LeadRef }>("/leads", { method: "POST", body: input });
  return res.lead;
}

/**
 * POST /activities/:id/link-lead → `{ activity }`.
 *
 * The second half of promotion, and deliberately separate: see the server note. Not atomic with the
 * lead creation, so a failure here leaves a real lead that simply is not linked — which is why the
 * screen reports the lead as CREATED even when this step fails, rather than implying nothing happened.
 */
export async function linkActivityToLead(
  fetcher: Fetcher,
  activityId: string,
  leadId: string,
): Promise<void> {
  await fetcher(`/activities/${activityId}/link-lead`, { method: "POST", body: { leadId } });
}
