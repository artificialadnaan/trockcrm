# Required Point of Contact on a new Service Opportunity — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A Service Opportunity cannot be created without a point of contact, and the rep can add a new contact without leaving the form.

**Architecture:** One guard clause on the dedicated `POST /deals/service-opportunity` route (no other deal path, no migration, column stays nullable), plus a new self-contained `PointOfContactField` component on the create form. The component ports the pattern already proven in `lead-form.tsx`, which has shipped this exact interaction — company-scoped `Select` with an `items` prop and an inline "+ Add new contact" dialog.

**Tech Stack:** TypeScript, React 19, Base UI `Select` (`@base-ui/react/select`), Express, Drizzle, Vitest (jsdom for client, supertest for server).

---

## Working context

**Worktree:** `/Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact`
**Branch:** `feat/service-opportunity-required-contact`, cut from `origin/main` at `dd24165ce`.

**Before the first task, install dependencies in the worktree:**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact && npm install
```

This is not optional. Without its own `node_modules`, `@trock-crm/shared` resolves to the **main checkout**, and typecheck reports results for code you are not editing.

**Never run `git stash`** — the stash stack is shared across all worktrees and has already lost work here. Commit work-in-progress to this branch instead. **`git add` by explicit path, never `-A`.** No prettier or format passes: this source is hand-formatted.

**Do not touch the main checkout** at `/Users/adnaaniqbal/Developer/trockcrm`. It sits on `feat/deal-billing-tab` with uncommitted work.

---

## Existing code this builds on

Read these before starting. Most of this feature already exists elsewhere; the job is to port it, not invent it.

| What | Where | Why it matters |
|---|---|---|
| The same feature, already shipped | `client/src/components/leads/lead-form.tsx:1584-1640` | Label "Point of Contact", `Select` with `items`, `+ Add new contact` button, inline create at `:1110` |
| Company-scoped contact loader | `client/src/hooks/use-companies.ts:200` `useCompanyContacts(companyId, options)` | Returns `{ contacts, loading, error, refetch }` of `CompanyContact` |
| Contact creation with dedup | `client/src/hooks/use-contacts.ts:257` `createContact` | Returns `{ contact: Contact \| null, dedupWarning?, suggestions? }`; `contact` is `null` when dedup blocks |
| Dedup-suggestion handling | `client/src/pages/deals/deal-billing-tab.tsx:228-236` | The reference for showing suggestions and a "create anyway" path |
| The route to guard | `server/src/modules/deals/routes.ts:2351-2353` | `if (!companyId \|\| !propertyId)` — the new guard goes directly after |
| Server contact validation | `server/src/modules/deals/service.ts:1936` `validateDealPrimaryContact` | Already enforces exists + active + belongs-to-company. Do not modify it. |

**`Select` requires an `items` prop.** This is Base UI, not Radix. Without `items`, the trigger renders the raw value (a UUID) instead of the contact's name. Every `Select` you write in this plan passes `items`.

---

## File structure

**Create:**
- `client/src/components/contacts/point-of-contact-field.tsx` — the whole field: company-scoped picker, empty state, and the add-contact dialog. Self-contained so the 626-line service opportunity form does not grow by another 200 lines.
- `client/src/components/contacts/point-of-contact-field.test.tsx` — component tests.

**Modify:**
- `server/src/modules/deals/routes.ts` — one guard clause.
- `server/tests/modules/deals/create-route.test.ts` — one new test, six existing payloads updated.
- `client/src/hooks/use-deals.ts` — add `primaryContactId` to `CreateServiceOpportunityInput`.
- `client/src/components/deals/service-opportunity-form.tsx` — form state, clear-on-company-change, validation guard, payload, render the field.
- `client/src/components/deals/service-opportunity-form.test.tsx` — form-level tests.

**Deliberately NOT changed:** the `deals.primary_contact_id` column (stays nullable), `validateDealPrimaryContact`, `POST /deals`, lead conversion, Bid Board sync, RFP ingestion, and `lead-form.tsx`.

---

## Task 1: Server — require the point of contact on the service-opportunity route

**Files:**
- Modify: `server/src/modules/deals/routes.ts:2351-2353`
- Test: `server/tests/modules/deals/create-route.test.ts`

The guard sits directly after the company/property check, which means it fires **before** the project-type and property-hierarchy checks. Six existing tests post to this route without a contact; they must be given one first, or they will start failing with the wrong error message.

- [ ] **Step 1: Add a contact to the six existing service-opportunity test payloads**

In `server/tests/modules/deals/create-route.test.ts`, add `primaryContactId: "contact-1",` to the `.send({...})` body of each of these tests (all six post to `/api/deals/service-opportunity`):

| Line (approx) | Test name |
|---|---|
| 274 | `creates a direct Service opportunity with service workflow routing and canonical Opportunity stage` |
| 312 | `rejects a non-Service project type on the Service opportunity endpoint` |
| 328 | `rejects a Service opportunity when the property does not belong to the selected company` |
| 349 | `ignores hostile server-owned fields on the Service opportunity endpoint` |
| 388 | `forwards bidDueDate through the Service opportunity endpoint` |
| 411 | `forwards regionId and winProbability through the Service opportunity endpoint (so region/forecast reports can read them)` |

Example — the test at line 274 becomes:

```ts
      .send({
        name: "SMOKE TEST DELETE Service Opportunity",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        primaryContactId: "contact-1",
        projectTypeId: "type-service",
      });
