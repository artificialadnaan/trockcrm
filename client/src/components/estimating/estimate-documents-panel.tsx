import { useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { api } from "@/lib/api";
import { uploadFile } from "@/hooks/use-files";

const PARSE_PROFILE_OPTIONS = [
  { value: "balanced", label: "Balanced" },
  { value: "text-heavy", label: "Text-heavy" },
  { value: "measurement-heavy", label: "Measurement-heavy" },
];

type DocumentParseDraft = {
  parseProvider: string;
  parseProfile: string;
  parseMeasurementsEnabled: boolean;
};

function normalizeDocumentParseValue(value: string | null | undefined, fallback: string) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : fallback;
}

function buildDocumentParseDraft(document: {
  parseProvider?: string | null;
  parseProfile?: string | null;
  parseMeasurementsEnabled?: boolean | null;
}): DocumentParseDraft {
  return {
    parseProvider: normalizeDocumentParseValue(document.parseProvider, "default"),
    parseProfile: normalizeDocumentParseValue(document.parseProfile, "balanced"),
    parseMeasurementsEnabled: document.parseMeasurementsEnabled ?? false,
  };
}

function formatDocumentType(value: string | null | undefined) {
  if (!value) return "Unknown";
  return value.replace(/_/g, " ");
}

function formatParseStatus(value: string | null | undefined) {
  if (!value) return "Not parsed yet";
  if (value === "queued") return "Queued for parsing";
  if (value === "processing") return "Parsing";
  if (value === "completed") return "Parsed";
  if (value === "failed") return "Parsing failed";
  return value.replace(/_/g, " ");
}

function formatOcrStatus(value: string | null | undefined) {
  if (!value) return "Unknown";
  if (value === "queued") return "Queued";
  if (value === "completed") return "Complete";
  if (value === "processing") return "Processing";
  if (value === "failed") return "Failed";
  return value.replace(/_/g, " ");
}

function formatTimestamp(value: string | Date | null | undefined) {
  if (!value) return "No timestamp";
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "No timestamp" : date.toLocaleString();
}

export async function runEstimateDocumentRerunAction({
  dealId,
  documentId,
  options,
  refresh,
}: {
  dealId: string;
  documentId: string;
  options: DocumentParseDraft;
  refresh: () => Promise<void>;
}) {
  const normalizedOptions = {
    parseProvider: normalizeDocumentParseValue(options.parseProvider, "default"),
    parseProfile: normalizeDocumentParseValue(options.parseProfile, "balanced"),
    parseMeasurementsEnabled: options.parseMeasurementsEnabled,
  };

  await api(`/deals/${dealId}/estimating/documents/${documentId}/reprocess`, {
    method: "POST",
    json: {
      parseProvider: normalizedOptions.parseProvider,
      parseProfile: normalizedOptions.parseProfile,
      parseMeasurementsEnabled: normalizedOptions.parseMeasurementsEnabled,
    },
  });
  await refresh();
}

