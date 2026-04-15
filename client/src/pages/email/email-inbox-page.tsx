import { useState } from "react";
import { useSearchParams } from "react-router-dom";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { GraphAuthBanner } from "@/components/email/graph-auth-banner";
import { EmailList } from "@/components/email/email-list";
import { EmailAssignmentQueue } from "@/components/email/email-assignment-queue";
import { EmailComposeDialog } from "@/components/email/email-compose-dialog";
import { useUserEmails } from "@/hooks/use-emails";

export function EmailInboxPage() {
  const [searchParams] = useSearchParams();
  const [search, setSearch] = useState("");
  const [direction, setDirection] = useState<"inbound" | "outbound" | undefined>(
    undefined
  );
  const [page, setPage] = useState(1);
  const [composeOpen, setComposeOpen] = useState(false);

  // Check URL params for success/error from OAuth callback
  const connected = searchParams.get("connected");
  const oauthError = searchParams.get("error");

  const { emails, pagination, loading, error, refetch } = useUserEmails({
    direction,
    search: search.length >= 2 ? search : undefined,
    page,
    limit: 25,
  });

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Email</h2>
        <Button onClick={() => setComposeOpen(true)}>
          <Plus className="h-4 w-4 mr-2" />
          Compose
        </Button>
      </div>

      {/* OAuth callback messages */}
      {connected === "true" && (
        <div className="rounded-lg border border-green-200 bg-green-50 p-3 text-sm text-green-800">
          Microsoft email connected successfully.
        </div>
      )}
      {oauthError && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-3 text-sm text-red-800">
          Failed to connect email: {oauthError}
        </div>
      )}

      <GraphAuthBanner />

      <EmailAssignmentQueue />

      {/* Filters */}
      <div className="flex items-center gap-3">
        <Input
          placeholder="Search emails..."
          value={search}
          onChange={(e) => {
            setSearch(e.target.value);
            setPage(1);
          }}
          className="max-w-xs"
        />
        <Select
          value={direction ?? "all"}
          onValueChange={(val) => {
            setDirection(val === "all" ? undefined : (val as "inbound" | "outbound"));
            setPage(1);
          }}
        >
          <SelectTrigger className="w-[140px]">
            <SelectValue placeholder="All emails" />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">All Emails</SelectItem>
            <SelectItem value="inbound">Inbound</SelectItem>
            <SelectItem value="outbound">Outbound</SelectItem>
          </SelectContent>
        </Select>
      </div>

      <EmailList
        emails={emails}
        pagination={pagination}
        loading={loading}
        error={error}
        onPageChange={setPage}
        emptyMessage="No emails yet. Connect your Microsoft account or compose your first email."
      />

      <EmailComposeDialog
        open={composeOpen}
        onOpenChange={setComposeOpen}
        onSent={refetch}
      />
    </div>
  );
}
