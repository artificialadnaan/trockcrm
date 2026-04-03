import { useState } from "react";
import { CheckCircle2, XCircle, GitMerge, ChevronLeft, ChevronRight, Filter } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Checkbox } from "@/components/ui/checkbox";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useStagedContacts, type StagedContact } from "@/hooks/use-migration";

const STATUS_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "pending", label: "Pending" },
  { value: "valid", label: "Valid" },
  { value: "needs_review", label: "Needs Review" },
  { value: "invalid", label: "Invalid" },
  { value: "duplicate", label: "Duplicate" },
  { value: "approved", label: "Approved" },
  { value: "rejected", label: "Rejected" },
  { value: "merged", label: "Merged" },
  { value: "promoted", label: "Promoted" },
];

const STATUS_BADGE: Record<string, string> = {
  valid: "bg-green-100 text-green-800",
  approved: "bg-blue-100 text-blue-800",
  promoted: "bg-red-100 text-red-800",
  needs_review: "bg-amber-100 text-amber-800",
  invalid: "bg-red-100 text-red-800",
  duplicate: "bg-orange-100 text-orange-800",
  merged: "bg-gray-100 text-gray-500",
  rejected: "bg-gray-100 text-gray-500",
  pending: "bg-gray-100 text-gray-600",
};

