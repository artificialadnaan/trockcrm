import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  ActivityIndicator,
  AppState,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  TextInput,
  View,
} from "react-native";
import { SafeAreaView } from "react-native-safe-area-context";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../src/api/client";
import * as prospecting from "../../src/api/endpoints/prospecting";
import type { PropertyMatch } from "../../src/api/endpoints/prospecting";
import { useAuth } from "../../src/auth/AuthContext";
import { useGoBack } from "../../src/lib/go-back";
import { COARSE_ACCURACY_METERS, useCurrentLocation } from "../../src/lib/use-current-location";
import {
  canSubmit,
  haltsForDuplicates,
  leadFlagNextStep,
  personDetailsWillBeDiscarded,
  planContact,
  describeMatch,
  isPositionTooCoarse,
  submitBlockedReason,
  type CapturedAddress,
} from "../../src/prospect-state";
import { theme } from "../../src/theme/theme";

/**
 * Field prospecting — log a visit where it happens.
 *
 * The screen is arranged around ONE hard constraint: `activities.source_entity_type/id` are NOT NULL,
 * so a log has to attach to something before it can be saved. Standing at a property is what normally
 * supplies that, which is why the property step comes first and why GPS is not a nicety here.
 *
 * Everything after the property is OPTIONAL and progressive. A rep who has thirty seconds logs "site
 * visit, nobody in" and leaves; a rep who met the property manager fills in the person too. The form
 * never demands the long version, because a capture tool that insists gets used once.
 */
/**
 * Today as the rep sees it, in the server's date-only format.
 *
 * toISOString() gives the UTC calendar day: a rep in Texas flagging a visit at 7pm sends TOMORROW, and
 * a rep east of UTC early in the morning sends yesterday. "Due now" then lands on the wrong office day,
 * which is the one thing this value is for.
 */
function todayIsoDate(): string {
  const now = new Date();
  /**
   * LOCAL NOON, sent as a full timestamp.
   *
   * Two separate day-shifts had to be closed. toISOString() picks the UTC calendar day, so a rep in
   * Texas flagging at 7pm sent tomorrow. Fixing that alone still left a bare "YYYY-MM-DD", which the
   * server turns into midnight UTC — displaying as the PREVIOUS day in every negative-UTC office, so
   * July 28 queued as July 27. Anchoring at local noon puts the instant far enough from both midnights
   * that no offset in use can move it across a date boundary.
   */
  const noon = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 12, 0, 0, 0);
  return noon.toISOString();
}

const ACTIVITY_TYPES: Array<{ key: prospecting.FieldActivityType; label: string }> = [
  { key: "site_visit", label: "Site visit" },
  { key: "call", label: "Call" },
  { key: "meeting", label: "Meeting" },
  { key: "voicemail", label: "Voicemail" },
  { key: "note", label: "Note" },
];

