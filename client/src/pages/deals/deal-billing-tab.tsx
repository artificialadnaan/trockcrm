import { useRef, useState } from "react";
import { api } from "@/lib/api";
import { type DealDetail } from "@/hooks/use-deals";
import { createContact } from "@/hooks/use-contacts";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { useFiles } from "@/hooks/use-files";
import { getOfficeRequestOptions } from "@/lib/office-selection";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const emptyNewC = { firstName: "", lastName: "", email: "", phone: "", jobTitle: "", companyName: "" };
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

  const closeDialog = () => { setDialogOpen(false); setNewC(emptyNewC); setSuggestions([]); setCreateError(null); };

  const buildInput = () => ({
    firstName: newC.firstName.trim(),
    lastName: newC.lastName.trim(),
    email: newC.email.trim() || null,
    phone: newC.phone.trim() || null,
    jobTitle: newC.jobTitle.trim() || null,
    companyName: newC.companyName.trim() || null,
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
        onChange={(e) => {
          const value = e.target.value;
          setNewC((prev) => ({ ...prev, [name]: value }));
          // A changed payload invalidates the warned-about duplicate set, so drop it (a later Save re-checks).
          setSuggestions([]);
          setCreateError(null);
        }}
        className="w-full rounded-md border border-slate-300 px-2 py-1.5 text-sm"
      />
    </div>
  );

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
          </div>
        ) : (
          <p className="mt-2 text-sm text-amber-700">No billing contact assigned yet — this will be required to mark the deal Won.</p>
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
                      className="w-full px-2 py-1.5 text-left text-sm hover:bg-slate-50"
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
              onClick={() => { setNewC(emptyNewC); setSuggestions([]); setCreateError(null); setDialogOpen(true); }}
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
            {field("companyName", "Company")}
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
              disabled={creating || !newC.firstName.trim() || !newC.lastName.trim()}
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
