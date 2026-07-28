import { ApiError } from "../client";
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
    /** ZIP separates two identical street lines in the SAME city, which city and state cannot. */
    zip?: string | null;
  },
): Promise<PropertyMatch[]> {
  const res = await fetcher<{ matches: PropertyMatch[] }>("/properties/match", {
    query: {
      lat: params.lat != null ? String(params.lat) : undefined,
      lng: params.lng != null ? String(params.lng) : undefined,
      address: params.address?.trim() || undefined,
      city: params.city?.trim() || undefined,
      state: params.state?.trim() || undefined,
      zip: params.zip?.trim() || undefined,
    },
  });
  return res.matches ?? [];
}

/** GET /companies/search → `{ companies }`. The fallback target when no property matches. */
export async function searchCompanies(
  fetcher: Fetcher,
  query: string,
): Promise<CompanyRef[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await fetcher<{ companies: CompanyRef[] }>("/companies/search", { query: { q } });
  return res.companies ?? [];
}

/**
 * Search existing contacts for the fallback target.
 *
 * Reuses `GET /contacts?search=`, the same list the Contacts tab reads, rather than adding a search
 * route: this needs the identical matching, and a second endpoint would be a second definition of what
 * "finding a person" means.
 */
export async function searchContacts(fetcher: Fetcher, query: string): Promise<ContactRef[]> {
  const q = query.trim();
  if (q.length < 2) return [];
  const res = await fetcher<{ contacts: ContactRef[] }>("/contacts", {
    query: { search: q, limit: 10 },
  });
  return res.contacts ?? [];
}

/**
 * A person the server thinks the rep may have just re-entered.
 *
 * `companyName` and `email` are carried because the picker has to be CHOOSABLE: two people with the
 * same name render as two identical rows without them, and picking the wrong one attaches the visit to
 * the wrong person permanently. The server already returns both — dropping them here was what made the
 * prompt unanswerable. `isActive` is carried so a soft-deleted record is never offered.
 */
export type DedupSuggestion = {
  id: string;
  name?: string;
  firstName?: string;
  lastName?: string;
  companyName?: string | null;
  /**
   * Joined from companies, and the one to prefer.
   *
   * `companyName` is the contact's nullable free-text column; a linked contact often has nothing in it
   * — and every contact this screen creates sets only `companyId` — so two same-named people arrived
   * here with no company and no email, rendering as identical rows in a choice that is permanent.
   */
  linkedCompanyName?: string | null;
  email?: string | null;
  isActive?: boolean;
  matchReason?: string;
  /**
   * COMPANY suggestions carry these instead of an employer.
   *
   * They are duplicates precisely because their names agree, so the name alone cannot tell two of them
   * apart — and the server already returns the locality and a deal count, which do. Dropping them left
   * the rep choosing between identical rows in a decision the activity then carries.
   */
  address?: string | null;
  city?: string | null;
  state?: string | null;
  dealCount?: number;
};

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

export type CompanyRef = {
  id: string;
  name: string;
  /** Identifying context, because two companies can share a name and the choice is carried by the log. */
  category?: string | null;
  ownerUserName?: string | null;
};

/** POST /companies → 201 `{ company }`, or 200 `{ company: null, dedupWarning, suggestions }`. */
export async function createCompany(
  fetcher: Fetcher,
  input: {
    name: string;
    address?: string;
    city?: string;
    state?: string;
    zip?: string;
    category?: string;
    /**
     * Only ever set after the rep has SEEN the suggestions and said none is theirs.
     *
     * The server treats fuzzy matches as warnings and supports overriding them, but without an
     * override a net-new prospect whose company merely resembles an existing one could not be created
     * at all — and since the building control and the activity target both need a company, that rep
     * had no way to log the visit. Never sent on the first attempt: the prompt is the feature.
     */
    skipDedupCheck?: boolean;
  },
): Promise<CreateResult<CompanyRef>> {
  const body = await fetcher<Record<string, unknown>>("/companies", { method: "POST", body: input });
  return readCreateResult<CompanyRef>(body, "company");
}

/**
 * A person — created by a capture, or found by the fallback search.
 *
 * The company fields are optional because the two producers differ: `POST /contacts` echoes the record
 * it just wrote, while the search list carries the employer, which is what makes one Dana Reyes
 * distinguishable from another in a picker.
 */
export type ContactRef = {
  id: string;
  firstName: string;
  lastName: string;
  /**
   * TWO company names, and they are not interchangeable.
   *
   * `linkedCompanyName` is joined from the companies table and is authoritative; `companyName` is a
   * nullable free-text column that may be stale or empty on a linked contact. Reading only the free
   * text labelled linked people with the wrong employer or none at all — which defeats the whole point
   * of showing it, since it exists to tell two same-named people apart.
   */
  companyName?: string | null;
  linkedCompanyName?: string | null;
  companyId?: string | null;
};

/** The employer to show: authoritative first, free text only as a fallback. */
export function contactCompanyLabel(c: ContactRef): string | null {
  return c.linkedCompanyName ?? c.companyName ?? null;
}

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
    /**
     * `jobTitle`, NOT `title`. The contacts service reads and persists `jobTitle`; an unknown `title`
     * is forwarded and silently dropped, so the rep types a role and it vanishes with no error.
     */
    jobTitle?: string;
    phone?: string;
    mobile?: string;
    email?: string;
    companyId?: string;
    /**
     * Only after the rep has SEEN the suggestions and said none of them is this person.
     *
     * Mirrors the company path. Never sent on a first attempt — the prompt is the feature — but without
     * it a rep who meets a genuinely new John Smith at a different company cannot add him at all.
     */
    skipDedupCheck?: boolean;
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
    /**
     * REQUIRED, all four, because the server requires them.
     *
     * `createProperty` calls validatePropertyAddressFields unconditionally and 400s without any one of
     * these. Declaring them optional here meant a caller could satisfy the type with just companyId and
     * name, compile clean, and discover the refusal at runtime — after the rep had finished the
     * capture. The reverse geocode supplies all four, so requiring them costs nothing.
     */
    address: string;
    city: string;
    state: string;
    zip: string;
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

/**
 * WHICH entity the activity is ABOUT, sent explicitly.
 *
 * inferSourceEntity ranks lead > deal > contact > property > company, so attaching a newly created
 * person to a site visit silently re-anchored the visit from the PROPERTY to the CONTACT — changing
 * what the record means, and where it appears, with nothing to notice. The route accepts an explicit
 * `sourceEntityType`, so the capture states its intent rather than depending on that ordering.
 */
export type ActivitySourceEntityType = "property" | "company" | "contact" | "deal" | "lead";

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
    sourceEntityType?: ActivitySourceEntityType;
    sourceEntityId?: string;
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

