import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompanyContacts } from "@/hooks/use-companies";
import { createContact } from "@/hooks/use-contacts";

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
  const { contacts, loading, refetch } = useCompanyContacts(companyId || undefined, { officeId });
  const [dialogOpen, setDialogOpen] = useState(false);
  const [draft, setDraft] = useState(EMPTY_CONTACT);
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);

  const closeDialog = () => {
    setDialogOpen(false);
    setDraft(EMPTY_CONTACT);
    setSaveError(null);
    setSuggestions([]);
  };

  // `force` re-submits past the dedup warning. The first attempt never skips dedup — that is the whole
  // point of running it, and a shortcut that silently duplicates people is worse than the friction.
  const saveNewContact = async (force: boolean) => {
    if (!draft.firstName.trim() || !draft.lastName.trim()) {
      setSaveError("First and last name are required");
      return;
    }
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
      if (result.contact) {
        await refetch();
        onChange(result.contact.id);
        closeDialog();
        return;
      }
      if (result.dedupWarning && result.suggestions?.length) {
        // The dedup path can surface soft-deleted or merged records; pointing the deal at one would tie it
        // to a stale contact.
        setSuggestions((result.suggestions as Suggestion[]).filter((s) => s.isActive !== false));
        return;
      }
      setSaveError("Contact was not created.");
    } catch (err) {
      setSaveError(err instanceof Error ? err.message : "Could not create the contact.");
    } finally {
      setSaving(false);
    }
  };

  const items = useMemo(
    () => [
      { value: NONE, label: companyId ? "Select a point of contact" : "Select a company first" },
      ...contacts.map((contact) => ({
        value: contact.id,
        label: `${contact.firstName} ${contact.lastName}`.trim(),
      })),
    ],
    [contacts, companyId]
  );

  const selectedLabel = items.find((item) => item.value === (value || NONE))?.label ?? "Select a point of contact";
  const hasNoContacts = Boolean(companyId) && !loading && contacts.length === 0;

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
          {contacts.map((contact) => (
            <SelectItem key={contact.id} value={contact.id}>
              {contact.firstName} {contact.lastName}
              {contact.jobTitle ? ` · ${contact.jobTitle}` : ""}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>

      {hasNoContacts ? (
        <p className="text-xs text-muted-foreground">
          No contacts on this company yet — add the person the service crew should call.
        </p>
      ) : null}

      <Button
        type="button"
        variant="outline"
        size="sm"
        data-testid="poc-add-button"
        disabled={disabled || !companyId}
        onClick={() => {
          setDraft(EMPTY_CONTACT);
          setSaveError(null);
          setSuggestions([]);
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
                onChange={(e) => setDraft((prev) => ({ ...prev, firstName: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-last-name">Last name <span className="text-red-500">*</span></Label>
              <Input
                id="poc-last-name"
                data-testid="poc-last-name"
                value={draft.lastName}
                onChange={(e) => setDraft((prev) => ({ ...prev, lastName: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-email">Email</Label>
              <Input
                id="poc-email"
                data-testid="poc-email"
                value={draft.email}
                onChange={(e) => setDraft((prev) => ({ ...prev, email: e.target.value }))}
              />
            </div>
            <div className="space-y-1">
              <Label htmlFor="poc-phone">Phone</Label>
              <Input
                id="poc-phone"
                data-testid="poc-phone"
                value={draft.phone}
                onChange={(e) => setDraft((prev) => ({ ...prev, phone: e.target.value }))}
              />
            </div>
            <div className="space-y-1 sm:col-span-2">
              <Label htmlFor="poc-job-title">Job title</Label>
              <Input
                id="poc-job-title"
                data-testid="poc-job-title"
                value={draft.jobTitle}
                onChange={(e) => setDraft((prev) => ({ ...prev, jobTitle: e.target.value }))}
              />
            </div>
          </div>

          {suggestions.length ? (
            <div className="space-y-2 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm">
              <p className="text-amber-900">
                Someone with this name already exists. Use them instead of creating a duplicate:
              </p>
              {suggestions.map((s) => (
                <div key={s.id} className="flex items-center justify-between gap-2" data-testid="poc-suggestion">
                  <span>
                    {s.firstName} {s.lastName}
                    {s.companyName ? ` · ${s.companyName}` : ""}
                  </span>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    onClick={() => {
                      onChange(s.id);
                      closeDialog();
                    }}
                  >
                    Use this contact
                  </Button>
                </div>
              ))}
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
              onClick={() => saveNewContact(suggestions.length > 0)}
            >
              {saving ? "Saving..." : suggestions.length ? "Create anyway" : "Save contact"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
