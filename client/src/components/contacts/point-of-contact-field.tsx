import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompanyContacts, type CompanyContact } from "@/hooks/use-companies";
import { createContact } from "@/hooks/use-contacts";
import { getContactCompanyName } from "@/lib/contact-utils";

export interface PointOfContactFieldProps {
  /** The company the opportunity is being created for. Empty string when none is chosen yet. */
  companyId: string;
  /** Selected contact id, or empty string. */
  value: string;
  onChange: (contactId: string) => void;
  officeId: string | null;
  disabled?: boolean;
}

const NONE = "__none__";

const EMPTY_CONTACT = { firstName: "", lastName: "", email: "", phone: "", jobTitle: "" };

type Suggestion = {
  id: string;
  firstName: string;
  lastName: string;
  email: string | null;
  companyName: string | null;
  // Joined server-side from companies — authoritative over the nullable free-text companyName above. The
  // create endpoint's response type doesn't declare this field, but the route returns it (it forwards
  // dedupResult.fuzzySuggestions verbatim, which does carry it), so it's cast in here rather than left off.
  linkedCompanyName?: string | null;
  matchReason?: string;
  isActive?: boolean;
};

/**
 * The point of contact on a new Service Opportunity — the person the service crew calls.
 *
 * The list is scoped to the selected company and there is deliberately no "search all contacts" escape:
 * the server rejects a primary contact that does not belong to the deal's company, so a wider list would
 * offer choices that fail on save. "Add new contact" is the escape hatch, and it links the new contact to
 * this company, which is what keeps the inline path always valid.
 */