export default function ProspectScreen() {
  const goBack = useGoBack("/(app)/(tabs)/dashboard");
  const { fetcher } = useAuth();
  const queryClient = useQueryClient();
  const location = useCurrentLocation();

  const [matches, setMatches] = useState<PropertyMatch[] | null>(null);
  const [address, setAddress] = useState<CapturedAddress | null>(null);
  const [property, setProperty] = useState<PropertyMatch | null>(null);
  const [matchError, setMatchError] = useState<string | null>(null);
  /**
   * The FALLBACK target. Without it the "no properties matched" state was a dead end: the copy told a
   * rep to log against a company or contact and the screen offered neither, so a visit to a building
   * the CRM has never seen could not be recorded at all — the exact case prospecting exists for.
   */
  const [company, setCompany] = useState<prospecting.CompanyRef | null>(null);
  /**
   * An EXISTING person as the target.
   *
   * The screen and the blocked-state copy both offered "a company or contact", but only a company
   * search existed — and the WHO fields create a person during the SAVE, so they cannot satisfy a gate
   * that runs before it. A visit about someone known, at a building the CRM has never seen, could not
   * be recorded at all.
   */
  const [contact, setContact] = useState<prospecting.ContactRef | null>(null);
  const [contactQuery, setContactQuery] = useState("");
  const contactQueryRef = useRef("");
  const contactSearchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [contactResults, setContactResults] = useState<prospecting.ContactRef[] | null>(null);
  const [contactSearchFailed, setContactSearchFailed] = useState(false);
  const [companyQuery, setCompanyQuery] = useState("");
  const companyQueryRef = useRef("");
  const searchTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [companyResults, setCompanyResults] = useState<prospecting.CompanyRef[] | null>(null);
  const [duplicateContacts, setDuplicateContacts] = useState<prospecting.DedupSuggestion[] | null>(null);
  /** The rep said none of the suggestions is the building — the fallback has to appear. */
  const [rejectedMatches, setRejectedMatches] = useState(false);
  const [companySearchFailed, setCompanySearchFailed] = useState(false);
  /** The person could not be saved, but the visit was. Reported, never silent. */
  const [contactFailed, setContactFailed] = useState(false);
  /** The person's write may or may not have landed — a dropped response, not a refusal. */
  const [contactIndeterminate, setContactIndeterminate] = useState(false);
  /**
   * A contact that was already COMMITTED, kept across retries.
   *
   * The id lived only in the mutation's local scope, so when the activity request failed after the
   * contact succeeded, a retry created the person again — and the dedup response for that same person
   * returns no id, so the activity then saved WITHOUT them. The rep types someone once and loses them
   * by retrying.
   */
  const createdContactId = useRef<{ id: string; key: string } | undefined>(undefined);
  /**
   * A duplicate the rep RESOLVED, and their decision to log without a person.
   *
   * Refs, not state: both are set in the same handler that resubmits, and mutationFn closes over the
   * render it was created in — reading these from state would run the resubmit against the values from
   * before the choice, which is the defect this whole block exists to prevent.
   */
  const resolvedContactId = useRef<string | null>(null);
  const contactWaived = useRef(false);
  /** Shown after the save so the rep can see which existing person the visit carries. */
  const [resolvedContactName, setResolvedContactName] = useState<string | null>(null);

  /**
   * Editing the person retires an unanswered duplicate prompt.
   *
   * The suggestions answer a question about the name that was submitted. Left on screen while the rep
   * types a different person, "Use" would attach the visit to someone the draft no longer names.
   */
  const editPerson = (setter: (next: string) => void) => (next: string) => {
    setDuplicateContacts(null);
    // The DECISIONS go too, not just the visible prompt. A failed activity write unlocks the draft, so
    // a rep who then corrects the name would otherwise retry with the previously picked person still
    // pinned — or with the waiver still set, silently skipping the person they just typed.
    resolvedContactId.current = null;
    contactWaived.current = false;
    setResolvedContactName(null);
    setter(next);
  };

  const [type, setType] = useState<prospecting.FieldActivityType | null>("site_visit");
  const [body, setBody] = useState("");
  const [outcome, setOutcome] = useState("");
  const [nextStep, setNextStep] = useState("");

  const [contactFirst, setContactFirst] = useState("");
  const [contactLast, setContactLast] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [contactTitle, setContactTitle] = useState("");

  const [savedActivityId, setSavedActivityId] = useState<string | null>(null);
  const saved = savedActivityId !== null;
  const [saveError, setSaveError] = useState<string | null>(null);

  /**
   * The activity's target, with its source entity STATED.
   *
   * inferSourceEntity ranks contact above property, so attaching a newly created person would
   * otherwise re-anchor a site visit from the building to the person — changing what the record is
   * about, and where it shows, with nothing to notice.
   */
  const target = useMemo(
    () =>
      property
        ? {
            propertyId: property.id,
            companyId: property.companyId,
            sourceEntityType: "property" as const,
            sourceEntityId: property.id,
          }
        : company
          ? { companyId: company.id, sourceEntityType: "company" as const, sourceEntityId: company.id }
          : contact
            ? {
                contactId: contact.id,
                // The person's employer rides along when known, so the visit still rolls up to a
                // company — but the SOURCE stays the contact, because that is what it was about.
                companyId: contact.companyId ?? undefined,
                sourceEntityType: "contact" as const,
                sourceEntityId: contact.id,
              }
            : {},
    [property, company, contact],
  );
  const blockedReason = submitBlockedReason({ target, type, body, outcome });
  const ready = canSubmit({ target, type, body, outcome });

  /** Find where the rep is, then ask the server which property that is. */
  const findProperty = useCallback(async () => {
    setMatchError(null);
    setMatches(null);
    await location.locate();
  }, [location]);

  const runMatch = useMutation({
    mutationFn: async (point: { lat: number; lng: number }) => {
      // Reverse geocode FIRST: its canonical address is both the strongest match signal and what gets
      // stored if the rep ends up creating the property. Its failure is not fatal — matching by
      // coordinates alone still works, it is just weaker.
      const geocoded = await prospecting.reverseGeocode(fetcher, point.lat, point.lng).catch(() => null);
      const found = await prospecting.matchProperties(fetcher, {
        lat: point.lat,
        lng: point.lng,
        address: geocoded?.address ?? null,
        city: geocoded?.city ?? null,
        state: geocoded?.state ?? null,
        // ZIP disproves an otherwise identical address in the same city — two "100 Main St" in
        // different postal areas. The server compares it; omitting it discarded that signal.
        zip: geocoded?.zip ?? null,
      });
      return { geocoded, found };
    },
    onSuccess: ({ geocoded, found }) => {
      setAddress(
        geocoded
          ? {
              address: geocoded.address,
              city: geocoded.city,
              state: geocoded.state,
              zip: geocoded.zip,
              lat: geocoded.lat,
              lng: geocoded.lng,
            }
          : null,
      );
      setMatches(found);
    },
    onError: (err) => {
      // RETRYABLE. The ref is cleared so a later fix — or the same one, re-requested — starts a fresh
      // lookup; leaving it set meant a transient failure locked the screen out of matching for good
      // while the location stayed "ready".
      matchedFor.current = null;
      // The rep is standing outside. A failed lookup must leave them able to log against a company or
      // contact instead, never stranded on a spinner.
      setMatchError(
        err instanceof ApiError && err.status === 0
          ? "No signal — you can still log this against a company or contact."
          : "Couldn't look up nearby properties.",
      );
    },
  });

  /**
   * Kick the match off as soon as a fix lands — from an EFFECT, not during render.
   *
   * The previous version called setState and started a network request in the render body. React may
   * render a component more than once for one commit (StrictMode does exactly that), so the request
   * could fire twice for a single fix, and starting external work before the render is committed is
   * the class of bug that appears only under concurrent rendering.
   */
  const fix = location.state.status === "ready" ? location.state : null;
  const fixKey = fix ? `${fix.lat},${fix.lng}` : null;
  const matchedFor = useRef<string | null>(null);
  useEffect(() => {
    if (!fixKey || !fix) return;
    if (matchedFor.current === fixKey) return;
    matchedFor.current = fixKey;
    runMatch.mutate({ lat: fix.lat, lng: fix.lng });
    // runMatch identity is stable for the mutation's lifetime; keying on the fix is the real trigger.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixKey]);

  /**
   * Company search, with the response tied to the query that asked for it.
   *
   * Every keystroke starts an independent request and they do not finish in order — on a slow
   * connection "pal" can land after "palm villas" and replace the right answers with stale ones. The
   * query travels with the result so a late response for an abandoned query is dropped.
   *
   * A FAILURE is also not an empty result. Storing [] for a network error told the rep "no companies
   * match", which is a factual claim the app has no basis for and which sends them off to the web to
   * create a company that already exists.
   */
  const findCompanies = useMutation({
    mutationFn: async (q: string) => ({ q, results: await prospecting.searchCompanies(fetcher, q) }),
    onSuccess: ({ q, results }) => {
      if (q.trim() !== companyQueryRef.current.trim()) return;
      setCompanyResults(results);
      setCompanySearchFailed(false);
    },
    onError: (_err, q) => {
      // Successes were already checked against the live query; failures were not, so an abandoned
      // request could paint an error over results the rep is currently reading.
      if (q.trim() !== companyQueryRef.current.trim()) return;
      setCompanyResults(null);
      setCompanySearchFailed(true);
    },
  });

  /** The contact fallback's search. Mirrors findCompanies, including its late-response discipline. */
  const findContacts = useMutation({
    mutationFn: async (q: string) => ({ q, results: await prospecting.searchContacts(fetcher, q) }),
    onSuccess: ({ q, results }) => {
      if (q.trim() !== contactQueryRef.current.trim()) return;
      setContactResults(results);
      setContactSearchFailed(false);
    },
    onError: (_err, q) => {
      if (q.trim() !== contactQueryRef.current.trim()) return;
      setContactResults(null);
      setContactSearchFailed(true);
    },
  });

  /**
   * ADD THE BUILDING the CRM has never seen.
   *
   * Without this the core prospecting case had no path at all: location resolves, /properties/match
   * returns nothing, and the rep is told to attach the visit to a company — so the address and
   * coordinates the capture just worked out are discarded, and the building stays unknown for the next
   * rep too. `createProperty` existed and nothing called it.
   *
   * Needs a company, because properties belong to one — so this appears only once the rep has chosen
   * one from the fallback search. The new property is written WITH its coordinates, which is what makes
   * it findable by the next capture rather than a duplicate waiting to happen.
   */
  const [createPropertyError, setCreatePropertyError] = useState<string | null>(null);
  /**
   * Create the company a net-new prospect belongs to.
   *
   * Same dedup discipline as the contact path: `POST /companies` answers 200 with suggestions rather
   * than 201 when it suspects a duplicate, so a 2xx is not a success and the prompt is the useful
   * outcome — a rep at a door should be shown the existing company, not given a second one.
   */
  const [duplicateCompanies, setDuplicateCompanies] = useState<prospecting.DedupSuggestion[] | null>(
    null,
  );
  const [createCompanyError, setCreateCompanyError] = useState<string | null>(null);

  /**
   * The address, typed, for when the geocode could not supply one.
   *
   * reverseGeocode returns null by DESIGN on a missing token, a timeout or a non-2xx — the degradation
   * the endpoint documents. That is precisely when a rep is standing at a building the CRM has never
   * seen, so leaving the create control gated on the geocode removed the only way to capture it.
   */
  const [manualAddress, setManualAddress] = useState("");
  const [manualCity, setManualCity] = useState("");
  const [manualState, setManualState] = useState("");
  const [manualZip, setManualZip] = useState("");

  /**
   * Did the GEOCODE give us a usable address? Distinct from `effectiveAddress`, and the distinction
   * matters: keying the input block on `!effectiveAddress` unmounted it the instant the fourth field
   * was filled, so the last keystroke of the ZIP dropped the keyboard and removed every control that
   * could fix a typo. The fields stay mounted for as long as the geocode has not supplied an address.
   */
  const geocodeComplete = Boolean(
    address?.address && address.city && address.state && address.zip,
  );

  /** Whatever address we actually have: the geocode first, the rep's typing second. */
  const effectiveAddress = useMemo(() => {
    if (address?.address && address.city && address.state && address.zip) return address;
    const typed = {
      address: manualAddress.trim(),
      city: manualCity.trim(),
      state: manualState.trim().toUpperCase(),
      zip: manualZip.trim(),
    };
    if (!typed.address || !typed.city || !typed.state || !typed.zip) return null;
    /**
     * Coordinates come from the GPS FIX, not from `address`.
     *
     * When reverse geocoding fails, `address` is set to null — and reading the coordinates off it meant
     * a manually typed building was stored with none at all. That is the precise defect this feature
     * exists to end: properties.lat/lng went years with nothing writing them, so distance matching
     * could never find an API-created property. The rep is standing here either way; the geocode
     * failing says nothing about where they are.
     */
    return { ...typed, lat: fix?.lat ?? address?.lat ?? null, lng: fix?.lng ?? address?.lng ?? null };
  }, [address, fix, manualAddress, manualCity, manualState, manualZip]);
  const createCompanyNamed = useMutation({
    mutationFn: async (input: { name: string; force?: boolean }) =>
      prospecting.createCompany(fetcher, {
        name: input.name,
        // Only after the rep has seen the suggestions and rejected them.
        skipDedupCheck: input.force || undefined,
      }),
    onSuccess: async (result) => {
      if (!result.created) {
        setDuplicateCompanies(result.duplicates ?? []);
        setCreateCompanyError(
          result.duplicates?.length ? null : "Couldn't add that company — try a different name.",
        );
        return;
      }
      setDuplicateCompanies(null);
      setCreateCompanyError(null);
      setCompany(result.created);
      setCompanyResults(null);
      setCompanyQuery("");
      companyQueryRef.current = "";
      await queryClient.invalidateQueries({ queryKey: ["companies"] });
    },
    onError: (err) => {
      setCreateCompanyError(
        err instanceof ApiError && (err.status === 0 || err.status === 408)
          ? "No signal — that company may or may not have been added. Check before adding it again."
          : err instanceof ApiError
            ? err.message
            : "Couldn't add that company.",
      );
    },
  });

  const createPropertyHere = useMutation({
    mutationFn: async () => {
      // Read ONCE, before the await. Both are state and can change under a slow request, and what
      // onSuccess writes into the target has to describe what was actually created.
      const under = company;
      const at = effectiveAddress;
      if (!under || !at?.address || !at.city || !at.state || !at.zip) {
        throw new Error("A company and a full address are needed to add a building.");
      }
      const created = await prospecting.createProperty(fetcher, {
        companyId: under.id,
        // The street line is the honest default name; it can be renamed on the web.
        name: at.address,
        address: at.address,
        city: at.city,
        state: at.state,
        zip: at.zip,
        // Written WITH coordinates — that is what makes it findable by the next capture instead of
        // becoming the duplicate this feature exists to prevent.
        lat: at.lat ?? undefined,
        lng: at.lng ?? undefined,
      });
      return { created, at, under };
    },
    onSuccess: async ({ created, at, under }) => {
      /**
       * POST /properties has NO dedup branch — it creates unconditionally, which is exactly why
       * /properties/match runs first and why this control appears only after it came back empty.
       */
      setCreatePropertyError(null);
      setProperty({
        id: created.id,
        name: created.name,
        address: at.address,
        city: at.city,
        state: at.state,
        zip: at.zip,
        companyId: created.companyId,
        companyName: under.name,
        // Zero: the rep is standing on it, and it was stored with these coordinates.
        distanceMeters: 0,
        reason: "address",
        addressMatch: "exact",
      });
      await queryClient.invalidateQueries({ queryKey: ["properties"] });
    },
    onError: (err) => {
      setCreatePropertyError(
        err instanceof ApiError && (err.status === 0 || err.status === 408)
          ? "No signal — this building may or may not have been added. Check before adding it again."
          : err instanceof ApiError
            ? err.message
            : "Couldn't add this building.",
      );
    },
  });

  const save = useMutation({
    mutationFn: async () => {
      let contactId: string | undefined;
      let duplicates: prospecting.DedupSuggestion[] | null = null;
      let contactFailed = false;
      let contactIndeterminate = false;
      const first = contactFirst.trim();
      const last = contactLast.trim();
      /**
       * The person block creates a REAL contact, and only when it is filled.
       *
       * A duplicate answer is not a failure — `POST /contacts` replies 200 with suggestions rather than
       * 201, and that prompt is the useful outcome: a rep who meets the same property manager twice
       * should be asked which one, not silently given a second record.
       *
       * Every rule about WHICH contact — reuse one already committed, drop it once the draft describes
       * someone (or something) different, honour a picked duplicate, respect a waiver — is decided by
       * planContact, which is unit-tested. Deciding it inline here is what produced three separate
       * defects on this screen.
       *
       * The key covers EVERY editable field, not just the name: keyed on the name alone, fixing a
       * mistyped phone number before retrying read as unchanged, so the retry reused the committed
       * contact and the correction the rep was looking at was never sent anywhere.
       */
      const contactKey = [
        first.toLowerCase(),
        last.toLowerCase(),
        contactPhone.trim(),
        contactTitle.trim().toLowerCase(),
        property?.companyId ?? company?.id ?? "",
      ].join("|");
      /**
       * When the TARGET is a person, that person IS the activity's contact — full stop.
       *
       * The service rejects a contactId that disagrees with sourceEntityId, so creating a second person
       * from the WHO fields produced an unsaveable activity AFTER committing them: a new contact
       * stranded in the directory and a visit that could not be logged at all. The WHO block is hidden
       * in this mode for the same reason, so the two can never name different people.
       *
       * This sets the id and falls through to the SINGLE write below. An earlier version returned early
       * with its own copy of the logActivity call, which meant two payloads to keep in step — and the
       * next field added to one of them would have been silently missing from the other.
       */
      if (contact) {
        contactId = contact.id;
      } else {
        const { plan, dropRetained } = planContact({
          first,
          last,
          key: contactKey,
          resolvedContactId: resolvedContactId.current,
          waived: contactWaived.current,
          retained: createdContactId.current,
        });
        if (dropRetained) createdContactId.current = undefined;
        if (plan.action === "reuse") contactId = plan.contactId;

        if (plan.action === "create") {
          /**
           * The PERSON is optional; the VISIT is not.
           *
           * A throw here aborted the whole mutation, so a contacts outage or a validation refusal took
           * the site visit down with it — the opposite of what the docblock promised, and the wrong
           * trade: the rep is standing outside and the log is the thing that must survive.
           */
          try {
            const created = await prospecting.createContact(fetcher, {
              firstName: first,
              lastName: last,
              /**
               * NEUTRAL, because the screen never asks.
               *
               * Reps meet vendors, architects, subcontractors and regional managers too, and stamping
               * every one of them "property_manager" quietly corrupted the directory and every filter
               * built on it. "other" is the honest answer to a question not asked; the real category is
               * set on the web, where the choice exists.
               */
              category: "other",
              jobTitle: contactTitle.trim() || undefined,
              mobile: contactPhone.trim() || undefined,
              // The FALLBACK company counts too. Without it a person met at a building the CRM has never
              // seen was created with no company at all — the one case where the link matters most.
              companyId: property?.companyId ?? company?.id,
            });
            contactId = created.created?.id;
            if (contactId) createdContactId.current = { id: contactId, key: contactKey };
            duplicates = created.duplicates ?? null;
            /**
             * STOP. Do not write the activity yet.
             *
             * A dedup reply carries no new id but it DOES carry the ids of the people it matched, so the
             * person is knowable — and logging here attached the visit to nobody while the screen said
             * "Logged". That is unrecoverable: /activities has no update path in this app, so a rep who
             * meets a property manager the CRM already knows loses them silently, which is precisely the
             * case the prompt exists to catch. Hand the choice back instead.
             */
          /**
           * A null contact with NO suggestions is a refusal we cannot explain — and it must not pass
           * silently. readCreateResult maps `{ contact: null }` to `duplicates: []`, which halts
           * nothing, so the save continued with no contactId, no warning, and a screen saying "Logged":
           * the person the rep typed vanished with nothing to indicate it. Reported as a failed person,
           * which is exactly what it is.
           */
          if (!contactId && !duplicates?.length) contactFailed = true;

            if (haltsForDuplicates({ createdId: contactId, duplicates })) {
              return {
                activity: null,
                duplicates,
                contactFailed: false,
                contactIndeterminate: false,
              } as const;
            }
          } catch (err) {
            /**
             * A DROPPED RESPONSE IS NOT A FAILED WRITE — the same rule the activity save already follows.
             *
             * On status 0/408 the contact may well have been committed. Reporting a definite failure sent
             * the rep off to create that person a second time, so a weak signal produced an orphaned
             * contact plus a duplicate. The VISIT still goes through either way; only the wording of what
             * happened to the person changes.
             */
            contactFailed = true;
            contactIndeterminate =
              err instanceof ApiError && (err.status === 0 || err.status === 408);
          }
        }
      }

      const activity = await prospecting.logActivity(fetcher, {
        ...target,
        contactId,
        type: type!,
        body: body.trim() || undefined,
        outcome: outcome.trim() || undefined,
        /**
         * The flag and the rep's own next step share one column, so the flag WINS and carries their
         * text with it rather than discarding either. Sending only "Create lead" would throw away what
         * they typed; sending only their text would lose the flag the office reads.
         */
        nextStep: leadFlagNextStep({ flagged: flagForLead, nextStep }),
        nextStepDueAt: flagForLead ? todayIsoDate() : undefined,
      });
      // State moves to the callbacks — mutationFn can run twice under React's concurrent rendering,
      // and a setState there is a side effect in a function that is not allowed to have one.
      return { activity, duplicates, contactFailed, contactIndeterminate };
    },
    onSuccess: async ({ activity, duplicates, contactFailed, contactIndeterminate }) => {
      setDuplicateContacts(duplicates);
      setContactFailed(contactFailed);
      setContactIndeterminate(contactIndeterminate);
      // Halted on a duplicate: nothing was written, so the draft stays live and editable and the picker
      // below asks who this is. Reporting "Logged" here is the defect.
      if (!activity) {
        setSaveError(null);
        return;
      }
      setSavedActivityId(activity.id);
      setSaveError(null);
      // The property's activity feed and any list showing last-touch are now stale.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["properties"] }),
        queryClient.invalidateQueries({ queryKey: ["activities"] }),
        // A save can create a CONTACT, and the directory is cached separately — without this the person
        // a rep just added is missing from Contacts until the cache expires.
        queryClient.invalidateQueries({ queryKey: ["contacts"] }),
      ]);
    },
    onError: (err) => {
      setSavedActivityId(null);
      /**
       * A DROPPED RESPONSE IS NOT A FAILED SAVE.
       *
       * status 0 means the request never completed from our side — the server may well have committed
       * it. Telling a rep "this didn't save, try again" turns every weak-signal moment into a second
       * identical activity, and /activities has no idempotency key to collapse them. Saying the
       * outcome is unknown is the honest version, and it puts the check before the retry.
       */
      setSaveError(
        err instanceof ApiError && (err.status === 0 || err.status === 408)
          ? "No signal — this may or may not have saved. Check the property's activity before logging it again."
          : err instanceof ApiError
            ? err.message
            : "Couldn't save this log.",
      );
    },
  });

  /**
   * The draft is FROZEN once it is in flight or written.
   *
   * The mutation captured the values from the render that submitted it, and there is no update request
   * behind this screen. Left live, a rep on a slow connection could keep typing after tapping Save — or
   * fix a typo after "Logged" — and read their correction on screen while the server held the earlier
   * text. "Log another here" then wiped the edit without it ever having been sent.
   */
  const locked = save.isPending || saved;
  /** Save is unavailable while the building is still being written, too — see the button below. */
  const saveBlocked = !ready || save.isPending || createPropertyHere.isPending;

  /** Person details the save will discard, because a contact needs BOTH names to be created. */
  const personPartial = personDetailsWillBeDiscarded({
    first: contactFirst,
    last: contactLast,
    phone: contactPhone,
    title: contactTitle,
  });

  /**
   * FLAGGED FOR A LEAD, rather than promoted into one.
   *
   * Creating the lead here is not possible honestly. `createLead` is reached only through POST /leads,
   * which calls assertLeadCreateRequirements unconditionally, and three of the fields it demands cannot
   * be known at a door: `bidDueDate` (a cold stop has no bid), `property.buildYear` and
   * `property.unitCount`. A form on the phone would therefore be a form for INVENTING them — fabricated
   * values in exactly the fields due-diligence and bid workflows read. Relaxing the gate is the same
   * trade wearing a different hat: leads in the pipeline that meet none of the rules every other lead
   * meets.
   *
   * So the rep marks the prospect and the office builds the lead, where those facts are knowable. This
   * writes `nextStep`/`nextStepDueAt` on the activity itself — both already in the payload, so no
   * migration and no second endpoint — and it is set AT CREATION because /activities has no update
   * route.
   */
  const [flagForLead, setFlagForLead] = useState(false);

  /**
   * Re-check permission when the app comes back to the foreground.
   *
   * The denied state sends a rep to Settings and then never looks again, so granting it there returned
   * them to the same dead screen — the instruction worked and the app pretended it had not.
   */
  // Clear a pending search on unmount. A timer that fires after the screen is gone starts a request
  // nobody will read and resolves into a component that no longer exists.
  useEffect(() => () => {
    if (searchTimer.current) clearTimeout(searchTimer.current);
    if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
  }, []);

  /**
   * Re-check permission when the app comes back to the foreground.
   *
   * Keyed on the STATUS and the stable `locate`, not the hook object: useCurrentLocation returns a new
   * object every render, so `[location]` never compared equal and this listener was torn down and
   * re-added on every keystroke in the note field.
   */
  const locationStatus = location.state.status;
  const locate = location.locate;
  useEffect(() => {
    const sub = AppState.addEventListener("change", (next) => {
      if (next === "active" && locationStatus === "denied") void locate();
    });
    return () => sub.remove();
  }, [locationStatus, locate]);

  // Resolved once. `coarse` is already false unless the fix is ready, so re-checking the status inside
  // the message could never take its fallback branch — dead code that read as a guard.
  const coarseAccuracy = location.state.status === "ready" ? location.state.accuracyMeters ?? 0 : 0;
  const coarse =
    location.state.status === "ready" &&
    isPositionTooCoarse(location.state.accuracyMeters, COARSE_ACCURACY_METERS);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          testID="prospect-back"
          /* Locked WHILE SAVING only, not after. The request is not idempotent and leaving does not
             cancel it, so a rep who walks away mid-write never sees the outcome — including the
             "may or may not have saved" case — and logs the visit again. Once it has settled, leaving
             is fine. */
          disabled={save.isPending}
          onPress={() => goBack()}
          accessibilityRole="button"
          accessibilityLabel="Back"
          hitSlop={12}
          style={styles.backBtn}
        >
          <Text style={styles.backChevron}>‹</Text>
        </Pressable>
        <Text style={styles.headerTitle}>LOG A VISIT</Text>
        <View style={styles.headerSpacer} />
      </View>

      <ScrollView contentContainerStyle={styles.body} keyboardShouldPersistTaps="handled">
        {/* ---- 1. WHERE. The only mandatory part, because the server requires a target. ---- */}
        <Text style={styles.stepLabel}>WHERE</Text>

        {property ? (
          <View style={styles.chosenCard}>
            <Text style={styles.chosenName}>{property.name}</Text>
            <Text style={styles.chosenMeta}>
              {[property.address, property.city].filter(Boolean).join(", ") || "No address on file"}
            </Text>
            {property.companyName ? (
              <Text style={styles.chosenCompany}>{property.companyName}</Text>
            ) : null}
            {/* FROZEN once the activity is saved.
                Left active, a rep could save the visit against this property, change to another, and
                promote THAT one — creating a lead for a building they never logged, with the activity
                still pointing at the first. The target the log committed to is not editable after the
                fact; logging another visit here starts a fresh capture. */}
            {saved || save.isPending ? null : (
              <Pressable
                testID="prospect-change-property"
                onPress={() => {
                  setProperty(null);
                  setMatches(null);
                  setRejectedMatches(false);
                  // The COMPANY goes too. Leaving it selected while hiding the fallback UI let the
                  // computed target silently fall back to it: Save stayed enabled and would attach the
                  // visit to an entity the screen was no longer showing.
                  setCompany(null);
                  // The CONTACT target goes with it, for the same reason and by the same mechanism:
                  // Change hides the fallback UI, so a contact left selected became an invisible
                  // target that kept Save enabled and filed the visit against someone off screen.
                  setContact(null);
                  setContactQuery("");
                  contactQueryRef.current = "";
                  setContactResults(null);
                  setCompanyResults(null);
                  setCompanyQuery("");
                  companyQueryRef.current = "";
                  matchedFor.current = null;
                  location.reset();
                }}
                accessibilityRole="button"
                style={styles.linkBtn}
              >
                <Text style={styles.linkText}>Change</Text>
              </Pressable>
            )}
          </View>
        ) : (
          <View style={styles.card}>
            {location.state.status === "idle" ? (
              <>
                <Text style={styles.help}>
                  Use your location to find the building you&apos;re at, so you don&apos;t have to type
                  the address.
                </Text>
                <Pressable
                  testID="prospect-locate"
                  onPress={() => void findProperty()}
                  accessibilityRole="button"
                  style={styles.primaryBtn}
                >
                  <Text style={styles.primaryText}>Find this property</Text>
                </Pressable>
                {/* GPS IS NOT ALWAYS THE POINT.
                    Half the types here — call, voicemail, meeting — happen nowhere near the building,
                    and routing them through a location lookup makes a rep in a truck wait on a fix
                    they do not need and cannot use. The company path is offered from the start rather
                    than only after a failed or rejected match. */}
                <Pressable
                  testID="prospect-skip-location"
                  onPress={() => setRejectedMatches(true)}
                  accessibilityRole="button"
                  style={styles.linkBtn}
                >
                  <Text style={styles.linkText}>Not at a property — attach to a company</Text>
                </Pressable>
              </>
            ) : location.state.status === "locating" || runMatch.isPending ? (
              <View style={styles.centerRow}>
                <ActivityIndicator color={theme.color.brandRed} />
                <Text style={styles.help}>Finding where you are…</Text>
              </View>
            ) : location.state.status === "denied" ? (
              /* Denied is NOT retryable in-app — a retry button here does nothing, which reads as
                 broken. Say where the switch actually is, and keep the manual path open. */
              <Text testID="prospect-denied" style={styles.help}>
                Location is off for T-Rock CRM. Turn it on in Settings → Privacy → Location Services, or
                attach this log to a company or contact instead.
              </Text>
            ) : location.state.status === "unavailable" ? (
              <>
                <Text testID="prospect-unavailable" style={styles.help}>
                  {location.state.reason}
                </Text>
                <Pressable
                  testID="prospect-retry-locate"
                  onPress={() => void findProperty()}
                  accessibilityRole="button"
                  style={styles.secondaryBtn}
                >
                  <Text style={styles.secondaryText}>Try again</Text>
                </Pressable>
              </>
            ) : null}

            {coarse ? (
              /* A fix wider than the matcher's own radius makes "the property you're at" a guess. Say
                 so rather than presenting the nearest building as an answer. */
              <Text testID="prospect-coarse" style={styles.warn}>
                Your position is only accurate to about {Math.round(coarseAccuracy)} m —
                double-check the building before you confirm it.
              </Text>
            ) : null}

            {matchError ? (
              <>
                <Text style={styles.warn}>{matchError}</Text>
                {/* A REAL retry. Clearing the guard ref does nothing on its own: the effect keys on
                    the fix, which does not change while the location stays "ready", so a transient
                    lookup failure disabled matching for the rest of the session and pushed the rep
                    onto the company fallback permanently. This re-runs the lookup directly. */}
                {fix ? (
                  <Pressable
                    testID="prospect-retry-match"
                    onPress={() => {
                      setMatchError(null);
                      matchedFor.current = null;
                      runMatch.mutate({ lat: fix.lat, lng: fix.lng });
                    }}
                    accessibilityRole="button"
                    style={styles.secondaryBtn}
                  >
                    <Text style={styles.secondaryText}>Look again</Text>
                  </Pressable>
                ) : null}
              </>
            ) : null}

            {matches?.length ? (
              <View style={styles.matchList}>
                <Text style={styles.help}>Is this the property?</Text>
                {matches.map((m) => (
                  <Pressable
                    key={m.id}
                    testID={`prospect-match-${m.id}`}
                    onPress={() => {
                      setProperty(m);
                      /* The THIRD way to change the target, and it needs the same cleanup as the other
                         two: with a fallback contact still selected, the memo resolves to the property
                         while the contact branch keeps saying "filed against" that person and submits
                         a target without their id — dropping the association the screen claims. */
                      setContact(null);
                      setContactQuery("");
                      contactQueryRef.current = "";
                      setContactResults(null);
                    }}
                    /* The THIRD target control, frozen with the property and company ones. A rep who
                       rejected the matches, logged against a company, then tapped a match still on
                       screen changed the displayed target after the write — and enabled promotion for a
                       property that was never part of the saved capture. */
                    disabled={locked}
                    accessibilityRole="button"
                    accessibilityState={{ disabled: locked }}
                    accessibilityLabel={`${m.name}, ${describeMatch(m)}`}
                    style={[styles.matchRow, locked && styles.chipLocked]}
                  >
                    <View style={styles.matchBody}>
                      <Text style={styles.matchName} numberOfLines={1}>
                        {m.name}
                      </Text>
                      <Text style={styles.matchMeta} numberOfLines={1}>
                        {[m.address, m.city].filter(Boolean).join(", ") || "No address on file"}
                      </Text>
                    </View>
                    {/* WHY it is being offered. "Same address" and "40 m away" are different claims, and
                        an unexplained suggestion is how the wrong property gets confirmed. */}
                    <Text style={styles.matchReason}>{describeMatch(m)}</Text>
                  </Pressable>
                ))}
                {/* The escape hatch. With candidates on screen the company fallback was hidden, so a
                    rep whose building is simply not among them had no way forward — the suggestions
                    became a set of wrong answers with no "none of these". */}
                <Pressable
                  testID="prospect-reject-matches"
                  onPress={() => setRejectedMatches(true)}
                  disabled={locked}
                  accessibilityRole="button"
                  style={styles.linkBtn}
                >
                  <Text style={styles.linkText}>None of these — attach to a company</Text>
                </Pressable>
              </View>
            ) : matches?.length === 0 ? (
              <Text testID="prospect-no-matches" style={styles.help}>
                {address
                  ? `Nothing on file at ${address.address}.`
                  : "No properties matched here."}{" "}
                Attach this to a company instead.
              </Text>
            ) : null}

            {/* THE FALLBACK, and it is not optional garnish.
                A rep at a building the CRM has never seen still has a visit worth recording, and the
                server refuses an activity with no target. Without a company picker the "nothing
                matched" state was a dead end that told them to do something the screen did not offer —
                which is the case field prospecting exists for in the first place. */}
            {matches?.length === 0 ||
            rejectedMatches ||
            location.state.status === "denied" ||
            // unavailable too: services off device-wide, or a fix that errored. Without this the rep
            // was left with a "try again" that may never succeed and no other way to record the visit.
            location.state.status === "unavailable" ||
            matchError ? (
              <View style={styles.matchList}>
                {company ? (
                  <View style={styles.matchRow}>
                    <View style={styles.matchBody}>
                      <Text style={styles.matchName} numberOfLines={1}>
                        {company.name}
                      </Text>
                      <Text style={styles.matchMeta}>Company</Text>
                    </View>
                    {/* Frozen on the same states as the property target above. Left live, a rep could
                        switch companies mid-save and read the NEW company beside "Logged" while the
                        activity carried the old one. */}
                    {locked ? null : (
                      <Pressable
                        testID="prospect-clear-company"
                        onPress={() => setCompany(null)}
                        accessibilityRole="button"
                        accessibilityLabel="Choose a different company"
                        style={styles.linkBtn}
                      >
                        <Text style={styles.linkText}>Change</Text>
                      </Pressable>
                    )}
                  </View>
                ) : (
                  <>
                    <TextInput
                      testID="prospect-company-search"
                      editable={!locked}
                      value={companyQuery}
                      onChangeText={(next) => {
                        setCompanyQuery(next);
                        companyQueryRef.current = next;
                        setCompanySearchFailed(false);
                        // Results for the PREVIOUS query are wrong the moment the text changes, and
                        // they stayed tappable through the debounce and the next round trip — long
                        // enough to attach the visit to a company the screen was no longer describing.
                        setCompanyResults(null);
                        // The dedup ANSWER goes with them. Typing "Palm", tapping Add, then retyping
                        // "Ocean Ridge" left the Palm suggestions on screen and tappable under a prompt
                        // about a name the draft no longer contained.
                        setDuplicateCompanies(null);
                        setCreateCompanyError(null);
                        /* DEBOUNCED. One request per keystroke sent ten for "palm villas" — on a
                           truck's connection that is ten round trips racing each other to answer a
                           query the rep has already moved past. 250ms matches the web's own
                           address-autocomplete debounce. */
                        if (searchTimer.current) clearTimeout(searchTimer.current);
                        if (next.trim().length >= 2) {
                          searchTimer.current = setTimeout(() => findCompanies.mutate(next), 250);
                        } else {
                          setCompanyResults(null);
                        }
                      }}
                      placeholder="Search companies"
                      placeholderTextColor={theme.color.textMuted}
                      autoCapitalize="words"
                      autoCorrect={false}
                      style={styles.input}
                    />
                    {findCompanies.isPending ? (
                      <ActivityIndicator color={theme.color.brandRed} />
                    ) : null}
                    {companyResults?.map((c) => (
                      <Pressable
                        key={c.id}
                        testID={`prospect-company-${c.id}`}
                        onPress={() => {
                          setCompany(c);
                          setCompanyResults(null);
                          setCompanyQuery("");
                          /* ONE target. Both pickers stay on screen, so a rep could select a company
                             and then a person and leave both set — and since the target memo ranks
                             company first while the contact branch submits that same memo, the screen
                             showed the person while the saved activity carried no contactId at all. */
                          setContact(null);
                          setContactQuery("");
                          contactQueryRef.current = "";
                          setContactResults(null);
                        }}
                        /* These rows ignored `locked`, so after a contact-backed save a leftover
                           company result was still tappable — the screen would then show a company the
                           committed activity never carried, and "Log another" kept it. */
                        disabled={locked}
                        accessibilityRole="button"
                        accessibilityLabel={`Attach this visit to ${c.name}`}
                        style={styles.matchRow}
                      >
                        <View style={styles.matchBody}>
                          <Text style={styles.matchName} numberOfLines={1}>
                            {c.name}
                          </Text>
                          {/* Two companies can share a name, and identical rows make the choice a coin
                              flip whose result the activity carries. /companies/search already returns
                              this; the picker was simply dropping it. */}
                          <Text style={styles.matchMeta} numberOfLines={1}>
                            {[c.category, c.ownerUserName].filter(Boolean).join(" · ") ||
                              "No other details"}
                          </Text>
                        </View>
                      </Pressable>
                    ))}
                    {companySearchFailed ? (
                      <Text testID="prospect-company-search-failed" style={styles.warn}>
                        Couldn&apos;t search companies — check your signal and try again.
                      </Text>
                    ) : null}
                    {companyResults?.length === 0 && companyQuery.trim().length >= 2 ? (
                      <>
                        <Text testID="prospect-no-companies" style={styles.help}>
                          No companies match “{companyQuery.trim()}”.
                        </Text>
                        {/* CREATE IT. Without this a completely net-new prospect — no property, no
                            company — could not be logged at all: the building control below needs a
                            company, and with neither the target stays empty and Save never enables.
                            That is the case field prospecting exists for. */}
                        <Pressable
                          testID="prospect-create-company"
                          onPress={() => createCompanyNamed.mutate({ name: companyQuery.trim() })}
                          disabled={locked || createCompanyNamed.isPending}
                          accessibilityRole="button"
                          accessibilityLabel={`Add ${companyQuery.trim()} as a new company`}
                          accessibilityState={{
                            disabled: locked || createCompanyNamed.isPending,
                            busy: createCompanyNamed.isPending,
                          }}
                          style={[
                            styles.secondaryBtn,
                            (locked || createCompanyNamed.isPending) && styles.primaryBtnDisabled,
                          ]}
                        >
                          {createCompanyNamed.isPending ? (
                            <ActivityIndicator color={theme.color.textPrimary} />
                          ) : (
                            <Text style={styles.secondaryText}>Add “{companyQuery.trim()}”</Text>
                          )}
                        </Pressable>
                        {duplicateCompanies?.length ? (
                          /* The dedup prompt, answered the same way the contact one is: pick the
                             existing company rather than quietly making a second. */
                          <View testID="prospect-duplicate-companies" style={styles.dupBox}>
                            <Text style={styles.warn}>
                              {duplicateCompanies.length === 1
                                ? "A company with a similar name already exists. Is this it?"
                                : `${duplicateCompanies.length} similar companies already exist. Which one?`}
                            </Text>
                            {duplicateCompanies.map((s) => (
                              <Pressable
                                key={s.id}
                                testID={`prospect-duplicate-company-${s.id}`}
                                onPress={() => {
                                  setCompany({ id: s.id, name: s.name ?? "Existing company" });
                                  setDuplicateCompanies(null);
                                  setCompanyResults(null);
                                  setCompanyQuery("");
                                  companyQueryRef.current = "";
                                }}
                                accessibilityRole="button"
                                accessibilityLabel={`Use ${s.name ?? "this company"}`}
                                style={styles.matchRow}
                              >
                                <Text style={styles.matchName} numberOfLines={1}>
                                  {s.name ?? "Existing company"}
                                </Text>
                                <Text style={styles.linkText}>Use</Text>
                              </Pressable>
                            ))}
                            {/* NONE OF THESE. The server treats fuzzy matches as warnings and supports
                                overriding them; without this a rep at a genuinely new company whose
                                name merely resembles an existing one could not create it — and since
                                both the building control and the activity target need a company, they
                                could not log the visit at all. */}
                            <Pressable
                              testID="prospect-company-force-create"
                              onPress={() =>
                                createCompanyNamed.mutate({
                                  name: companyQuery.trim(),
                                  force: true,
                                })
                              }
                              disabled={locked || createCompanyNamed.isPending}
                              accessibilityRole="button"
                              accessibilityLabel={`None of these — create ${companyQuery.trim()} anyway`}
                              style={styles.linkBtn}
                            >
                              <Text style={styles.linkText}>
                                None of these — create it anyway
                              </Text>
                            </Pressable>
                          </View>
                        ) : null}
                        {createCompanyError ? (
                          <Text testID="prospect-create-company-error" style={styles.warn}>
                            {createCompanyError}
                          </Text>
                        ) : null}
                      </>
                    ) : null}

                    {/* THE PERSON FALLBACK. Both this screen and the blocked-state copy promised a
                        contact was a valid target; without this they were describing a control that did
                        not exist. A visit about someone known, at a building the CRM has never seen, is
                        exactly the prospecting case. */}
                    <Text style={styles.stepLabel}>OR A PERSON</Text>
                    {contact ? (
                      <View style={styles.matchRow}>
                        <View style={styles.matchBody}>
                          <Text style={styles.matchName} numberOfLines={1}>
                            {`${contact.firstName} ${contact.lastName}`.trim()}
                          </Text>
                          <Text style={styles.matchMeta} numberOfLines={1}>
                            {prospecting.contactCompanyLabel(contact) || "Contact"}
                          </Text>
                        </View>
                        {locked ? null : (
                          <Pressable
                            testID="prospect-clear-contact"
                            onPress={() => setContact(null)}
                            accessibilityRole="button"
                            accessibilityLabel="Choose a different person"
                            style={styles.linkBtn}
                          >
                            <Text style={styles.linkText}>Change</Text>
                          </Pressable>
                        )}
                      </View>
                    ) : (
                      <>
                        <TextInput
                          testID="prospect-contact-search"
                          editable={!locked}
                          value={contactQuery}
                          onChangeText={(next) => {
                            setContactQuery(next);
                            contactQueryRef.current = next;
                            setContactSearchFailed(false);
                            // Stale rows are wrong the moment the text changes, and they stay tappable
                            // through the debounce otherwise.
                            setContactResults(null);
                            if (contactSearchTimer.current) clearTimeout(contactSearchTimer.current);
                            if (next.trim().length >= 2) {
                              contactSearchTimer.current = setTimeout(
                                () => findContacts.mutate(next),
                                250,
                              );
                            }
                          }}
                          placeholder="Search people"
                          placeholderTextColor={theme.color.textMuted}
                          autoCapitalize="words"
                          autoCorrect={false}
                          style={styles.input}
                        />
                        {findContacts.isPending ? (
                          <ActivityIndicator color={theme.color.brandRed} />
                        ) : null}
                        {contactResults?.map((c) => (
                          <Pressable
                            key={c.id}
                            testID={`prospect-contact-${c.id}`}
                            disabled={locked}
                            onPress={() => {
                              setContact(c);
                              setContactResults(null);
                              setContactQuery("");
                              contactQueryRef.current = "";
                              // The other half of the same rule — see the company row above.
                              setCompany(null);
                              setCompanyResults(null);
                              setCompanyQuery("");
                              companyQueryRef.current = "";
                            }}
                            accessibilityRole="button"
                            accessibilityLabel={`Attach this visit to ${c.firstName} ${c.lastName}`}
                            style={styles.matchRow}
                          >
                            <View style={styles.matchBody}>
                              <Text style={styles.matchName} numberOfLines={1}>
                                {`${c.firstName} ${c.lastName}`.trim()}
                              </Text>
                              {/* The employer, so two people with the same name are distinguishable. */}
                              <Text style={styles.matchMeta} numberOfLines={1}>
                                {prospecting.contactCompanyLabel(c) || "No company on file"}
                              </Text>
                            </View>
                          </Pressable>
                        ))}
                        {contactSearchFailed ? (
                          <Text testID="prospect-contact-search-failed" style={styles.warn}>
                            Couldn&apos;t search people — check your signal and try again.
                          </Text>
                        ) : null}
                        {contactResults?.length === 0 && contactQuery.trim().length >= 2 ? (
                          <Text testID="prospect-no-contacts" style={styles.help}>
                            No people match “{contactQuery.trim()}”.
                          </Text>
                        ) : null}
                      </>
                    )}
                  </>
                )}

                  {/* ADD THE BUILDING. Offered once a company is chosen and a full address is known —
                      the two things the server requires.

                      The address can be TYPED, because reverse geocoding degrades to null by design
                      (missing token, timeout, non-2xx). Gating solely on the geocode meant the one
                      control that captures a new building disappeared for good in exactly the
                      conditions a rep hits outdoors, and nothing else on this screen could take an
                      address. */}
                  {company && !geocodeComplete ? (
                    <View style={styles.dupBox}>
                      <Text style={styles.warn}>
                        Couldn&apos;t work out the address here. Type it to add the building, or just log
                        this against {company.name}.
                      </Text>
                      <TextInput
                        testID="prospect-manual-address"
                        editable={!locked}
                        value={manualAddress}
                        onChangeText={setManualAddress}
                        placeholder="Street address"
                        placeholderTextColor={theme.color.textMuted}
                        autoCapitalize="words"
                        style={styles.input}
                      />
                      <View style={styles.nameRow}>
                        <TextInput
                          testID="prospect-manual-city"
                          editable={!locked}
                          value={manualCity}
                          onChangeText={setManualCity}
                          placeholder="City"
                          placeholderTextColor={theme.color.textMuted}
                          autoCapitalize="words"
                          style={[styles.input, styles.half]}
                        />
                        <TextInput
                          testID="prospect-manual-state"
                          editable={!locked}
                          value={manualState}
                          onChangeText={setManualState}
                          placeholder="State"
                          placeholderTextColor={theme.color.textMuted}
                          autoCapitalize="characters"
                          maxLength={2}
                          style={[styles.input, styles.half]}
                        />
                      </View>
                      <TextInput
                        testID="prospect-manual-zip"
                        editable={!locked}
                        value={manualZip}
                        onChangeText={setManualZip}
                        placeholder="ZIP"
                        placeholderTextColor={theme.color.textMuted}
                        keyboardType="number-pad"
                        maxLength={10}
                        style={styles.input}
                      />
                    </View>
                  ) : null}

                  {company && effectiveAddress ? (
                    <>
                      <Pressable
                        testID="prospect-create-property"
                        onPress={() => createPropertyHere.mutate()}
                        disabled={locked || createPropertyHere.isPending}
                        accessibilityRole="button"
                        accessibilityLabel={`Add ${effectiveAddress.address} under ${company.name}`}
                        accessibilityState={{
                          disabled: locked || createPropertyHere.isPending,
                          busy: createPropertyHere.isPending,
                        }}
                        style={[
                          styles.secondaryBtn,
                          (locked || createPropertyHere.isPending) && styles.primaryBtnDisabled,
                        ]}
                      >
                        {createPropertyHere.isPending ? (
                          <ActivityIndicator color={theme.color.textPrimary} />
                        ) : (
                          <Text style={styles.secondaryText}>
                            Add “{effectiveAddress.address}” to {company.name}
                          </Text>
                        )}
                      </Pressable>
                      {createPropertyError ? (
                        <Text testID="prospect-create-property-error" style={styles.warn}>
                          {createPropertyError}
                        </Text>
                      ) : null}
                    </>
                  ) : null}

              </View>
            ) : null}
          </View>
        )}

        {/* ---- 2. WHAT HAPPENED ---- */}
        <Text style={styles.stepLabel}>WHAT HAPPENED</Text>
        <View style={styles.typeRow}>
          {ACTIVITY_TYPES.map((t) => {
            const active = type === t.key;
            return (
              <Pressable
                key={t.key}
                testID={`prospect-type-${t.key}`}
                onPress={() => setType(t.key)}
                disabled={locked}
                accessibilityRole="button"
                accessibilityState={{ selected: active, disabled: locked }}
                style={[styles.typeChip, active && styles.typeChipActive, locked && styles.chipLocked]}
              >
                <Text style={[styles.typeText, active && styles.typeTextActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <TextInput
          testID="prospect-body"
          editable={!locked}
          value={body}
          onChangeText={setBody}
          placeholder="What did you find? Roof age, condition, who you spoke to…"
          placeholderTextColor={theme.color.textMuted}
          multiline
          style={[styles.input, styles.multiline]}
        />
        <TextInput
          testID="prospect-outcome"
          editable={!locked}
          value={outcome}
          onChangeText={setOutcome}
          // activities.outcome is varchar(100). Past that Postgres rejects the INSERT, so the whole
          // capture fails on submit — after the rep has filled everything in and walked away from the
          // building. Capped at the input instead, where it costs nothing.
          maxLength={100}
          placeholder="Outcome — e.g. nobody in, walked the roof, wants a quote"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />
        <TextInput
          testID="prospect-next-step"
          editable={!locked}
          value={nextStep}
          onChangeText={setNextStep}
          placeholder="Next step (optional)"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />

        {/* WORTH A LEAD. A toggle rather than a button after "Logged", because /activities has no
            update route — nextStep can only be written when the activity is created. */}
        <Pressable
          testID="prospect-flag-lead"
          onPress={() => setFlagForLead((on) => !on)}
          disabled={locked}
          accessibilityRole="switch"
          accessibilityState={{ checked: flagForLead, disabled: locked }}
          accessibilityLabel="Flag this visit for a lead"
          style={[styles.flagRow, flagForLead && styles.flagRowOn, locked && styles.chipLocked]}
        >
          <Text style={[styles.flagText, flagForLead && styles.flagTextOn]}>
            {flagForLead ? "✓  Flagged for a lead" : "Worth a lead?"}
          </Text>
        </Pressable>
        {flagForLead ? (
          <Text style={styles.help}>
            Marks this visit as worth a lead. Tell your manager too — the office queue for these is not
            built yet.
          </Text>
        ) : null}

        {/* ---- 3. WHO. Entirely optional; fills in a real contact only when named. ----
            Hidden when an existing person is the TARGET: the activity carries one contact id, and the
            service refuses one that disagrees with sourceEntityId, so offering to name a second person
            here could only build a visit that cannot be saved. */}
        {contact ? (
          <>
            <Text testID="prospect-who-is-target" style={styles.help}>
              This visit is filed against {`${contact.firstName} ${contact.lastName}`.trim()}.
            </Text>
            {/* The WHO fields keep their contents while hidden, and the contact branch ignores them —
                so a rep who typed a person and THEN picked a contact target lost what they typed with
                no warning at all, because the discard notice below is suppressed once a contact is
                set. Hidden is not the same as empty. */}
            {contactFirst.trim() || contactLast.trim() || contactPhone.trim() || contactTitle.trim() ? (
              <Text testID="prospect-who-discarded" style={styles.warn}>
                The person details you typed won&apos;t be saved — this visit is already filed against{" "}
                {`${contact.firstName} ${contact.lastName}`.trim()}. Clear the person target to use them
                instead.
              </Text>
            ) : null}
          </>
        ) : (
          <>
        <Text style={styles.stepLabel}>WHO YOU MET (OPTIONAL)</Text>
        <View style={styles.nameRow}>
          <TextInput
            testID="prospect-first"
          editable={!locked}
            value={contactFirst}
            onChangeText={editPerson(setContactFirst)}
            placeholder="First name"
            placeholderTextColor={theme.color.textMuted}
            style={[styles.input, styles.half]}
          />
          <TextInput
            testID="prospect-last"
          editable={!locked}
            value={contactLast}
            onChangeText={editPerson(setContactLast)}
            placeholder="Last name"
            placeholderTextColor={theme.color.textMuted}
            style={[styles.input, styles.half]}
          />
        </View>
        <TextInput
          testID="prospect-title"
          editable={!locked}
          value={contactTitle}
          onChangeText={editPerson(setContactTitle)}
          placeholder="Title (optional)"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />
        <TextInput
          testID="prospect-phone"
          editable={!locked}
          value={contactPhone}
          onChangeText={editPerson(setContactPhone)}
          placeholder="Phone (optional)"
          placeholderTextColor={theme.color.textMuted}
          keyboardType="phone-pad"
          style={styles.input}
        />
        </>
        )}

        {personPartial && !contact ? (
          /* The server requires BOTH names and 400s otherwise. Said here rather than after a failed
             save, because the save also creates the activity and a rep should not lose the visit. */
          /* ANY populated person field, not just a half-typed name. Keyed on the names alone, a rep who
             entered only a phone number or a title saw no warning at all and read "Logged" while every
             detail they typed about that person was dropped — the contact is created only when both
             names are present, and nothing else on this screen carries them. */
          <Text testID="prospect-name-incomplete" style={styles.warn}>
            {contactFirst.trim() || contactLast.trim()
              ? "Both a first and last name are needed to save the person — the visit will still be logged."
              : "Add a first and last name to save this person — a phone or title on its own isn't stored."}
          </Text>
        ) : null}

        {duplicateContacts?.length && !saved ? (
          /**
           * THE CHOICE, made before anything is written.
           *
           * The dedup reply carries the ids of the people it matched, so the rep can attach the visit to
           * the right one in a tap. Logging first and reporting the duplicate afterwards — what this did
           * — threw those ids away and filed the visit against nobody, permanently, since there is no
           * way to edit an activity from this app. Meeting a property manager the CRM already knows is
           * the ORDINARY case out here, not an edge case.
           */
          <View testID="prospect-duplicate-picker" style={styles.dupBox}>
            <Text style={styles.warn}>
              {duplicateContacts.length === 1
                ? "Someone with this name is already in the CRM. Is this them?"
                : `${duplicateContacts.length} people with this name are already in the CRM. Which one did you meet?`}
            </Text>
            {duplicateContacts.filter((s) => s.isActive !== false).map((s) => {
              const name = s.name ?? [s.firstName, s.lastName].filter(Boolean).join(" ");
              return (
                <Pressable
                  key={s.id}
                  testID={`prospect-duplicate-${s.id}`}
                  onPress={() => {
                    resolvedContactId.current = s.id;
                    setResolvedContactName(name || "this contact");
                    setDuplicateContacts(null);
                    save.mutate();
                  }}
                  disabled={save.isPending}
                  accessibilityRole="button"
                  accessibilityLabel={`Log this visit with ${name || "this contact"}`}
                  style={styles.matchRow}
                >
                  <View style={styles.matchBody}>
                    <Text style={styles.matchName} numberOfLines={1}>
                      {name || "Existing contact"}
                    </Text>
                    {/* WHO they are, not just that they exist. Two people with the same name rendered as
                        two identical rows, so the rep picked blind and could pin the visit to the wrong
                        person for good. The server already returns both of these. */}
                    <Text style={styles.matchMeta} numberOfLines={1}>
                      {[s.linkedCompanyName ?? s.companyName, s.email].filter(Boolean).join(" · ") ||
                        "No other details"}
                    </Text>
                  </View>
                  <Text style={styles.linkText}>Use</Text>
                </Pressable>
              );
            })}
            <Pressable
              testID="prospect-duplicate-skip"
              onPress={() => {
                // An explicit waiver, so the create call is not retried on the resubmit. The rep said
                // none of these is the person; the VISIT still has to be recorded.
                contactWaived.current = true;
                setDuplicateContacts(null);
                save.mutate();
              }}
              disabled={save.isPending}
              accessibilityRole="button"
              accessibilityLabel="Log this visit without a person"
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>None of these — log without them</Text>
            </Pressable>
          </View>
        ) : null}

        {/* ---- Save ---- */}
        {saved ? (
          <View testID="prospect-saved" style={styles.savedBox}>
            <Text style={styles.savedText}>Logged.</Text>

            {/* HONEST about reach. The marker is stored on the activity, but nothing queries it yet
                and the property Activity tab is still a placeholder, so a rep told "the office will
                build it" would reasonably stop chasing it. Promising a workflow that does not exist is
                the same defect as reporting a save that did not happen. */}
            {flagForLead ? (
              <Text testID="prospect-flagged" style={styles.help}>
                Marked as worth a lead. Follow up with the office — this doesn&apos;t reach them on its
                own yet.
              </Text>
            ) : null}

            {contactFailed ? (
              <Text testID="prospect-contact-failed" style={styles.warn}>
                {contactIndeterminate
                  ? "The visit was logged. That person may or may not have been saved — check before adding them again."
                  : "The visit was logged, but that person couldn't be saved — add them on the web."}
              </Text>
            ) : null}

            {resolvedContactName ? (
              /* Which existing person the visit carries. The copy here used to announce that a duplicate
                 had been found AFTER logging without anybody — a report of the loss rather than a fix
                 for it. The choice now happens before the write, so this states the outcome. */
              <Text testID="prospect-duplicate-contacts" style={styles.help}>
                Logged with {resolvedContactName}, who was already in the CRM.
              </Text>
            ) : null}

            <Pressable
              testID="prospect-log-another"
              onPress={() => {
                setSavedActivityId(null);
                setFlagForLead(false);
                setContactFailed(false);
                createdContactId.current = undefined;
                resolvedContactId.current = null;
                contactWaived.current = false;
                setResolvedContactName(null);
                setContactIndeterminate(false);
                setDuplicateContacts(null);
                // The person TARGET is a separate thing from the person being described; a fresh log at
                // the same spot keeps the building, not who the last visit was with.
                setContact(null);
                setContactQuery("");
                contactQueryRef.current = "";
                setContactResults(null);
                setContactSearchFailed(false);
                setBody("");
                setOutcome("");
                setNextStep("");
                setContactFirst("");
                setContactLast("");
                setContactPhone("");
                setContactTitle("");
              }}
              accessibilityRole="button"
              style={styles.secondaryBtn}
            >
              <Text style={styles.secondaryText}>Log another here</Text>
            </Pressable>
          </View>
        ) : (
          <>
            {/**
              * Also blocked while the BUILDING is being created.
              *
              * `ready` is already true on the company the rep picked, so tapping Save during that
              * request filed the visit against the company — and the property mutation's onSuccess then
              * swapped the displayed target to the new building. The screen showed a property-backed
              * visit that the property's own history would never contain.
              */}
            <Pressable
              testID="prospect-save"
              onPress={() => save.mutate()}
              disabled={saveBlocked}
              accessibilityRole="button"
              accessibilityState={{ disabled: saveBlocked, busy: save.isPending }}
              style={[styles.primaryBtn, saveBlocked && styles.primaryBtnDisabled]}
            >
              {save.isPending ? (
                <ActivityIndicator color={theme.color.onBrand} />
              ) : (
                <Text style={styles.primaryText}>Save log</Text>
              )}
            </Pressable>
            {/* A disabled button with no explanation is the same defect as a dead one. */}
            {createPropertyHere.isPending ? (
              <Text testID="prospect-blocked" style={styles.help}>
                Adding the building…
              </Text>
            ) : blockedReason ? (
              <Text testID="prospect-blocked" style={styles.help}>
                {blockedReason}
              </Text>
            ) : null}
          </>
        )}

        {saveError ? (
          <Text testID="prospect-save-error" style={styles.error}>
            {saveError}
          </Text>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  safe: { flex: 1, backgroundColor: theme.color.canvas },
  header: {
    flexDirection: "row",
    alignItems: "center",
    backgroundColor: theme.color.chrome,
    paddingHorizontal: theme.space.sm,
    paddingBottom: theme.space.md,
    paddingTop: theme.space.xs,
    borderBottomWidth: 2,
    borderBottomColor: theme.color.brandRed,
  },
  backBtn: { width: 44, height: 44, alignItems: "center", justifyContent: "center" },
  backChevron: { fontFamily: theme.font.bold, fontSize: 30, lineHeight: 34, color: theme.color.textPrimary },
  headerTitle: { flex: 1, textAlign: "center", ...theme.type.caption, fontSize: 12, color: theme.color.textPrimary },
  headerSpacer: { width: 44 },

  body: { padding: theme.space.lg, gap: theme.space.md, paddingBottom: theme.space.xxl },
  stepLabel: { ...theme.type.caption, color: theme.color.textMuted, marginTop: theme.space.sm },

  card: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.border,
    padding: theme.space.lg,
    gap: theme.space.md,
    ...theme.elevation.card,
  },
  chosenCard: {
    backgroundColor: theme.color.surface,
    borderRadius: theme.radius.lg,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    padding: theme.space.lg,
    gap: 2,
    ...theme.elevation.card,
  },
  chosenName: { ...theme.type.h2, color: theme.color.textPrimary },
  chosenMeta: { ...theme.type.body, color: theme.color.textSecondary },
  chosenCompany: { ...theme.type.caption, color: theme.color.textMuted, textTransform: "uppercase" },

  centerRow: { flexDirection: "row", alignItems: "center", gap: theme.space.md },
  help: { ...theme.type.body, color: theme.color.textSecondary },
  warn: { ...theme.type.label, color: theme.color.amberText },
  error: { ...theme.type.label, color: theme.color.redText },

  matchList: { gap: theme.space.sm },
  /* The unresolved-duplicate block. Bordered, because it is a question the rep has to answer before the
     visit is written — not a notice they can read past. */
  dupBox: {
    gap: theme.space.sm,
    padding: theme.space.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.borderControl,
    backgroundColor: theme.color.surfaceMuted,
  },
  chipLocked: { opacity: 0.5 },
  flagRow: {
    minHeight: 48,
    justifyContent: "center",
    paddingHorizontal: theme.space.md,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.borderControl,
    backgroundColor: theme.color.surface,
  },
  flagRowOn: { borderColor: theme.color.brandRed, backgroundColor: theme.color.surfaceRaised },
  flagText: { ...theme.type.label, color: theme.color.textSecondary },
  flagTextOn: { color: theme.color.textPrimary },
  matchRow: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.space.md,
    minHeight: 56,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.sm,
  },
  matchBody: { flex: 1, gap: 2 },
  matchName: { ...theme.type.title, color: theme.color.textPrimary },
  matchMeta: { ...theme.type.label, color: theme.color.textMuted },
  matchReason: { ...theme.type.caption, color: theme.color.textSecondary, textAlign: "right", maxWidth: 110 },

  typeRow: { flexDirection: "row", flexWrap: "wrap", gap: theme.space.sm },
  typeChip: {
    minHeight: 44,
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.border,
    backgroundColor: theme.color.surfaceMuted,
    paddingHorizontal: theme.space.lg,
  },
  typeChipActive: { backgroundColor: theme.color.surfaceRaised, borderColor: theme.color.brandRed },
  typeText: { ...theme.type.label, color: theme.color.textMuted },
  typeTextActive: { color: theme.color.textPrimary },

  input: {
    minHeight: 48,
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.borderControl,
    backgroundColor: theme.color.surface,
    paddingHorizontal: theme.space.md,
    paddingVertical: theme.space.md,
    ...theme.type.body,
    color: theme.color.textPrimary,
  },
  multiline: { minHeight: 96, textAlignVertical: "top" },
  nameRow: { flexDirection: "row", gap: theme.space.sm },
  half: { flex: 1 },

  primaryBtn: {
    minHeight: 52,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.brandRed,
    ...theme.elevation.card,
  },
  primaryBtnDisabled: { opacity: 0.45 },
  primaryText: { ...theme.type.title, color: theme.color.onBrand },
  secondaryBtn: {
    minHeight: 48,
    alignItems: "center",
    justifyContent: "center",
    borderRadius: theme.radius.md,
    borderWidth: 1,
    borderColor: theme.color.borderStrong,
    paddingHorizontal: theme.space.lg,
  },
  secondaryText: { ...theme.type.label, color: theme.color.textPrimary },
  linkBtn: { minHeight: 44, justifyContent: "center" },
  linkText: { ...theme.type.label, color: theme.color.redText },

  savedBox: {
    borderRadius: theme.radius.md,
    backgroundColor: theme.color.greenSurface,
    borderWidth: 1,
    borderColor: theme.color.greenBorder,
    padding: theme.space.lg,
    gap: theme.space.md,
  },
  savedText: { ...theme.type.h2, color: theme.color.greenText },
});
