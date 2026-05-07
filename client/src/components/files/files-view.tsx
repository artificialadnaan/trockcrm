import { useState } from "react";
import { ArrowDownToLine, Camera, ChevronRight, Download, FileText, Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export type PhotoItem = {
  id: string;
  label: string;
  takenBy: string;
  takenAt: string;
};

export type DocumentKind = "Contract" | "Proposal" | "Estimate" | "RFP" | "Drawing" | "Spec" | "Other";

export type DocumentItem = {
  id: string;
  name: string;
  kind: DocumentKind;
  sizeKB: number;
  uploadedBy: string;
  uploadedAt: string;
};

type FilesSubtab = "All" | "Photos" | "Documents";

const kindStyles: Record<DocumentKind, string> = {
  Contract: "bg-emerald-50 text-emerald-700 ring-emerald-200",
  Proposal: "bg-brand-red/10 text-brand-red ring-brand-red/20",
  Estimate: "bg-amber-50 text-amber-700 ring-amber-200",
  RFP: "bg-blue-50 text-blue-700 ring-blue-200",
  Drawing: "bg-violet-50 text-violet-700 ring-violet-200",
  Spec: "bg-slate-100 text-slate-700 ring-slate-200",
  Other: "bg-slate-100 text-slate-700 ring-slate-200",
};

function formatSize(kb: number): string {
  if (kb >= 1024) return `${(kb / 1024).toFixed(1)} MB`;
  return `${kb} KB`;
}

export function FilesView({
  photos,
  documents,
  className,
}: {
  photos: PhotoItem[];
  documents: DocumentItem[];
  className?: string;
}) {
  const [subtab, setSubtab] = useState<FilesSubtab>("All");
  const showPhotos = subtab === "All" || subtab === "Photos";
  const showDocuments = subtab === "All" || subtab === "Documents";
  const total = photos.length + documents.length;

  return (
    <div className={cn("p-5", className)}>
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-1 rounded-md border border-slate-200 bg-white p-0.5">
          {(["All", "Photos", "Documents"] as FilesSubtab[]).map((item) => {
            const count = item === "All" ? total : item === "Photos" ? photos.length : documents.length;
            const Icon = item === "All" ? Layers : item === "Photos" ? Camera : FileText;
            const isActive = subtab === item;
            return (
              <button
                key={item}
                type="button"
                onClick={() => setSubtab(item)}
                className={cn(
                  "flex items-center gap-1.5 rounded-sm px-3 py-1.5 text-xs font-bold transition-colors",
                  isActive ? "bg-slate-100 text-slate-950" : "text-slate-500 hover:text-slate-900",
                )}
              >
                <Icon className="h-3.5 w-3.5" />
                {item}
                <span
                  className={cn(
                    "ml-0.5 rounded-full px-1.5 py-0.5 text-[10px] font-black tabular-nums",
                    isActive ? "bg-brand-red/10 text-brand-red" : "bg-slate-100 text-slate-600",
                  )}
                >
                  {count}
                </span>
              </button>
            );
          })}
        </div>
        <div className="flex items-center gap-2">
          <Button variant="outline" size="sm">
            <Download className="mr-1 h-4 w-4" />
            Download all
          </Button>
          <Button size="sm">
            <Plus className="mr-1 h-4 w-4" />
            Upload
          </Button>
        </div>
      </div>

      {showPhotos && photos.length > 0 ? (
        <section className="mt-5">
          {subtab === "All" ? (
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
              Photos · {photos.length}
            </p>
          ) : null}
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
            {photos.map((photo) => (
              <div key={photo.id} className="group overflow-hidden rounded-md border border-slate-200">
                <div className="aspect-[4/3] bg-gradient-to-br from-slate-200 to-slate-300">
                  <div className="flex h-full w-full items-center justify-center">
                    <Camera className="h-8 w-8 text-white/70" />
                  </div>
                </div>
                <div className="border-t border-slate-100 bg-white px-3 py-2">
                  <p className="truncate text-xs font-bold text-slate-950">{photo.label}</p>
                  <p className="mt-0.5 text-[10px] text-slate-500">
                    {photo.takenBy} · {photo.takenAt}
                  </p>
                </div>
              </div>
            ))}
          </div>
        </section>
      ) : null}

      {subtab === "Photos" && photos.length === 0 && total > 0 ? (
        <div className="mt-12 text-center">
          <Camera className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">No photos uploaded yet. Upload images to see them here.</p>
        </div>
      ) : null}

      {showDocuments && documents.length > 0 ? (
        <section className="mt-5">
          {subtab === "All" ? (
            <p className="mb-3 text-[11px] font-bold uppercase tracking-[0.2em] text-slate-500">
              Documents · {documents.length}
            </p>
          ) : null}
          <div className="overflow-hidden rounded-md border border-slate-200">
            <table className="w-full">
              <thead>
                <tr className="border-b border-slate-100 bg-slate-50/40 text-[10px] font-bold uppercase tracking-[0.16em] text-slate-500">
                  <th className="px-4 py-2.5 text-left">File</th>
                  <th className="px-4 py-2.5 text-left">Type</th>
                  <th className="px-4 py-2.5 text-right">Size</th>
                  <th className="px-4 py-2.5 text-left">Uploaded</th>
                  <th className="w-10 px-4 py-2.5" aria-hidden />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {documents.map((document) => (
                  <tr key={document.id} className="cursor-pointer transition-colors hover:bg-slate-50">
                    <td className="px-4 py-3">
                      <div className="flex items-center gap-2.5">
                        <span className="flex h-7 w-7 items-center justify-center rounded-md bg-slate-100">
                          <FileText className="h-3.5 w-3.5 text-slate-600" />
                        </span>
                        <p className="truncate text-sm font-bold text-slate-950">{document.name}</p>
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <span
                        className={cn(
                          "inline-flex items-center rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ring-1",
                          kindStyles[document.kind],
                        )}
                      >
                        {document.kind}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-right text-xs font-semibold tabular-nums text-slate-700">
                      {formatSize(document.sizeKB)}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-500">
                      <span className="font-semibold text-slate-700">{document.uploadedBy}</span> · {document.uploadedAt}
                    </td>
                    <td className="px-4 py-3 text-right">
                      <button
                        type="button"
                        className="inline-flex h-7 w-7 items-center justify-center rounded-md text-slate-400 hover:bg-slate-100 hover:text-slate-900"
                        aria-label={`Download ${document.name}`}
                      >
                        <ArrowDownToLine className="h-3.5 w-3.5" />
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </section>
      ) : null}

      {subtab === "Documents" && documents.length === 0 && total > 0 ? (
        <div className="mt-12 text-center">
          <FileText className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">
            No documents uploaded yet. Upload PDFs, Word docs, or spreadsheets to see them here.
          </p>
        </div>
      ) : null}

      {total === 0 ? (
        <div className="mt-12 text-center">
          <ChevronRight className="mx-auto h-6 w-6 text-slate-400" />
          <p className="mt-2 text-sm text-slate-500">No files yet.</p>
          <Button variant="outline" size="sm" className="mt-3">
            <Plus className="mr-1 h-4 w-4" />
            Upload first file
          </Button>
        </div>
      ) : null}
    </div>
  );
}
