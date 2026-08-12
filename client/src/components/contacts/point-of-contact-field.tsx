import { useMemo } from "react";
import { Button } from "@/components/ui/button";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { useCompanyContacts } from "@/hooks/use-companies";

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
  const { contacts, loading } = useCompanyContacts(companyId || undefined, { officeId });

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
      >
        + Add new contact
      </Button>
    </div>
  );
}