export async function runEstimateDocumentUploadAction({
  dealId,
  files,
  parseMeasurementsEnabled,
  refresh,
}: {
  dealId: string;
  files: File[];
  parseMeasurementsEnabled: boolean;
  refresh: () => Promise<void>;
}) {
  for (const file of files) {
    const uploaded = await uploadFile({
      file,
      category: "estimate",
      dealId,
    });

    await api(`/deals/${dealId}/estimating/documents`, {
      method: "POST",
      json: {
        fileId: uploaded.id,
        parseMeasurementsEnabled,
      },
    });
  }

  await refresh();
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
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploadMeasurementsEnabled, setUploadMeasurementsEnabled] = useState(true);
  const [reprocessingDocumentId, setReprocessingDocumentId] = useState<string | null>(null);
  const [drafts, setDrafts] = useState<Record<string, DocumentParseDraft>>({});

  const handleUploadFiles = async (fileList: FileList | null) => {
    if (!fileList?.length) return;

    setUploading(true);
    try {
      await runEstimateDocumentUploadAction({
        dealId,
        files: Array.from(fileList),
        parseMeasurementsEnabled: uploadMeasurementsEnabled,
        refresh: onRefresh,
      });
      toast.success(
        fileList.length === 1
          ? "Plan uploaded and queued for parsing"
          : `${fileList.length} documents uploaded and queued for parsing`
      );
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to upload estimate documents");
    } finally {
      setUploading(false);
      if (fileInputRef.current) {
        fileInputRef.current.value = "";
      }
    }
  };

  const handleReprocess = async (documentId: string, options: DocumentParseDraft) => {
    setReprocessingDocumentId(documentId);
    try {
      await runEstimateDocumentRerunAction({
        dealId,
        documentId,
        options,
        refresh: onRefresh,
      });
      toast.success("Document requeued for parsing");
    } catch (err: unknown) {
      toast.error(err instanceof Error ? err.message : "Failed to reprocess document");
    } finally {
      setReprocessingDocumentId(null);
    }
  };

  return (
    <section className="flex h-full flex-col">
      <div className="border-b px-4 py-3">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-end lg:justify-between">
          <div>
            <h3 className="text-sm font-semibold">Documents</h3>
            <p className="text-xs text-muted-foreground">
              Source files feeding parsing, extraction, and estimator review.
            </p>
          </div>

          <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
            <label className="flex items-center gap-2 text-xs text-muted-foreground">
              <Checkbox
                checked={uploadMeasurementsEnabled}
                onCheckedChange={(checked) => setUploadMeasurementsEnabled(checked === true)}
              />
              <span>Enable measurement detection on upload</span>
            </label>

            <input
              ref={fileInputRef}
              type="file"
              accept=".pdf,image/*,.tif,.tiff"
              multiple
              className="hidden"
              onChange={(event) => {
                void handleUploadFiles(event.target.files);
              }}
            />
            <Button
              size="sm"
              onClick={() => fileInputRef.current?.click()}
              disabled={uploading}
            >
              {uploading ? "Uploading..." : "Upload Plans Here"}
            </Button>
          </div>
        </div>
      </div>

      {documents.length === 0 ? (
        <div className="px-4 py-6 text-sm text-muted-foreground">
          No source documents have been uploaded yet. Use <span className="font-medium text-foreground">Upload Plans Here</span> to add plans, specs, or blueprint images for estimate review.
        </div>
      ) : (
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead className="border-b bg-muted/30 text-left text-xs uppercase tracking-wide text-muted-foreground">
              <tr>
                <th className="px-4 py-2 font-medium">Document</th>
                <th className="px-4 py-2 font-medium">Type</th>
                <th className="px-4 py-2 font-medium">Status</th>
                <th className="px-4 py-2 font-medium">Rerun Options</th>
                <th className="px-4 py-2 font-medium">Uploaded</th>
                <th className="px-4 py-2 text-right font-medium">Action</th>
              </tr>
            </thead>
            <tbody>
              {documents.map((document) => {
                const isReprocessing = reprocessingDocumentId === document.id;
                const draft =
                  drafts[document.id] ?? buildDocumentParseDraft(document);

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
                      <div className="font-medium">
                        {formatParseStatus(document.parseStatus ?? document.ocrStatus)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        OCR {formatOcrStatus(document.ocrStatus)}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        Provider {document.parseProvider ?? "default"} · Profile{" "}
                        {document.parseProfile ?? "balanced"}
                      </div>
                      <div className="text-xs text-muted-foreground">
                        {document.parseMeasurementsEnabled ? "Measurements enabled" : "Measurements disabled"}
                      </div>
                      {document.parseErrorSummary ? (
                        <div className="text-xs text-destructive">{document.parseErrorSummary}</div>
                      ) : null}
                    </td>
                    <td className="px-4 py-3">
                      <div className="space-y-2">
                        <div className="space-y-1">
                          <Label
                            className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                            htmlFor={`parse-provider-${document.id}`}
                          >
                            Provider
                          </Label>
                          <Input
                            id={`parse-provider-${document.id}`}
                            className="h-7"
                            value={draft.parseProvider}
                            onChange={(event) =>
                              setDrafts((current) => {
                                const currentDraft =
                                  current[document.id] ?? buildDocumentParseDraft(document);
                                return {
                                  ...current,
                                  [document.id]: {
                                    ...currentDraft,
                                    parseProvider: event.target.value,
                                  },
                                };
                              })
                            }
                          />
                        </div>

                        <div className="space-y-1">
                          <Label
                            className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground"
                            htmlFor={`parse-profile-${document.id}`}
                          >
                            Profile
                          </Label>
                          <Select
                            value={draft.parseProfile}
                            onValueChange={(value) =>
                              setDrafts((current) => {
                                const currentDraft =
                                  current[document.id] ?? buildDocumentParseDraft(document);
                                return {
                                  ...current,
                                  [document.id]: {
                                    ...currentDraft,
                                    parseProfile: value,
                                  },
                                };
                              })
                            }
                          >
                            <SelectTrigger id={`parse-profile-${document.id}`} className="h-7 w-full">
                              <SelectValue placeholder="Select profile" />
                            </SelectTrigger>
                            <SelectContent>
                              {PARSE_PROFILE_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectContent>
                          </Select>
                        </div>

                        <label className="flex items-center gap-2 text-xs text-muted-foreground">
                            <Checkbox
                              checked={draft.parseMeasurementsEnabled}
                              onCheckedChange={(checked) =>
                              setDrafts((current) => {
                                const currentDraft =
                                  current[document.id] ?? buildDocumentParseDraft(document);
                                return {
                                  ...current,
                                  [document.id]: {
                                    ...currentDraft,
                                    parseMeasurementsEnabled: checked,
                                  },
                                };
                              })
                            }
                            className="mt-0.5"
                          />
                          <span>Enable measurements</span>
                        </label>
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
                        onClick={() => handleReprocess(document.id, draft)}
                      >
                        {isReprocessing ? "Re-running..." : "Re-run Parsing"}
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