```

Also add `primaryContactId: "contact-1",` to the `expect.objectContaining({...})` assertion in that same test, since the route forwards it to `createDeal`.

- [ ] **Step 2: Run the suite — it must still be green**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/server && npx vitest run tests/modules/deals/create-route.test.ts
```

Expected: PASS. The route already accepts `primaryContactId` and ignores nothing — adding it changes no behaviour yet. If anything fails here, stop: the payloads were edited wrongly.

- [ ] **Step 3: Write the failing test**

Add to `server/tests/modules/deals/create-route.test.ts`, directly after the test at line 274:

```ts
  it("rejects a Service opportunity with no point of contact", async () => {
    const res = await request(createApp("dallas"))
      .post("/api/deals/service-opportunity")
      .send({
        name: "SMOKE TEST DELETE No Contact",
        assignedRepId: "rep-1",
        companyId: "company-1",
        propertyId: "property-1",
        projectTypeId: "type-service",
      });

    expect(res.status).toBe(400);
    expect(res.body.error.message).toBe("Point of contact is required");
    // The deal must not be created — a 400 that still wrote the row would be worse than no guard.
    expect(dealsServiceMocks.createDeal).not.toHaveBeenCalled();
  });

  it("does NOT require a point of contact on the generic deal endpoint", async () => {
    // The guard must not leak. Bid Board sync, RFP ingestion, imports and lead conversion all create
    // contact-less deals through POST /deals, and every one of them would break if it did.
    const res = await request(createApp("dallas")).post("/api/deals").send(validBody());

    expect(res.status).toBe(201);
    expect(dealsServiceMocks.createDeal).toHaveBeenCalled();
  });
```

- [ ] **Step 4: Run it and confirm it FAILS**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/server && npx vitest run tests/modules/deals/create-route.test.ts -t "no point of contact"
```

Expected: FAIL — `expected 201 to be 400`. If it passes, the guard already exists and this plan is stale; stop and re-read the route.

- [ ] **Step 5: Add the guard**

In `server/src/modules/deals/routes.ts`, immediately after the company/property check at line 2351-2353:

```ts
    if (!companyId || !propertyId) {
      throw new AppError(400, "Company and property are required");
    }
    // A Service Opportunity with no person on it leaves the service crew with a job, an address and nobody
    // to call. Enforced HERE rather than on the column: every other deal path — Bid Board sync, RFP
    // ingestion, imports, lead conversion — legitimately creates contact-less deals, so this is a property
    // of this create flow, not of the record. validateDealPrimaryContact (called inside createDeal) still
    // does the exists/active/belongs-to-company checks.
    if (!primaryContactId) {
      throw new AppError(400, "Point of contact is required");
    }
```

- [ ] **Step 6: Run the whole file and confirm everything passes**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/server && npx vitest run tests/modules/deals/create-route.test.ts
```

Expected: PASS, including the new test and all six updated ones.

- [ ] **Step 7: Commit**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact
git add server/src/modules/deals/routes.ts server/tests/modules/deals/create-route.test.ts
git commit -m "feat(deals): require a point of contact to create a Service Opportunity

