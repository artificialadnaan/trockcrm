import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { type DealDetail } from "@/hooks/use-deals";
import { createContact } from "@/hooks/use-contacts";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { useFiles } from "@/hooks/use-files";
import { getOfficeRequestOptions } from "@/lib/office-selection";
import { CompanySelector } from "@/components/companies/company-selector";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const emptyNewC = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  jobTitle: "",
  address: "",
  city: "",
  state: "",
  zip: "",
};
type Suggestion = { id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; matchReason?: string; isActive?: boolean };

export function DealBillingTab({ deal, onDealUpdated, canEdit, officeId }: { deal: DealDetail; onDealUpdated: () => void; canEdit: boolean; officeId?: string | null }) {
  const { files: contractFiles, refetch: refetchFiles } = useFiles({ dealId: deal.id, category: "contract" });

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null }>>([]);
  const [saving, setSaving] = useState(false);
  // Guards against a slow earlier /contacts/search response landing after a newer query and overwriting it.
  const searchSeq = useRef(0);

  // inline add-contact dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newC, setNewC] = useState(emptyNewC);
  const [creating, setCreating] = useState(false);
  // Possible-duplicate matches returned by the FIRST (dedup-enabled) create attempt.
  const [suggestions, setSuggestions] = useState<Suggestion[]>([]);
  const [createError, setCreateError] = useState<string | null>(null);
  const [assignError, setAssignError] = useState<string | null>(null);
  // Linked CRM company for the add-contact dialog (chosen via CompanySelector, which also supports adding a
  // new company inline). null = no company. Replaces the old free-text company field.
  const [companyId, setCompanyId] = useState<string | null>(null);
  // Company NAME captured alongside the id so the created contact's company_name isn't blank in surfaces that
  // read contacts.company_name without joining companies (email review / assignment queues) (Codex P2).
  const [companyName, setCompanyName] = useState<string | null>(null);
  // Stale-response guard for the async company-name fetch (mirrors searchSeq): only the latest selection's
  // fetch may set companyName, so a slow earlier fetch can't overwrite a newer pick's name.
  const companySeq = useRef(0);
  // True while the selected company's name is still being fetched — Save is blocked until it resolves so a
  // contact can't be created linked by id with a blank company_name (which would also run dedup without the
  // company) (Codex P2).
  const [companyPending, setCompanyPending] = useState(false);
  // True while CompanySelector's own inline "Add New Company" POST is in flight — before it calls onChange with
  // the new id — so Save is blocked and a rep can't submit an unlinked contact mid company-create (Codex P2).
  const [companyCreating, setCompanyCreating] = useState(false);

  const runSearch = (q: string) => {
    setQuery(q);
    // Bump the sequence on EVERY keystroke (including clearing below 2 chars) so a slow earlier response can
    // never repopulate results under a newer/short query.
    const seq = ++searchSeq.current;
    if (q.trim().length < 2) { setResults([]); return; }
    api<{ contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; category: string }> }>(
      `/contacts/search?q=${encodeURIComponent(q.trim())}&limit=10`,
      getOfficeRequestOptions(officeId),
    ).then(
      (res) => { if (seq === searchSeq.current) setResults(res.contacts); },
      () => { if (seq === searchSeq.current) setResults([]); }, // search failed — clear rather than leave stale
    );
  };

  const assign = async (contactId: string) => {
    setSaving(true);
    setAssignError(null);
    // Send the PATCH to the office the deal was LOADED from (cross-office view via ?officeId=), not the
    // viewer's default active office — otherwise the assignment 404s or updates the wrong tenant's deal.
    return api<{ deal: DealDetail }>(`/deals/${deal.id}`, {
      method: "PATCH",
      json: { billingContactId: contactId },
      ...getOfficeRequestOptions(officeId),
    }).then(
      () => {
        setResults([]);
        setQuery("");
        onDealUpdated();
        setSaving(false);
      },
      (e) => {
        // Surface the failure — otherwise (notably right after an inline create closes the dialog) the user is
        // left with a newly created but UNASSIGNED contact and no indication anything went wrong.
        setSaving(false);
        setAssignError(e instanceof Error ? e.message : "Could not assign the billing contact — please try again.");
      }
    );
  };

  const closeDialog = () => { setDialogOpen(false); setNewC(emptyNewC); setCompanyId(null); setCompanyName(null); setCompanyPending(false); setCompanyCreating(false); ++companySeq.current; setSuggestions([]); setCreateError(null); };

  const buildInput = () => ({
    firstName: newC.firstName.trim(),
    lastName: newC.lastName.trim(),
    email: newC.email.trim() || null,
    phone: newC.phone.trim() || null,
    jobTitle: newC.jobTitle.trim() || null,
    address: newC.address.trim() || null,
    city: newC.city.trim() || null,
    state: newC.state.trim().toUpperCase() || null,
    zip: newC.zip.trim() || null,
    companyId: companyId || undefined,
    companyName: companyName ?? undefined,
    category: "client",
  });

  // The first attempt runs WITH dedup (skipDedupCheck: false) so a look-alike active CRM contact surfaces as a
  // pickable suggestion instead of becoming a silent duplicate. Only "Create anyway" (force) re-runs with the
  // check skipped, after the user has seen the suggestions. A hard duplicate (e.g. exact email) throws — caught
  // and surfaced. Editing any field clears the stale suggestions so a forced create can't reuse an unreviewed
  // payload.
  const handleCreate = async (force = false) => {
    setCreating(true);
    setCreateError(null);
    try {
      const res = await createContact({ ...buildInput(), skipDedupCheck: force }, { officeId });
      if (res.contact) {
        closeDialog();
        await assign(res.contact.id);
      } else if (res.dedupWarning && res.suggestions?.length) {
        // Only offer ACTIVE contacts (the dedup path can surface soft-deleted/merged records); assigning an
        // inactive one would point the deal at a stale record.
        setSuggestions((res.suggestions as Suggestion[]).filter((s) => s.isActive !== false));
      }
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : "Could not create the contact.");
    } finally {
      setCreating(false);
    }
  };

  const field = (name: keyof typeof emptyNewC, label: string, type = "text") => (
    <div>
      <label className="block text-xs font-medium text-slate-600 mb-1">{label}</label>
      <input
        type={type}
        name={name}
        value={newC[name]}
        // Locked while a create is in flight so the user can't edit a payload out from under a pending dedup
        // check and then force-create unreviewed values (Codex P2).
        disabled={creating}
        onChange={(e) => {
          const value = e.target.value;
          setNewC((prev) => ({ ...prev, [name]: value }));
          // A changed payload invalidates the warned-about duplicate set, so drop it (a later Save re-checks).
          setSuggestions([]);
          setCreateError(null);
        }}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm disabled:bg-slate-50"
      />
    </div>
  );

  const billingAddress = [
    deal.billingContactAddress,
    [deal.billingContactCity, deal.billingContactState].filter(Boolean).join(", "),
    deal.billingContactZip,
  ].filter(Boolean).join(", ");

  return (
    <div className="space-y-6">
      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">Billing contact</h3>
        {deal.billingContactId ? (
          <div className="mt-2 text-sm text-slate-700">
            <div className="font-semibold">{deal.billingContactName ?? "Unknown contact"}</div>
            {deal.billingContactCompany ? <div className="text-slate-500">{deal.billingContactCompany}</div> : null}
            {deal.billingContactTitle ? <div className="text-slate-500">{deal.billingContactTitle}</div> : null}
            {deal.billingContactEmail ? <div className="text-slate-500">{deal.billingContactEmail}</div> : null}
            {deal.billingContactPhone ? <div className="text-slate-500">{deal.billingContactPhone}</div> : null}
            {billingAddress ? <div className="mt-1 text-slate-500">{billingAddress}</div> : null}
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-700">No billing contact assigned yet — add one before this deal closes.</p>
        )}
        {assignError ? (
          <p className="mt-2 rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700">{assignError}</p>
        ) : null}
        {canEdit ? (
          <div className="mt-3 space-y-2">
            <input
              type="search"
              placeholder="Search contacts…"
              value={query}
              disabled={saving}
              onChange={(e) => runSearch(e.target.value)}
              className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
            />
            {results.length > 0 ? (
              <ul className="mt-1 divide-y divide-slate-100 rounded-md border border-slate-200">
                {results.map((c) => (
                  <li key={c.id}>
                    <button
                      type="button"
                      // Disabled while a PATCH is in flight so a second click can't fire a concurrent assign
                      // whose response could land last and win over the intended one (Codex P2).
                      disabled={saving}
                      className="w-full px-2 py-1.5 text-left text-sm hover:bg-slate-50 disabled:opacity-50"
                      onClick={() => assign(c.id)}
                    >
                      {c.firstName} {c.lastName}{c.companyName ? ` — ${c.companyName}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            <button
              type="button"
              disabled={saving}
              onClick={() => { setNewC(emptyNewC); setCompanyId(null); setCompanyName(null); setCompanyPending(false); setCompanyCreating(false); ++companySeq.current; setSuggestions([]); setCreateError(null); setDialogOpen(true); }}
              className="text-xs text-blue-600 hover:underline"
            >
              + Add new contact
            </button>
          </div>
        ) : (
          // Read-only: the deal PATCH is owner-gated, so a non-owner viewer must not get edit controls that
          // would 403 after they've searched or created a contact (Codex P2).
          <p className="mt-3 text-xs text-slate-400">Only the assigned rep can edit billing.</p>
        )}
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        {/* "Contract", not "Signed contract": the file category is a generic contract bucket (drafts / MSAs /
            SOWs auto-classify here too), so we don't claim every file is signed. Upload is gated by FILE-
            collaborator access (server-enforced in files/routes), NOT the owner-only billing PATCH — so a
            same-office collaborator can add a contract here just like on the Files tab (Codex P3). */}
        <h3 className="text-sm font-semibold text-slate-800">Contract <span className="font-normal text-slate-400">(optional)</span></h3>
        {contractFiles.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm">
            {contractFiles.map((f) => (
              <li key={f.id} className="text-slate-700">{f.displayName}</li>
            ))}
          </ul>
        ) : (
          <p className="mt-2 text-sm text-slate-400">No contract uploaded.</p>
        )}
        <div className="mt-3">
          <FileUploadZone category="contract" dealId={deal.id} compact onUploadComplete={() => refetchFiles()} />
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={(open) => { if (!open) closeDialog(); else setDialogOpen(true); }}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add new contact</DialogTitle>
          </DialogHeader>
          <div className="space-y-3 py-2">
            {field("firstName", "First name *")}
            {field("lastName", "Last name *")}
            {field("email", "Email", "email")}
            {field("phone", "Phone", "tel")}
            {field("jobTitle", "Job title")}
            <div className="border-t border-slate-100 pt-3">
              <p className="text-xs font-semibold text-slate-700">Billing address</p>
              <div className="mt-2 space-y-3">
                {field("address", "Street address")}
                <div className="grid grid-cols-2 gap-3">
                  {field("city", "City")}
                  {field("state", "State")}
                </div>
                {field("zip", "ZIP")}
              </div>
            </div>
            <div>
              <label className="block text-xs font-medium text-slate-600 mb-1">Company</label>
              {/* Query CRM companies (with inline add-new), same selector the deal/lead forms use — instead of
                  free text — so the contact links to a real company record. Frozen while a create is in flight
                  (fieldset disables its inner controls) so a late change can't diverge from the submitted
                  payload; changing it clears any stale dedup warning (Codex P2). */}
              <fieldset disabled={creating} className="m-0 min-w-0 border-0 p-0">
                <CompanySelector
                  value={companyId}
                  onChange={(id) => {
                    setCompanyId(id);
                    setSuggestions([]);
                    setCreateError(null);
                    // Clear the previous company's name synchronously and block Save (companyPending) until the
                    // new name resolves, so a save-before-this-fetch-resolves can't create a contact linked by id
                    // with a blank company_name (which would also run the dedup check without the company). The
                    // selector only emits the id, so fetch the chosen company's NAME. Gate the async result by a
                    // sequence counter (like searchSeq) so a slow earlier fetch can't overwrite a newer selection's
                    // name, and only the latest fetch clears companyPending (Codex P2).
                    setCompanyName(null);
                    setCompanyPending(true);
                    const seq = ++companySeq.current;
                    api<{ company: { name: string } }>(`/companies/${id}`, getOfficeRequestOptions(officeId))
                      .then((r) => { if (seq === companySeq.current) { setCompanyName(r.company?.name ?? null); setCompanyPending(false); } })
                      .catch(() => { if (seq === companySeq.current) { setCompanyName(null); setCompanyPending(false); } });
                  }}
                  officeId={officeId}
                  onBusyChange={setCompanyCreating}
                />
              </fieldset>
              {companyPending || companyCreating ? <p className="mt-1 text-xs text-slate-400">Loading company…</p> : null}
            </div>
          </div>
          {createError ? (
            <p className="rounded-md border border-red-200 bg-red-50 px-2 py-1.5 text-sm text-red-700">{createError}</p>
          ) : null}
          {suggestions.length > 0 ? (
            <div className="rounded-md border border-amber-200 bg-amber-50 p-2 text-sm">
              <p className="font-medium text-amber-800">A similar contact may already exist — use one of these instead?</p>
              <ul className="mt-1 divide-y divide-amber-100">
                {suggestions.map((s) => (
                  <li key={s.id}>
                    <button
                      type="button"
                      disabled={creating || saving}
                      className="w-full px-1 py-1 text-left hover:bg-amber-100"
                      onClick={async () => { closeDialog(); await assign(s.id); }}
                    >
                      {s.firstName} {s.lastName}{s.companyName ? ` — ${s.companyName}` : ""}
                    </button>
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
          <DialogFooter>
            <button
              type="button"
              disabled={creating}
              onClick={closeDialog}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={creating || companyPending || companyCreating || !newC.firstName.trim() || !newC.lastName.trim()}
              onClick={() => handleCreate(suggestions.length > 0)}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              {suggestions.length > 0 ? "Create anyway" : "Save"}
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
