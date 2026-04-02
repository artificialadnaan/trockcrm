import { useCallback, useMemo, useState } from "react";
import { Plus, FolderOpen, FileText } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { FileUploadZone } from "@/components/files/file-upload-zone";
import { FileSearchBar } from "@/components/files/file-search-bar";
import { FileList } from "@/components/files/file-list";
import { useFiles, downloadFile, deleteFileRecord } from "@/hooks/use-files";
import { useDeals } from "@/hooks/use-deals";
import { useContacts } from "@/hooks/use-contacts";
import { useAuth } from "@/lib/auth";
import { FILE_CATEGORIES, type FileCategory, getCategoryLabel } from "@/lib/file-utils";

type Scope = "all" | "deal" | "contact";

export function FilesPage() {
  const { user } = useAuth();
  const [scope, setScope] = useState<Scope>(user?.role === "rep" ? "deal" : "all");
  const [selectedDealId, setSelectedDealId] = useState("");
  const [selectedContactId, setSelectedContactId] = useState("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [sortBy, setSortBy] = useState<"created_at" | "display_name" | "file_size_bytes" | "taken_at">("created_at");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");
  const [showUpload, setShowUpload] = useState(false);
  const [uploadCategory, setUploadCategory] = useState<FileCategory>("other");

  const { deals } = useDeals({ limit: 100, isActive: true, sortBy: "updated_at", sortDir: "desc" });
  const { contacts } = useContacts({ limit: 100, sortBy: "updated_at", sortDir: "desc" });

  const filesEnabled =
    user?.role !== "rep"
      ? scope === "all" || (scope === "deal" && !!selectedDealId) || (scope === "contact" && !!selectedContactId)
      : (scope === "deal" && !!selectedDealId) || (scope === "contact" && !!selectedContactId);

  const { files, pagination, loading, error, refetch } = useFiles(
    {
      dealId: scope === "deal" ? selectedDealId || undefined : undefined,
      contactId: scope === "contact" ? selectedContactId || undefined : undefined,
      search: search || undefined,
      page,
      limit: 25,
      sortBy,
      sortDir,
    },
    { enabled: filesEnabled }
  );

  const selectedDeal = useMemo(
    () => deals.find((deal) => deal.id === selectedDealId),
    [deals, selectedDealId]
  );

  const handleDownload = useCallback(async (fileId: string) => {
    try {
      await downloadFile(fileId);
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Download failed");
    }
  }, []);

  const handleDelete = useCallback(async (fileId: string) => {
    if (!window.confirm("Delete this file?")) return;
    try {
      await deleteFileRecord(fileId);
      refetch();
    } catch (err: unknown) {
      alert(err instanceof Error ? err.message : "Delete failed");
    }
  }, [refetch]);

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-semibold flex items-center gap-2">
            <FolderOpen className="h-6 w-6 text-slate-700" />
            Files
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Search, upload, and manage CRM documents and photos.
          </p>
        </div>
        <Button size="sm" onClick={() => setShowUpload((current) => !current)}>
          <Plus className="h-4 w-4 mr-1" />
          Upload
        </Button>
      </div>

      {showUpload && (
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm">Upload Files</CardTitle>
          </CardHeader>
          <CardContent className="space-y-3">
            <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Category</label>
                <Select value={uploadCategory} onValueChange={(value) => setUploadCategory(value as FileCategory)}>
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {FILE_CATEGORIES.map((category) => (
                      <SelectItem key={category} value={category}>
                        {getCategoryLabel(category)}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Deal Scope</label>
                <Select
                  value={selectedDealId || "none"}
                  onValueChange={(value) => setSelectedDealId(!value || value === "none" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No deal</SelectItem>
                    {deals.map((deal) => (
                      <SelectItem key={deal.id} value={deal.id}>
                        {deal.dealNumber} - {deal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-medium text-muted-foreground">Contact Scope</label>
                <Select
                  value={selectedContactId || "none"}
                  onValueChange={(value) => setSelectedContactId(!value || value === "none" ? "" : value)}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">No contact</SelectItem>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.firstName} {contact.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>

            <FileUploadZone
              category={uploadCategory}
              dealId={selectedDealId || undefined}
              contactId={selectedContactId || undefined}
              dealNumber={selectedDeal?.dealNumber}
              onUploadComplete={refetch}
            />
          </CardContent>
        </Card>
      )}

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-sm">Browse Files</CardTitle>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="grid grid-cols-1 md:grid-cols-[180px_1fr_220px_160px_160px] gap-3">
            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Scope</label>
              <Select
                value={scope}
                onValueChange={(value) => {
                  setScope(value as Scope);
                  setPage(1);
                }}
              >
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {user?.role !== "rep" && <SelectItem value="all">All Files</SelectItem>}
                  <SelectItem value="deal">Deal Files</SelectItem>
                  <SelectItem value="contact">Contact Files</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Search</label>
              <FileSearchBar
                value={search}
                onChange={(value) => {
                  setSearch(value);
                  setPage(1);
                }}
              />
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">
                {scope === "deal" ? "Deal" : scope === "contact" ? "Contact" : "Context"}
              </label>
              {scope === "deal" ? (
                <Select
                  value={selectedDealId || "none"}
                  onValueChange={(value) => {
                    setSelectedDealId(!value || value === "none" ? "" : value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select a deal</SelectItem>
                    {deals.map((deal) => (
                      <SelectItem key={deal.id} value={deal.id}>
                        {deal.dealNumber} - {deal.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : scope === "contact" ? (
                <Select
                  value={selectedContactId || "none"}
                  onValueChange={(value) => {
                    setSelectedContactId(!value || value === "none" ? "" : value);
                    setPage(1);
                  }}
                >
                  <SelectTrigger>
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="none">Select a contact</SelectItem>
                    {contacts.map((contact) => (
                      <SelectItem key={contact.id} value={contact.id}>
                        {contact.firstName} {contact.lastName}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              ) : (
                <Input value="Office-wide results" disabled />
              )}
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Sort By</label>
              <Select value={sortBy} onValueChange={(value) => setSortBy(value as typeof sortBy)}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="created_at">Created</SelectItem>
                  <SelectItem value="display_name">Name</SelectItem>
                  <SelectItem value="file_size_bytes">Size</SelectItem>
                  <SelectItem value="taken_at">Taken At</SelectItem>
                </SelectContent>
              </Select>
            </div>

            <div className="space-y-2">
              <label className="text-xs font-medium text-muted-foreground">Direction</label>
              <Select value={sortDir} onValueChange={(value) => setSortDir(value as "asc" | "desc")}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="desc">Newest First</SelectItem>
                  <SelectItem value="asc">Oldest First</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>

          {!filesEnabled ? (
            <div className="rounded-lg border border-dashed p-8 text-center text-muted-foreground">
              <FileText className="h-10 w-10 mx-auto mb-3 opacity-40" />
              <p className="font-medium">Choose a scope to load files</p>
              <p className="text-sm mt-1">
                {user?.role === "rep"
                  ? "Reps can browse files by deal or contact."
                  : "Select a deal or contact, or switch to All Files."}
              </p>
            </div>
          ) : (
            <FileList
              files={files}
              pagination={pagination}
              loading={loading}
              error={error}
              onPageChange={setPage}
              onDownload={handleDownload}
              onDelete={handleDelete}
              emptyMessage="No files match the current scope."
            />
          )}
        </CardContent>
      </Card>
    </div>
  );
}