The service crew was getting a job and an address with nobody to call. Guarded on the dedicated
service-opportunity route rather than the column, so no other deal creation path is affected."
```

---

## Task 2: The `PointOfContactField` component — picker and empty states

**Files:**
- Create: `client/src/components/contacts/point-of-contact-field.tsx`
- Test: `client/src/components/contacts/point-of-contact-field.test.tsx`

The dialog comes in Task 3. This task builds the picker only, so it can be verified on its own.

- [ ] **Step 1: Write the failing test**

Create `client/src/components/contacts/point-of-contact-field.test.tsx`:

```tsx
/**
 * @vitest-environment jsdom
 */
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PointOfContactField } from "./point-of-contact-field";

const mocks = vi.hoisted(() => ({
  useCompanyContacts: vi.fn(),
  createContact: vi.fn(),
}));

vi.mock("@/hooks/use-companies", () => ({ useCompanyContacts: mocks.useCompanyContacts }));
vi.mock("@/hooks/use-contacts", () => ({ createContact: mocks.createContact }));

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  mocks.useCompanyContacts.mockReturnValue({
    contacts: [
      { id: "contact-1", firstName: "Dana", lastName: "Reyes", email: null, phone: null, jobTitle: null, category: "client" },
    ],
    loading: false,
    error: null,
    refetch: vi.fn(),
  });
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.clearAllMocks();
});

function render(props: Partial<React.ComponentProps<typeof PointOfContactField>> = {}) {
  act(() => {
    root.render(
      <PointOfContactField
        companyId="company-1"
        value=""
        onChange={vi.fn()}
        officeId="office-1"
        {...props}
      />
    );
  });
}

describe("PointOfContactField", () => {
  it("tells the rep to pick a company first, and disables the add button, when there is no company", () => {
    render({ companyId: "" });
    expect(container.textContent).toContain("Select a company first");
    const addButton = container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']");
    expect(addButton?.disabled).toBe(true);
  });

  it("does not query for contacts when no company is selected", () => {
    render({ companyId: "" });
    // undefined, not "" — useCompanyContacts skips the request entirely on a falsy id, and passing ""
    // would still be a distinct cache key that fetches nothing useful.
    expect(mocks.useCompanyContacts).toHaveBeenCalledWith(undefined, { officeId: "office-1" });
  });

  it("scopes the contact list to the selected company", () => {
    render({ companyId: "company-1" });
    expect(mocks.useCompanyContacts).toHaveBeenCalledWith("company-1", { officeId: "office-1" });
  });

  it("offers adding a contact when the company has none", () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    render();
    expect(container.textContent).toContain("No contacts on this company yet");
    expect(container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")?.disabled).toBe(false);
  });
});
```

- [ ] **Step 2: Run it and confirm it FAILS**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/contacts/point-of-contact-field.test.tsx
```

Expected: FAIL — cannot resolve `./point-of-contact-field`.

- [ ] **Step 3: Write the component**

Create `client/src/components/contacts/point-of-contact-field.tsx`:

```tsx
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
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/contacts/point-of-contact-field.test.tsx
```

