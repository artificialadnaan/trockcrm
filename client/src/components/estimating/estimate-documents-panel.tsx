import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { api } from "@/lib/api";

function formatDocumentType(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

function formatDocumentStatus(value: string | null | undefined) {
  if (!value) return "Unknown";
  if (value === "queued") return "Queued for OCR";
  if (value === "completed") return "Ready";
  return value.replace(/_/g, " ");
}

function formatTimestamp(value: string | Date | null | undefined) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No timestamp" : date.toLocaleString();
}

export function EstimateDocumentsPanel({
  dealId,
  documents,
  onRefresh,
}: {
  dealId: string;
  documents: any[];
  onRefresh: () => Promise<void>;
}) {
  const [reprocessingDocumentId, setReprocessingDocumentId] = useState<string | null>(null);

  const handleReprocess = async (documentId: string) => {
    setReprocessingDocumentId(documentId);
    try {
      await api(`/deals/${dealId}/estimating/documents/${documentId}/reprocess`, {
        method: "POST",
      });
      toast.success("Document requeued for OCR");
      await onRefresh();
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to reprocess document");
    } finally {
      setReprocessingDocumentId(null);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <h3 className="text-sm font-semibold">Documents</h3>
        <p className="text-xs text-muted-foreground">
          Source files feeding OCR, extraction, and estimator review.
        </p>
      </div>

      {documents.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No source documents have been uploaded yet.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Uploaded</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const isReprocessing = reprocessingDocumentId === document.id;

                return (
                  <tr key={document.id} className="border-b align-top last:border-b-0">
                    <td className="px-4 py-3">
                      <div className="font-medium text-foreground">{document.filename}</div>
                      <div className="text-xs text-muted-foreground">
                        {document.versionLabel || "Current version"}
                      </div>
                    </td>
                    <td className="px-4 py-3 capitalize text-muted-foreground">
                      {formatDocumentType(document.documentType)}
                    </td>
                    <td className="px-4 py-3">
                      <div className="font-medium">{formatDocumentStatus(document.ocrStatus)}</div>
                      <div className="text-xs text-muted-foreground">
                        {document.fileSize ? `${Number(document.fileSize).toLocaleString()} bytes` : "Size unavailable"}
                      </div>
                    </td>
                    <td className="px-4 py-3 text-muted-foreground">
                      {formatTimestamp(document.createdAt)}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={isReprocessing}
                        onClick={() => handleReprocess(document.id)}
                      >
                        {isReprocessing ? "Reprocessing..." : "Reprocess"}
                      </Button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
