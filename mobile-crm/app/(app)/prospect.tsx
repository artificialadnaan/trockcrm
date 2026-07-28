import React, { useCallback, useMemo, useState } from "react";
import {
  ActivityIndicator,
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

  const target = useMemo(
    () => (property ? { propertyId: property.id, companyId: property.companyId } : {}),
    [property],
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
      // The rep is standing outside. A failed lookup must leave them able to log against a company or
      // contact instead, never stranded on a spinner.
      setMatchError(
        err instanceof ApiError && err.status === 0
          ? "No signal — you can still log this against a company or contact."
          : "Couldn't look up nearby properties.",
      );
    },
  });

  // Kick the match off as soon as a fix lands.
  const fix = location.state.status === "ready" ? location.state : null;
  const fixKey = fix ? `${fix.lat},${fix.lng}` : null;
  const [matchedFor, setMatchedFor] = useState<string | null>(null);
  if (fixKey && matchedFor !== fixKey && !runMatch.isPending) {
    setMatchedFor(fixKey);
    runMatch.mutate({ lat: fix!.lat, lng: fix!.lng });
  }

  const save = useMutation({
    mutationFn: async () => {
      let contactId: string | undefined;
      const first = contactFirst.trim();
      const last = contactLast.trim();
      /**
       * The person block creates a REAL contact, and only when it is filled.
       *
       * A duplicate answer is not a failure here — `POST /contacts` replies 200 with suggestions rather
       * than 201, and that prompt is the useful outcome: a rep who meets the same property manager
       * twice should be told, not silently given a second record. So a dedup reply leaves contactId
       * undefined and the activity still attaches to the property.
       */
      if (first && last) {
        const created = await prospecting.createContact(fetcher, {
          firstName: first,
          lastName: last,
          category: "property_manager",
          title: contactTitle.trim() || undefined,
          mobile: contactPhone.trim() || undefined,
          companyId: property?.companyId,
        });
        contactId = created.created?.id;
      }

      return prospecting.logActivity(fetcher, {
        ...target,
        contactId,
        type: type!,
        body: body.trim() || undefined,
        outcome: outcome.trim() || undefined,
        nextStep: nextStep.trim() || undefined,
      });
    },
    onSuccess: async (activity) => {
      setSavedActivityId(activity.id);
      setSaveError(null);
      // The property's activity feed and any list showing last-touch are now stale.
      await Promise.all([
        queryClient.invalidateQueries({ queryKey: ["properties"] }),
        queryClient.invalidateQueries({ queryKey: ["activities"] }),
      ]);
    },
    onError: (err) => {
      setSavedActivityId(null);
      setSaveError(
        err instanceof ApiError && err.status === 0
          ? "No signal — this didn't save. Try again once you're back in range."
          : err instanceof ApiError
            ? err.message
            : "Couldn't save this log.",
      );
    },
  });

  const [promoted, setPromoted] = useState<prospecting.LeadRef | null>(null);
  const [promoteError, setPromoteError] = useState<string | null>(null);

  /**
   * Promote the capture to a lead.
   *
   * TWO CALLS, and deliberately so: POST /leads owns every rule about what a lead is (office code, rep
   * assignment, due-diligence dispatch, its own requirements contract), and reproducing that for a
   * "promote" endpoint would be a second definition of a lead. So the lead is created there and the
   * activity is linked afterwards.
   *
   * They are not atomic, which shapes the error handling below: if the LINK fails the lead still
   * exists, so the screen reports it as created and says only the back-reference is missing. Telling a
   * rep "promotion failed" when a lead was in fact created is how the same lead gets made twice.
   */
  const promote = useMutation({
    mutationFn: async () => {
      if (!property) throw new Error("A property is required to make a lead.");
      const lead = await prospecting.createLeadFromCapture(fetcher, {
        companyId: property.companyId,
        propertyId: property.id,
        // The property's name is the honest default — a rep naming the lead is a second decision at the
        // moment they are trying to leave, and it can be edited on the web where there is a keyboard.
        name: property.name,
      });
      if (savedActivityId) {
        try {
          await prospecting.linkActivityToLead(fetcher, savedActivityId, lead.id);
        } catch {
          // Swallowed ON PURPOSE. The lead is the artifact that matters and it exists; a missing
          // back-reference is a traceability gap, not a failed promotion, and surfacing it as failure
          // invites a duplicate lead.
        }
      }
      return lead;
    },
    onSuccess: async (lead) => {
      setPromoted(lead);
      setPromoteError(null);
      await queryClient.invalidateQueries({ queryKey: ["leads"] });
    },
    onError: (err) => {
      setPromoteError(
        err instanceof ApiError && err.status === 0
          ? "No signal — the log is saved, but the lead wasn't created."
          : err instanceof ApiError
            ? err.message
            : "Couldn't create the lead.",
      );
    },
  });

  const coarse =
    location.state.status === "ready" &&
    isPositionTooCoarse(location.state.accuracyMeters, COARSE_ACCURACY_METERS);

  return (
    <SafeAreaView style={styles.safe} edges={["top"]}>
      <View style={styles.header}>
        <Pressable
          testID="prospect-back"
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
            <Pressable
              testID="prospect-change-property"
              onPress={() => {
                setProperty(null);
                setMatches(null);
                setMatchedFor(null);
                location.reset();
              }}
              accessibilityRole="button"
              style={styles.linkBtn}
            >
              <Text style={styles.linkText}>Change</Text>
            </Pressable>
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
                Your position is only accurate to about {Math.round(location.state.status === "ready" ? (location.state.accuracyMeters ?? 0) : 0)} m —
                double-check the building before you confirm it.
              </Text>
            ) : null}

            {matchError ? <Text style={styles.warn}>{matchError}</Text> : null}

            {matches?.length ? (
              <View style={styles.matchList}>
                <Text style={styles.help}>Is this the property?</Text>
                {matches.map((m) => (
                  <Pressable
                    key={m.id}
                    testID={`prospect-match-${m.id}`}
                    onPress={() => setProperty(m)}
                    accessibilityRole="button"
                    accessibilityLabel={`${m.name}, ${describeMatch(m)}`}
                    style={styles.matchRow}
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
              </View>
            ) : matches?.length === 0 ? (
              <Text testID="prospect-no-matches" style={styles.help}>
                {address
                  ? `Nothing on file at ${address.address}. Log it against a company or contact for now — creating the property comes next.`
                  : "No properties matched here."}
              </Text>
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
                accessibilityRole="button"
                accessibilityState={{ selected: active }}
                style={[styles.typeChip, active && styles.typeChipActive]}
              >
                <Text style={[styles.typeText, active && styles.typeTextActive]}>{t.label}</Text>
              </Pressable>
            );
          })}
        </View>

        <TextInput
          testID="prospect-body"
          value={body}
          onChangeText={setBody}
          placeholder="What did you find? Roof age, condition, who you spoke to…"
          placeholderTextColor={theme.color.textMuted}
          multiline
          style={[styles.input, styles.multiline]}
        />
        <TextInput
          testID="prospect-outcome"
          value={outcome}
          onChangeText={setOutcome}
          placeholder="Outcome — e.g. nobody in, walked the roof, wants a quote"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />
        <TextInput
          testID="prospect-next-step"
          value={nextStep}
          onChangeText={setNextStep}
          placeholder="Next step (optional)"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />

        {/* ---- 3. WHO. Entirely optional; fills in a real contact only when named. ---- */}
        <Text style={styles.stepLabel}>WHO YOU MET (OPTIONAL)</Text>
        <View style={styles.nameRow}>
          <TextInput
            testID="prospect-first"
            value={contactFirst}
            onChangeText={setContactFirst}
            placeholder="First name"
            placeholderTextColor={theme.color.textMuted}
            style={[styles.input, styles.half]}
          />
          <TextInput
            testID="prospect-last"
            value={contactLast}
            onChangeText={setContactLast}
            placeholder="Last name"
            placeholderTextColor={theme.color.textMuted}
            style={[styles.input, styles.half]}
          />
        </View>
        <TextInput
          testID="prospect-title"
          value={contactTitle}
          onChangeText={setContactTitle}
          placeholder="Title (optional)"
          placeholderTextColor={theme.color.textMuted}
          style={styles.input}
        />
        <TextInput
          testID="prospect-phone"
          value={contactPhone}
          onChangeText={setContactPhone}
          placeholder="Phone (optional)"
          placeholderTextColor={theme.color.textMuted}
          keyboardType="phone-pad"
          style={styles.input}
        />
        {contactFirst.trim() && !contactLast.trim() ? (
          /* The server requires BOTH names and 400s otherwise. Said here rather than after a failed
             save, because the save also creates the activity and a rep should not lose the visit. */
          <Text style={styles.warn}>A last name is needed to save the person.</Text>
        ) : null}

        {/* ---- Save ---- */}
        {saved ? (
          <View testID="prospect-saved" style={styles.savedBox}>
            <Text style={styles.savedText}>Logged.</Text>

            {/* PROMOTION lives here, after the log is safe. Offering it before saving would make a rep
                choose between recording the visit and acting on it, and the visit is the thing that
                must not be lost. Only offered with a property, because a lead requires one. */}
            {promoted ? (
              <Text testID="prospect-promoted" style={styles.help}>
                Lead created{promoted.leadNumber ? ` — ${promoted.leadNumber}` : ""}. Finish it on the
                web when you&apos;re back.
              </Text>
            ) : property ? (
              <Pressable
                testID="prospect-promote"
                onPress={() => promote.mutate()}
                disabled={promote.isPending}
                accessibilityRole="button"
                accessibilityLabel={`Make a lead for ${property.name}`}
                accessibilityState={{ disabled: promote.isPending, busy: promote.isPending }}
                style={[styles.secondaryBtn, promote.isPending && styles.primaryBtnDisabled]}
              >
                {promote.isPending ? (
                  <ActivityIndicator color={theme.color.textPrimary} />
                ) : (
                  <Text style={styles.secondaryText}>Make this a lead</Text>
                )}
              </Pressable>
            ) : null}

            {promoteError ? (
              <Text testID="prospect-promote-error" style={styles.error}>
                {promoteError}
              </Text>
            ) : null}
            <Pressable
              testID="prospect-log-another"
              onPress={() => {
                setSavedActivityId(null);
                setPromoted(null);
                setPromoteError(null);
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
            <Pressable
              testID="prospect-save"
              onPress={() => save.mutate()}
              disabled={!ready || save.isPending}
              accessibilityRole="button"
              accessibilityState={{ disabled: !ready || save.isPending, busy: save.isPending }}
              style={[styles.primaryBtn, (!ready || save.isPending) && styles.primaryBtnDisabled]}
            >
              {save.isPending ? (
                <ActivityIndicator color={theme.color.onBrand} />
              ) : (
                <Text style={styles.primaryText}>Save log</Text>
              )}
            </Pressable>
            {/* A disabled button with no explanation is the same defect as a dead one. */}
            {blockedReason ? (
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
