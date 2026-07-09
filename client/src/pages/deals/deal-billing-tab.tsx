import { useState } from "react";
import { api } from "@/lib/api";
import { type DealDetail } from "@/hooks/use-deals";
import { createContact } from "@/hooks/use-contacts";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { useFiles } from "@/hooks/use-files";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";

const emptyNewC = { firstName: "", lastName: "", email: "", phone: "", jobTitle: "", companyName: "" };

export function DealBillingTab({ deal, onDealUpdated }: { deal: DealDetail; onDealUpdated: () => void }) {
  const { files: contractFiles, refetch: refetchFiles } = useFiles({ dealId: deal.id, category: "contract" });

  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null }>>([]);
  const [saving, setSaving] = useState(false);

  // inline add-contact dialog state
  const [dialogOpen, setDialogOpen] = useState(false);
  const [newC, setNewC] = useState(emptyNewC);
  const [creating, setCreating] = useState(false);

  const runSearch = (q: string) => {
    setQuery(q);
    if (q.trim().length < 2) { setResults([]); return; }
    api<{ contacts: Array<{ id: string; firstName: string; lastName: string; email: string | null; companyName: string | null; category: string }> }>(
      `/contacts/search?q=${encodeURIComponent(q.trim())}&limit=10`
    ).then((res) => { setResults(res.contacts); });
  };

  const assign = async (contactId: string) => {
    setSaving(true);
    return api<{ deal: DealDetail }>(`/deals/${deal.id}`, {
      method: "PATCH",
      json: { billingContactId: contactId },
    }).then(
      () => {
        setResults([]);
        setQuery("");
        onDealUpdated();
        setSaving(false);
      },
      () => {
        setSaving(false);
      }
    );
  };

  const handleCreate = async () => {
    setCreating(true);
    try {
      const res = await createContact(
        {
          firstName: newC.firstName.trim(),
          lastName: newC.lastName.trim(),
          email: newC.email.trim() || null,
          phone: newC.phone.trim() || null,
          jobTitle: newC.jobTitle.trim() || null,
          companyName: newC.companyName.trim() || null,
          category: "client",
          skipDedupCheck: true,
        },
        {},
      );
      if (res.contact) {
        setDialogOpen(false);
        setNewC(emptyNewC);
        await assign(res.contact.id);
      }
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
        onChange={(e) => setNewC((prev) => ({ ...prev, [name]: e.target.value }))}
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
          <p className="mt-2 text-sm text-amber-700">No billing contact assigned yet — required before this deal can be marked Won.</p>
        )}
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
            onClick={() => { setNewC(emptyNewC); setDialogOpen(true); }}
            className="text-xs text-blue-600 hover:underline"
          >
            + Add new contact
          </button>
        </div>
      </section>

      <section className="rounded-xl border border-slate-200 bg-white p-4">
        <h3 className="text-sm font-semibold text-slate-800">Signed contract <span className="font-normal text-slate-400">(optional)</span></h3>
        {contractFiles.length > 0 ? (
          <ul className="mt-2 space-y-1 text-sm">
            {contractFiles.map((f) => (
              <li key={f.id} className="text-slate-700">{f.displayName}</li>
            ))}
          </ul>
        ) : null}
        <div className="mt-3">
          <FileUploadZone category="contract" dealId={deal.id} compact onUploadComplete={() => refetchFiles()} />
        </div>
      </section>

      <Dialog open={dialogOpen} onOpenChange={setDialogOpen}>
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
          <DialogFooter>
            <button
              type="button"
              disabled={creating}
              onClick={() => setDialogOpen(false)}
              className="rounded-md border border-slate-300 px-3 py-1.5 text-sm"
            >
              Cancel
            </button>
            <button
              type="button"
              disabled={creating || !newC.firstName.trim() || !newC.lastName.trim()}
              onClick={handleCreate}
              className="rounded-md bg-blue-600 px-3 py-1.5 text-sm text-white hover:bg-blue-700 disabled:opacity-50"
            >
              Save
            </button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