export function MigrationContactsPage() {
  const [statusFilter, setStatusFilter] = useState<string>("duplicate");
  const [mergeContact, setMergeContact] = useState<StagedContact | null>(null);
  const [mergeTargetId, setMergeTargetId] = useState("");

  const {
    rows,
    total,
    page,
    setPage,
    loading,
    selected,
    setSelected,
    approve,
    reject,
    merge,
    batchApprove,
  } = useStagedContacts(statusFilter || undefined);

  const totalPages = Math.ceil(total / 50);

  const toggleSelect = (id: string) => {
    const next = new Set(selected);
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setSelected(next);
  };

  const toggleAll = () => {
    if (selected.size === rows.length) setSelected(new Set());
    else setSelected(new Set(rows.map((r) => r.id)));
  };

  const handleMerge = async () => {
    if (!mergeContact || !mergeTargetId.trim()) return;
    await merge(mergeContact.id, mergeTargetId.trim());
    setMergeContact(null);
    setMergeTargetId("");
  };

  return (
    <div className="space-y-4 max-w-7xl mx-auto">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-semibold text-gray-900">
          Staged Contacts <span className="text-gray-400 text-lg">({total.toLocaleString()})</span>
        </h1>
        <div className="flex items-center gap-2">
          <Filter className="h-4 w-4 text-gray-400" />
          <Select value={statusFilter} onValueChange={(v) => setStatusFilter(v ?? "")}>
            <SelectTrigger className="w-40">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              {STATUS_OPTIONS.map((opt) => (
                <SelectItem key={opt.value} value={opt.value}>
                  {opt.label}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
          {selected.size > 0 && (
            <Button
              size="sm"
              className="bg-green-600 hover:bg-green-700 text-white"
              onClick={batchApprove}
            >
              <CheckCircle2 className="h-4 w-4 mr-1" />
              Approve {selected.size} selected
            </Button>
          )}
        </div>
      </div>

      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="w-8">
              <Checkbox
                checked={selected.size === rows.length && rows.length > 0}
                onCheckedChange={toggleAll}
              />
            </TableHead>
            <TableHead>Name</TableHead>
            <TableHead>Email</TableHead>
            <TableHead>Company</TableHead>
            <TableHead>Category</TableHead>
            <TableHead>Status</TableHead>
            <TableHead>Issues</TableHead>
            <TableHead>Actions</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {loading ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                Loading...
              </TableCell>
            </TableRow>
          ) : rows.length === 0 ? (
            <TableRow>
              <TableCell colSpan={8} className="text-center text-gray-400 py-8">
                No records with this status
              </TableCell>
            </TableRow>
          ) : (
            rows.map((contact) => (
              <TableRow
                key={contact.id}
                className={selected.has(contact.id) ? "bg-blue-50" : ""}
              >
                <TableCell>
                  {!["promoted", "rejected", "merged"].includes(contact.validationStatus) && (
                    <Checkbox
                      checked={selected.has(contact.id)}
                      onCheckedChange={() => toggleSelect(contact.id)}
                    />
                  )}
                </TableCell>
                <TableCell className="font-medium">
                  {[contact.mappedFirstName, contact.mappedLastName]
                    .filter(Boolean)
                    .join(" ") || "--"}
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[180px] truncate">
                  {contact.mappedEmail ?? "--"}
                </TableCell>
                <TableCell className="text-sm text-gray-600 max-w-[150px] truncate">
                  {contact.mappedCompany ?? "--"}
                </TableCell>
                <TableCell>
                  <code className="text-xs bg-gray-100 px-1 rounded">
                    {contact.mappedCategory}
                  </code>
                </TableCell>
                <TableCell>
                  <Badge className={`text-xs ${STATUS_BADGE[contact.validationStatus] ?? ""}`}>
                    {contact.validationStatus.replace(/_/g, " ")}
                  </Badge>
                  {contact.duplicateOfStagedId && (
                    <div className="text-xs text-orange-600 mt-0.5">
                      Dup of {contact.duplicateOfStagedId.slice(0, 8)}...
                    </div>
                  )}
                </TableCell>
                <TableCell>
                  <div className="space-y-0.5">
                    {contact.validationErrors.map((e, i) => (
                      <div key={i} className="text-xs text-red-600">
                        {e.field}: {e.error}
                      </div>
                    ))}
                    {contact.validationWarnings.map((w, i) => (
                      <div key={i} className="text-xs text-amber-600">
                        {w.field}: {w.warning}
                      </div>
                    ))}
                  </div>
                </TableCell>
                <TableCell>
                  {!["promoted", "rejected", "merged"].includes(
                    contact.validationStatus
                  ) && (
                    <div className="flex items-center gap-1">
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-green-700 hover:bg-green-50"
                        onClick={() => approve(contact.id)}
                      >
                        <CheckCircle2 className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-red-700 hover:bg-red-50"
                        onClick={() => reject(contact.id)}
                      >
                        <XCircle className="h-3.5 w-3.5" />
                      </Button>
                      {contact.validationStatus === "duplicate" && (
                        <Button
                          variant="ghost"
                          size="sm"
                          className="h-7 px-2 text-orange-700 hover:bg-orange-50"
                          onClick={() => setMergeContact(contact)}
                        >
                          <GitMerge className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </div>
                  )}
                </TableCell>
              </TableRow>
            ))
          )}
        </TableBody>
      </Table>

      {totalPages > 1 && (
        <div className="flex items-center justify-between text-sm text-gray-500">
          <span>
            Page {page} of {totalPages} ({total.toLocaleString()} total)
          </span>
          <div className="flex items-center gap-1">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page - 1)}
              disabled={page <= 1}
            >
              <ChevronLeft className="h-4 w-4" />
            </Button>
            <Button
              variant="outline"
              size="sm"
              onClick={() => setPage(page + 1)}
              disabled={page >= totalPages}
            >
              <ChevronRight className="h-4 w-4" />
            </Button>
          </div>
        </div>
      )}

      {/* Merge dialog */}
      <Dialog open={mergeContact != null} onOpenChange={() => setMergeContact(null)}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle className="flex items-center gap-2">
              <GitMerge className="h-5 w-5 text-orange-500" />
              Merge Duplicate Contact
            </DialogTitle>
          </DialogHeader>
          <div className="space-y-4 text-sm">
            <p className="text-gray-600">
              Mark this contact as merged into another staged contact. Enter the target
              staged contact ID.
            </p>
            {mergeContact && (
              <div className="rounded-md bg-gray-50 border p-3">
                <div className="font-medium">
                  {[mergeContact.mappedFirstName, mergeContact.mappedLastName]
                    .filter(Boolean)
                    .join(" ")}
                </div>
                <div className="text-gray-500 text-xs">{mergeContact.mappedEmail}</div>
                <div className="text-gray-400 text-xs font-mono mt-1">
                  HubSpot ID: {mergeContact.hubspotContactId}
                  {mergeContact.duplicateOfStagedId && (
                    <span className="ml-2">
                      Suggested target: {mergeContact.duplicateOfStagedId}
                    </span>
                  )}
                </div>
              </div>
            )}
            <div>
              <label className="text-xs font-medium text-gray-700">
                Target staged contact ID
              </label>
              <Input
                className="mt-1 font-mono text-sm"
                placeholder="UUID of the contact to keep"
                value={mergeTargetId}
                onChange={(e) => setMergeTargetId(e.target.value)}
              />
              {mergeContact?.duplicateOfStagedId && (
                <Button
                  variant="link"
                  size="sm"
                  className="px-0 text-xs text-blue-600 mt-1"
                  onClick={() => setMergeTargetId(mergeContact.duplicateOfStagedId!)}
                >
                  Use suggested target ({mergeContact.duplicateOfStagedId.slice(0, 8)}...)
                </Button>
              )}
            </div>
          </div>
          <DialogFooter className="gap-2">
            <Button variant="outline" onClick={() => setMergeContact(null)}>
              Cancel
            </Button>
            <Button
              className="bg-orange-600 hover:bg-orange-700 text-white"
              onClick={handleMerge}
              disabled={!mergeTargetId.trim()}
            >
              <GitMerge className="h-4 w-4 mr-1" />
              Merge Into Target
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