Expected: PASS, 4 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact
git add client/src/components/contacts/point-of-contact-field.tsx client/src/components/contacts/point-of-contact-field.test.tsx
git commit -m "feat(contacts): company-scoped point-of-contact picker"
```

---

## Task 3: Inline "Add new contact" dialog

**Files:**
- Modify: `client/src/components/contacts/point-of-contact-field.tsx`
- Test: `client/src/components/contacts/point-of-contact-field.test.tsx`

The created contact is linked to the selected company, which is what makes it pass the server's company-membership check. Dedup is left **on** (unlike `lead-form.tsx`, which passes `skipDedupCheck: true`) so the shortcut cannot quietly mint a second copy of someone already in the CRM.

- [ ] **Step 1: Write the failing tests**

Append to the `describe("PointOfContactField", ...)` block in `point-of-contact-field.test.tsx`:

```tsx
  it("creates the contact against the selected company and selects it", async () => {
    const onChange = vi.fn();
    const refetch = vi.fn();
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch });
    mocks.createContact.mockResolvedValue({ contact: { id: "contact-9", firstName: "Ada", lastName: "Lowe" } });
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    // companyId is what keeps the new contact valid against the server's company-membership check.
    expect(mocks.createContact).toHaveBeenCalledWith(
      expect.objectContaining({ firstName: "Ada", lastName: "Lowe", companyId: "company-1", category: "client" }),
      { officeId: "office-1" }
    );
    // Dedup must NOT be skipped on the first attempt.
    expect(mocks.createContact.mock.calls[0][0].skipDedupCheck).toBeFalsy();
    expect(refetch).toHaveBeenCalled();
    expect(onChange).toHaveBeenCalledWith("contact-9");
  });

  it("shows duplicate suggestions instead of selecting nothing when dedup blocks the create", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    mocks.createContact.mockResolvedValue({
      contact: null,
      dedupWarning: true,
      suggestions: [
        { id: "contact-5", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Acme", matchReason: "same name", isActive: true },
        { id: "contact-6", firstName: "Ada", lastName: "Lowe", email: null, companyName: "Old", matchReason: "same name", isActive: false },
      ],
    });
    const onChange = vi.fn();
    render({ onChange });

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    setFieldValue("poc-first-name", "Ada");
    setFieldValue("poc-last-name", "Lowe");
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    expect(onChange).not.toHaveBeenCalled();
    // Only ACTIVE suggestions are offered — assigning a soft-deleted/merged record would point the deal at
    // a stale contact.
    const offered = container.querySelectorAll("[data-testid='poc-suggestion']");
    expect(offered.length).toBe(1);
    expect(container.textContent).toContain("Acme");
    expect(container.textContent).not.toContain("Old");
  });

  it("requires a first and last name before it will call the API", async () => {
    mocks.useCompanyContacts.mockReturnValue({ contacts: [], loading: false, error: null, refetch: vi.fn() });
    render();

    act(() => container.querySelector<HTMLButtonElement>("[data-testid='poc-add-button']")!.click());
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='poc-save']")!.click();
    });

    expect(mocks.createContact).not.toHaveBeenCalled();
    expect(container.textContent).toContain("First and last name are required");
  });
