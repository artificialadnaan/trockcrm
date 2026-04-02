import { useState } from "react";
import DOMPurify from "dompurify";
import { Mail } from "lucide-react";
import { EmailRow } from "./email-row";
import { EmailThreadView } from "./email-thread-view";
import type { Email, Pagination } from "@/hooks/use-emails";
import { Button } from "@/components/ui/button";

interface EmailListProps {
  emails: Email[];
  pagination: Pagination;
  loading: boolean;
  error: string | null;
  onPageChange: (page: number) => void;
  emptyMessage?: string;
}

export function EmailList({
  emails,
  pagination,
  loading,
  error,
  onPageChange,
  emptyMessage = "No emails yet",
}: EmailListProps) {
  const [selectedEmail, setSelectedEmail] = useState<Email | null>(null);

  if (loading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="h-16 bg-muted animate-pulse rounded" />
        ))}
      </div>
    );
  }

  if (error) {
    return <p className="text-red-600 text-sm py-4">{error}</p>;
  }

  if (selectedEmail?.graphConversationId) {
    return (
      <EmailThreadView
        conversationId={selectedEmail.graphConversationId}
        onBack={() => setSelectedEmail(null)}
      />
    );
  }

  if (selectedEmail) {
    // Single email view (no conversation ID)
    return (
      <div className="space-y-4">
        <Button variant="ghost" size="sm" onClick={() => setSelectedEmail(null)}>
          Back to list
        </Button>
        <div className="border rounded-lg p-4">
          <div className="flex justify-between items-start mb-3">
            <div>
              <h3 className="font-medium">{selectedEmail.subject ?? "(No Subject)"}</h3>
              <p className="text-sm text-muted-foreground">
                {selectedEmail.direction === "inbound" ? "From" : "To"}:{" "}
                {selectedEmail.direction === "inbound"
                  ? selectedEmail.fromAddress
                  : selectedEmail.toAddresses.join(", ")}
              </p>
            </div>
            <span className="text-xs text-muted-foreground">
              {new Date(selectedEmail.sentAt).toLocaleString()}
            </span>
          </div>
          <div
            className="prose prose-sm max-w-none"
            dangerouslySetInnerHTML={{
              __html: DOMPurify.sanitize(selectedEmail.bodyHtml ?? selectedEmail.bodyPreview ?? ""),
            }}
          />
        </div>
      </div>
    );
  }

  if (emails.length === 0) {
    return (
      <div className="text-center py-12 text-muted-foreground">
        <Mail className="h-12 w-12 mx-auto mb-3 opacity-50" />
        <p>{emptyMessage}</p>
      </div>
    );
  }

  return (
    <div>
      <div className="border rounded-lg overflow-hidden">
        {emails.map((email) => (
          <EmailRow
            key={email.id}
            email={email}
            onClick={setSelectedEmail}
          />
        ))}
      </div>

      {/* Pagination */}
      {pagination.totalPages > 1 && (
        <div className="flex items-center justify-between mt-4">
          <span className="text-sm text-muted-foreground">
            Page {pagination.page} of {pagination.totalPages} ({pagination.total} emails)
          </span>
          <div className="flex gap-2">
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page <= 1}
              onClick={() => onPageChange(pagination.page - 1)}
            >
              Previous
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={pagination.page >= pagination.totalPages}
              onClick={() => onPageChange(pagination.page + 1)}
            >
              Next
            </Button>
          </div>
        </div>
      )}
    </div>
  );
}