export function PointOfContactField({
  companyId,
  value,
  onChange,
  officeId,
  disabled = false,
}: PointOfContactFieldProps) {
  // undefined rather than "" — useCompanyContacts short-circuits on a falsy id and never fetches.
  const { contacts, loading, error, refetch } = useCompanyContacts(companyId || undefined, { officeId });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_CONTACT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  // True once the LAST create attempt was blocked by dedup — tracked separately from `suggestions` because
  // every returned match can be inactive, leaving `suggestions` empty with nothing to offer even though
  // dedup did fire. Drives the Save button's "Create anyway" label and the next attempt's force flag, and
  // (like `suggestions`) is cleared on every field edit so a forced create can never reuse a dedup verdict
  // for a name the server has never actually checked.
  const [dedupBlocked, setDedupBlocked] = useState(false);
  // A contact created through the dialog, kept locally so the picker can name it even if the refetch that
  // should have brought it back does not. `useCompanyContacts.refetch` swallows its own failure and clears
  // `contacts`, so without this a successful create followed by a failed refetch left the field reading
  // "Select a point of contact" while the parent held the id — an invisible selection the rep cannot see
  // or correct, on a field whose whole job is to say who the crew should call.
  const [justCreated, setJustCreated] = useState<Array<{ companyId: string; contact: CompanyContact }>>([]);
  // Bumped whenever the dialog session ends by any means OTHER than the save that's in flight resolving
  // (closeDialog covers Cancel, a suggestion pick, and success). A create response that lands after its own
  // seq has been superseded is stale and must not call onChange — otherwise a rep who reconsiders and picks
  // a suggestion while "Create anyway" is still in flight could have that pick silently overwritten by the
  // freshly created duplicate once the request resolves.
  const saveSeq = useRef(0);

  const closeDialog = () => {
    ++saveSeq.current;
    setDialogOpen(false);
    setDraft(EMPTY_CONTACT);
    setSaveError(null);
    setSuggestions([]);
    setDedupBlocked(false);
    // `saving` is deliberately NOT reset here. It tracks the in-flight REQUEST, not this dialog session:
    // clearing it on dismiss is what let a rep close mid-save, reopen, and submit the same person again
    // while the first POST was still running — and since both requests run their dedup check before either
    // commits, and there is no uniqueness constraint, that creates the exact duplicate this dialog exists
    // to prevent. The finally in saveNewContact always releases it.
  };

  // Single change handler for all five dialog fields — routes through here so editing the draft ALWAYS
  // drops the stale dedup verdict (suggestions + dedupBlocked) alongside the value. Without this, editing
  // the name after a dedup warning leaves the "Create anyway" force flag armed for a name dedup never saw,
  // which is exactly the silent-duplicate path this feature exists to prevent. Ported from
  // deal-billing-tab.tsx's field() onChange (Codex-flagged there for the same reason).
  const updateDraft = (field: keyof typeof EMPTY_CONTACT, fieldValue: string) => {
    setDraft((prev) => ({ ...prev, [field]: fieldValue }));
    setSuggestions([]);
    setDedupBlocked(false);
    setSaveError(null);
  };

  // `force` re-submits past the dedup warning. The first attempt never skips dedup — that is the whole
  // point of running it, and a shortcut that silently duplicates people is worse than the friction.
  const saveNewContact = async (force: boolean) => {
    // Defence in depth only, and NOT what actually stops the double-submit: `saving` survives a dismissal
    // (see closeDialog), so the reopened dialog's Save button is disabled and a click is already a no-op —
    // which is the behaviour the test pins. No DOM path reaches this line, so no test covers it; it is here
    // for a future trigger that isn't disabled-aware (a keyboard shortcut, a programmatic call).
    if (saving) return;
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      setSaveError("First and last name are required");
      return;
    }
    const seq = ++saveSeq.current;
    setSaving(true);
    setSaveError(null);
    try {
      const result = await createContact(
        {
          firstName: draft.firstName.trim(),
          lastName: draft.lastName.trim(),
          email: draft.email.trim() || null,
          phone: draft.phone.trim() || null,
          jobTitle: draft.jobTitle.trim() || null,
          // Linking to the selected company is what makes this contact valid against the server's
          // company-membership check on the primary contact.
          companyId,
          category: "client",
          ...(force ? { skipDedupCheck: true } : {}),
        },
        { officeId }
      );
      // Whether this dialog session is still the current one. The dialog's own close button and Escape
      // stay live while the request is in flight, and closing bumps saveSeq.
      const sessionEnded = seq !== saveSeq.current;
      if (result.contact) {
        const created = result.contact;
        // Cached and refreshed REGARDLESS of whether the session ended. The contact exists on the server
        // either way, and discarding it here left the picker stale: the rep closed the dialog mid-create,
        // reopened, retyped the same person, and dedup then matched a contact missing from the scoped list
        // — classifying it CROSS-company and withholding "Use this contact", which walks them into force-
        // creating the duplicate this dialog exists to prevent. Only the SELECTION below is session-scoped.
        //
        // Held locally before the refetch is trusted, because refetch() swallows its own failure and clears
        // `contacts`, so selecting on the strength of the refetch alone could leave the field unable to
        // name the contact it is holding.
        setJustCreated((prev) =>
          prev.some((entry) => entry.contact.id === created.id)
            ? prev
            : [...prev, {
          companyId,
          contact: {
            id: created.id,
            firstName: created.firstName,
            lastName: created.lastName,
            email: created.email ?? null,
            phone: created.phone ?? null,
            jobTitle: created.jobTitle ?? null,
            category: created.category ?? "client",
          },
        }]);
        // NOT refetched when the session has ended. `refetch` is captured for the company this dialog was
        // opened under, and useCompanyContacts shares one request counter across renders — so a late call
        // from a dismissed save supersedes the CURRENT company's in-flight request and can repopulate the
        // picker with the old company's contacts. The local cache above already keeps the new contact
        // visible for its own company, which is all the dismissed path needs.
        if (sessionEnded) return;
        await refetch();
        // Re-read AFTER the await as well: the dialog can be dismissed during the refetch too, and
        // selecting then would put the previous company's brand-new contact under a rep who has moved on,
        // failing the server's company-membership check on create.
        if (seq !== saveSeq.current) return;
        onChange(created.id);
        closeDialog();
        return;
      }
      // Everything below only drives dialog UI (suggestions, errors), so it is pointless once the session
      // has ended.
      if (sessionEnded) return;
      if (result.dedupWarning && result.suggestions?.length) {
        setDedupBlocked(true);
        // The dedup path can surface soft-deleted or merged records; pointing the deal at one would tie it
        // to a stale contact, so only ACTIVE matches are offerable.
        const active = (result.suggestions as Suggestion[]).filter((s) => s.isActive !== false);
        if (active.length > 0) {
          setSuggestions(active);
        } else {
          // Every match dedup found was archived — there is nothing to offer, but leaving Save unchanged
          // would silently dead-end the rep on a button that repeats this exact same result forever.
          setSuggestions([]);
          setSaveError('A similar contact already exists but is archived (deleted or merged). "Create anyway" will add this person.');
        }
        return;
      }
      setSaveError("Contact was not created.");
    } catch (err) {
      if (seq !== saveSeq.current) return;
      setSaveError(err instanceof Error ? err.message : "Could not create the contact.");
    } finally {
      // ALWAYS cleared, and only here. `saving` tracks the REQUEST, not the dialog session — see the guard
      // at the top of this function — so it must outlive a dismissal and be released when the request
      // settles, whichever way that goes.
      setSaving(false);
    }
  };

  // The refetched list plus any contact this dialog just created that the refetch did not bring back. On a
  // healthy refetch the created contact is already in `contacts`, so it de-duplicates to nothing.
  const knownContacts = useMemo(() => {
    // Each entry is scoped to the company it was created under: carrying one into another company's list
    // would offer a contact the server rejects, the very failure this field exists to avoid. A LIST rather
    // than a single slot because creates can overlap — dismiss A while pending, create and select B, then
    // A resolves — and a singleton would let the older create overwrite the newer one's fallback, leaving
    // the picker unable to name the contact the parent is holding.
    const extras = justCreated.filter(
      (entry) =>
        entry.companyId === companyId && !contacts.some((contact) => contact.id === entry.contact.id)
    );
    return extras.length ? [...contacts, ...extras.map((entry) => entry.contact)] : contacts;
  }, [contacts, justCreated, companyId]);

  const items = useMemo(
    () => [
      { value: NONE, label: companyId ? "Select a point of contact" : "Select a company first" },
      ...knownContacts.map((contact) => ({
        value: contact.id,
        label: `${contact.firstName} ${contact.lastName}`.trim(),
      })),
    ],
    [knownContacts, companyId]
  );

  const selectedLabel = items.find((item) => item.value === (value || NONE))?.label ?? "Select a point of contact";
  // A held id the loaded list cannot account for is an INVISIBLE selection: the trigger falls back to
  // "Select a point of contact" while the parent still holds the value, so its required-field check passes
  // and it submits a contact the rep cannot see. Reachable from a prefilled ?primaryContactId that has
  // since been archived or reassigned. Only once the list has genuinely loaded — never mid-load, and never
  // on an error, where an empty list says nothing about the contact.
  useEffect(() => {
    if (!companyId || !value || loading || error) return;
    if (knownContacts.some((contact) => contact.id === value)) return;
    onChange("");
  }, [companyId, value, loading, error, knownContacts, onChange]);

  const hasNoContacts = Boolean(companyId) && !loading && !error && knownContacts.length === 0;

  return (
    <div className="space-y-2">
      {/* items is REQUIRED: this is Base UI, and without it the trigger renders the raw uuid. */}
      <Select
        items={items}
        value={value || NONE}
        onValueChange={(next) => onChange(!next || next === NONE ? "" : next)}
        disabled={disabled || !companyId}
      >
        <SelectTrigger id="primaryContactId" data-testid="poc-select">
          <SelectValue>{loading && companyId ? "Loading contacts..." : selectedLabel}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          <SelectItem value={NONE}>{companyId ? "Select a point of contact" : "Select a company first"}</SelectItem>
          {knownContacts.map((contact) => (
            <SelectItem key={contact.id} value={contact.id}>
              {contact.firstName} {contact.lastName}
              {contact.jobTitle ? ` · ${contact.jobTitle}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {error ? (
        // A failed load renders `contacts: []` just like "no contacts on this company yet" — without this,
        // the empty state below would confidently tell the rep to create a contact that likely already
        // exists.
        <div
          className="flex items-center justify-between gap-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-xs text-red-700"
          data-testid="poc-load-error"
        >
          <span>Could not load contacts for this company — please try again.</span>
          <Button type="button" variant="outline" size="sm" data-testid="poc-retry" onClick={() => refetch()}>
            Retry
          </Button>
        </div>
      ) : hasNoContacts ? (
        <p className="text-xs text-muted-foreground">
          No contacts on this company yet — add the person the service crew should call.
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="poc-add-button"
        // Also blocked while the company's contacts are loading or failed to load. Duplicate suggestions
        // are classified in-company by looking them up in `contacts` (there is no companyId on a
        // suggestion), so an empty list — whether not-yet-loaded or errored — would label a contact that
        // genuinely belongs to this company as "different company", withhold "Use this contact", and walk
        // the rep straight into force-creating the duplicate this dialog exists to prevent.
        disabled={disabled || !companyId || loading || Boolean(error)}
        onClick={() => {
          setDraft(EMPTY_CONTACT);
          setSaveError(null);
          setSuggestions([]);
          setDedupBlocked(false);
          setDialogOpen(true);
        }}
      >
        + Add new contact
      </Button>

      <Dialog open={dialogOpen} onOpenChange={(open) => (open ? setDialogOpen(true) : closeDialog())}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add a point of contact</DialogTitle>
          </DialogHeader>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <Label htmlFor="poc-first-name">First name <span className="text-red-500">*</span></Label>
              <Input
                id="poc-first-name"
                data-testid="poc-first-name"
                value={draft.firstName}
                disabled={saving}
                onChange={(e) => updateDraft("firstName", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-last-name">Last name <span className="text-red-500">*</span></Label>
              <Input
                id="poc-last-name"
                data-testid="poc-last-name"
                value={draft.lastName}
                disabled={saving}
                onChange={(e) => updateDraft("lastName", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-email">Email</Label>
              <Input
                id="poc-email"
                data-testid="poc-email"
                value={draft.email}
                disabled={saving}
                onChange={(e) => updateDraft("email", e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-phone">Phone</Label>
              <Input
                id="poc-phone"
                data-testid="poc-phone"
                value={draft.phone}
                disabled={saving}
                onChange={(e) => updateDraft("phone", e.target.value)}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="poc-job-title">Job title</Label>
              <Input
                id="poc-job-title"
                data-testid="poc-job-title"
                value={draft.jobTitle}
                disabled={saving}
                onChange={(e) => updateDraft("jobTitle", e.target.value)}
              />
            </div>
          </div>

          {suggestions.length ? (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-amber-900">
                Someone with this name already exists. Use them instead of creating a duplicate:
              </p>
              {suggestions.map((s) => {
                // The suggestions payload carries no companyId, so "is this match in the selected company"
                // is inferred from whether its id appears in the already-loaded, company-scoped `contacts`
                // list — the only signal available client-side. Cross-company matches are still SHOWN (that
                // is dedup's whole job) but not pickable: onChange-ing to a Company-B contact would set
                // `value` to an id this field's own picker doesn't list, so the trigger would silently show
                // "Select a point of contact" while a save-time 400 waits ("Primary contact does not belong
                // to the company") — contradicting the "no out-of-company escape hatch" doc comment above.
                const inCompany = knownContacts.some((c) => c.id === s.id);
                const companyLabel = getContactCompanyName(s);
                return (
                  <div key={s.id} className="flex items-center justify-between gap-2" data-testid="poc-suggestion">
                    <span>
                      {s.firstName} {s.lastName}
                      {companyLabel ? ` · ${companyLabel}` : ""}
                      {!inCompany ? " — different company; a new record will be created for this one" : ""}
                    </span>
                    {inCompany ? (
                      <Button
                        type="button"
                        size="sm"
                        variant="outline"
                        // A pick while "Create anyway" is in flight must not be racable — see saveSeq above
                        // for the corresponding guard on the resolution side.
                        disabled={saving}
                        onClick={() => {
                          onChange(s.id);
                          closeDialog();
                        }}
                      >
                        Use this contact
                      </Button>
                    ) : null}
                  </div>
                );
              })}
            </div>
          ) : null}

          {saveError ? <p className="text-sm text-red-600">{saveError}</p> : null}

          <DialogFooter>
            <Button type="button" variant="outline" onClick={closeDialog} disabled={saving}>
              Cancel
            </Button>
            <Button
              type="button"
              data-testid="poc-save"
              disabled={saving}
              onClick={() => saveNewContact(dedupBlocked)}
            >
              {saving ? "Saving..." : dedupBlocked ? "Create anyway" : "Save contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