```

Add this helper directly above the `describe` block:

```tsx
function setFieldValue(testId: string, value: string) {
  const input = container.querySelector<HTMLInputElement>(`[data-testid='${testId}']`)!;
  const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, "value")!.set!;
  act(() => {
    setter.call(input, value);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
```

- [ ] **Step 2: Run and confirm they FAIL**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/contacts/point-of-contact-field.test.tsx
```

Expected: the three new tests FAIL (no `poc-first-name` / `poc-save` elements exist yet).

- [ ] **Step 3: Add the dialog to the component**

In `point-of-contact-field.tsx`, replace the imports and add dialog state. Full replacement for the import block:

```tsx
import { useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { useCompanyContacts } from "@/hooks/use-companies";
import { createContact } from "@/hooks/use-contacts";
```

Add above the component:

```tsx
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
```

Inside the component, after the `useCompanyContacts` call:

```tsx
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
```

Give the add button an `onClick`:

```tsx
        onClick={() => {
          setDraft(EMPTY_CONTACT);
          setSaveError(null);
          setSuggestions([]);
          setDialogOpen(true);
        }}
```

And render the dialog immediately before the component's closing `</div>`:

```tsx
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
```

Note the picked suggestion may belong to another company. That is acceptable here only because the rep is choosing a **duplicate of the person they were creating for this company**; if the server rejects it on save, the form surfaces that error. Do not add a client-side company filter to suggestions — the dedup endpoint's whole job is to find cross-company duplicates.

- [ ] **Step 4: Run and confirm all pass**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/contacts/point-of-contact-field.test.tsx
```

Expected: PASS, 7 tests.

- [ ] **Step 5: Commit**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact
git add client/src/components/contacts/point-of-contact-field.tsx client/src/components/contacts/point-of-contact-field.test.tsx
git commit -m "feat(contacts): inline add-contact on the point-of-contact picker

Dedup stays ON, unlike the lead form's skipDedupCheck path — a one-click shortcut that quietly mints a
second copy of an existing person is worse than the extra confirmation."
```

---

## Task 4: Wire the field into the Service Opportunity form

**Files:**
- Modify: `client/src/hooks/use-deals.ts:784-800`
- Modify: `client/src/components/deals/service-opportunity-form.tsx` (state `:97`, `handleChange` `:221`, validation `:274`, payload `:319`, render `:447`)
- Test: `client/src/components/deals/service-opportunity-form.test.tsx`

- [ ] **Step 1: Write the failing tests**

Add to `client/src/components/deals/service-opportunity-form.test.tsx`. The file already mocks `@/hooks/use-deals`; add a mock for the new field so these tests drive it directly rather than through Base UI's portal:

```tsx
vi.mock("@/components/contacts/point-of-contact-field", () => ({
  PointOfContactField: ({ companyId, value, onChange }: { companyId: string; value: string; onChange: (id: string) => void }) => (
    <div>
      <span data-testid="poc-company">{companyId}</span>
      <span data-testid="poc-value">{value}</span>
      <button type="button" data-testid="poc-pick" onClick={() => onChange("contact-1")}>
        pick contact
      </button>
    </div>
  ),
}));
```

Then the tests:

These follow the idiom already used in this file: `renderForm()` is async and returns `{ container, root }`,
inputs are driven through `setInputValue`, the mocked selectors are clicked by button text, and submit is
dispatched as an event (this file does not use `requestSubmit`).

```tsx
  it("refuses to create without a point of contact", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(container.querySelector("#name") as HTMLInputElement, "SMOKE TEST DELETE No Contact");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select company")?.click();
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select property")?.click();
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createServiceOpportunity).not.toHaveBeenCalled();
    expect(container.textContent).toContain("Point of contact is required");
  });

  it("sends the chosen point of contact to the API", async () => {
    mocks.createServiceOpportunity.mockResolvedValue({ deal: { id: "deal-1" } });
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      setInputValue(container.querySelector("#name") as HTMLInputElement, "SMOKE TEST DELETE With Contact");
    });
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select company")?.click();
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select property")?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='poc-pick']")?.click();
    });
    await act(async () => {
      container.querySelector("form")?.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
    });

    expect(mocks.createServiceOpportunity).toHaveBeenCalledWith(
      expect.objectContaining({ primaryContactId: "contact-1" }),
      expect.anything()
    );
  });

  it("clears the point of contact when the company changes", async () => {
    const { container, root } = await renderForm();
    containers.push(container);
    roots.push(root);

    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select company")?.click();
    });
    await act(async () => {
      container.querySelector<HTMLButtonElement>("[data-testid='poc-pick']")?.click();
    });
    expect(container.querySelector("[data-testid='poc-value']")?.textContent).toBe("contact-1");

    // A contact belongs to one company; keeping it across a company switch would send the server a pair it
    // rejects, and the rep would not see why. The CompanySelector mock's "Select other company" button
    // emits a DIFFERENT id — the clear is guarded on an actual change, so re-emitting the same id must not
    // wipe anything.
    await act(async () => {
      Array.from(container.querySelectorAll("button")).find((b) => b.textContent === "Select other company")?.click();
    });

    expect(container.querySelector("[data-testid='poc-value']")?.textContent).toBe("");
  });
```

**Before writing the third test, check the `CompanySelector` mock in `setupCommonMocks()` (line 136).** If it
exposes only a single "Select company" button emitting one fixed id, add a second button that emits a
different id (e.g. `company-2`) — without it there is no way to drive an actual company *change*, and a test
that re-emits the same id would pass whether or not the clearing logic works, which is precisely the class of
false-green this codebase has been bitten by three times.

- [ ] **Step 2: Run and confirm they FAIL**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/deals/service-opportunity-form.test.tsx
```

Expected: the three new tests FAIL — no contact field is rendered and no guard exists.

- [ ] **Step 3: Add `primaryContactId` to the create payload type**

In `client/src/hooks/use-deals.ts`, add `| "primaryContactId"` to the `Pick<...>` union in `CreateServiceOpportunityInput` (alphabetically, after `"officeCode"`):

```ts
  | "officeCode"
  | "primaryContactId"
  | "projectNumber"
```

- [ ] **Step 4: Add form state and the clear-on-company-change rule**

In `service-opportunity-form.tsx`, add to the `useState` initialiser at line 97, after `propertyId`:

```ts
    primaryContactId: "",
```

In `handleChange` at line 228, extend the existing company-change branch:

```ts
      if (field === "companyId" && value !== prev.companyId) {
        next.propertyId = "";
        next.propertyState = "";
        // A contact belongs to exactly one company and the server rejects a mismatched pair, so a company
        // switch must drop it for the same reason it drops the property. Guarded on an ACTUAL change: the
        // picker re-emits the company it is already showing on value resolution and remount.
        next.primaryContactId = "";
      }
```

- [ ] **Step 5: Add the validation guard**

In `handleSubmit`, directly after the company/property check at line 274:

```ts
    if (!formData.companyId || !formData.propertyId) {
      setError("Company and property are required");
      return;
    }
    if (!formData.primaryContactId) {
      setError("Point of contact is required");
      return;
    }
```

- [ ] **Step 6: Send it in the payload**

In the `createServiceOpportunity` call at line 319, after `propertyId`:

```ts
          propertyId: formData.propertyId,
          primaryContactId: formData.primaryContactId,
```

Send the value as-is. It is always a non-empty uuid by the time submit is reachable, and the guard above is what guarantees it — an empty string in a uuid column raises Postgres `22P02`, which has bitten this form before.

- [ ] **Step 7: Render the field**

Add the import at the top of `service-opportunity-form.tsx`:

```tsx
import { PointOfContactField } from "@/components/contacts/point-of-contact-field";
```

Insert between the company/property grid (closes at line 447) and the Assigned Sales Rep block at line 449:

```tsx
          <div className="space-y-2">
            <Label htmlFor="primaryContactId">
              Point of Contact <span className="text-red-500">*</span>
            </Label>
            <PointOfContactField
              companyId={formData.companyId}
              value={formData.primaryContactId}
              onChange={(contactId) => handleChange("primaryContactId", contactId)}
              officeId={effectiveOfficeId ?? null}
            />
            <p className="text-xs text-muted-foreground">
              Who the service crew should call about this job.
            </p>
          </div>
```

- [ ] **Step 8: Run the form tests and confirm they pass**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run src/components/deals/service-opportunity-form.test.tsx
```

Expected: PASS, including the three new tests and every pre-existing one.

- [ ] **Step 9: Commit**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact
git add client/src/hooks/use-deals.ts client/src/components/deals/service-opportunity-form.tsx client/src/components/deals/service-opportunity-form.test.tsx
git commit -m "feat(deals): require a point of contact on the Service Opportunity form"
```

---

## Task 5: Full verification

**Files:** none modified.

- [ ] **Step 1: Typecheck**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact && npx tsc --noEmit 2>&1 | tee /tmp/soc-tsc.log | tail -5
grep -cE "error TS" /tmp/soc-tsc.log
```

Expected: **0 errors in the files touched by this plan.** Compare the count against `origin/main` before claiming a regression — this repo carries pre-existing errors.

- [ ] **Step 2: Run the client suite**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/client && npx vitest run 2>&1 | tail -6
```

- [ ] **Step 3: Run the server suite the way CI does**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact/server && npm run test:ci 2>&1 | tail -6
```

`npx vitest run` in `server/` skips ~35 files including `*.runtime.test.ts`. Only `npm run test:ci` matches the gate — do not report a passing server suite from the bare command.

- [ ] **Step 4: Compare against baseline, do not assert "all green"**

Both suites have pre-existing failures on `origin/main`. Record the failing set here, and compare it to `origin/main`'s. Report the **difference**, not the absolute count. Any test that fails in both is not yours; any test that fails only here is.

- [ ] **Step 5: Push**

```bash
cd /Users/adnaaniqbal/Developer/trockcrm/.claude/worktrees/service-opp-contact
git push -u origin feat/service-opportunity-required-contact
```

Do not open a PR or merge. Drive it to clean, then stop and report.

---

## Verification standard for this plan

Every test added here must be **seen failing before it is made to pass**, which is why each task runs the test before writing the implementation. Three tests in this codebase were recently found passing for the wrong reason — an assertion on a string that could never appear, and a fixture whose numbers happened to divide evenly. A green test is not evidence until it has been red.

## Known follow-ups (do NOT do them in this plan)

- `lead-form.tsx` has its own near-identical Point of Contact block and passes `skipDedupCheck: true`. It could adopt `PointOfContactField`, and its dedup skip is worth questioning. Separate change.
- Picking an existing contact from another company still fails the server's company-membership check. Accepted trade-off, recorded in the spec.
