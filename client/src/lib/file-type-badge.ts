import {
  FileIcon,
  ImageIcon,
  FileText,
  FileSpreadsheet,
  FileArchive,
  Mail,
  type LucideIcon,
} from "lucide-react";

export interface FileTypeBadge {
  /** Short uppercase label rendered in the row (e.g. "PDF"). */
  label: string;
  /** Tailwind classes for the badge chip (background + text + border). */
  className: string;
  Icon: LucideIcon;
}

/**
 * Distinct colored type badge for a file, so non-image/non-PDF documents are visually separable in the
 * Files tab. Mime is authoritative; extension is a fallback for octet-stream/misdeclared uploads.
 */
export function getFileTypeBadge(mimeType: string, fileExtension?: string | null): FileTypeBadge {
  const mime = (mimeType || "").split(";")[0].trim().toLowerCase();
  const ext = (fileExtension || "").replace(/^\./, "").toLowerCase();

  if (mime.startsWith("image/")) {
    return { label: "IMG", className: "bg-sky-100 text-sky-700 border-sky-200", Icon: ImageIcon };
  }
  if (mime === "application/pdf" || ext === "pdf") {
    return { label: "PDF", className: "bg-red-100 text-red-700 border-red-200", Icon: FileText };
  }
  if (mime.includes("sheet") || mime.includes("excel") || mime === "text/csv" || ext === "xls" || ext === "xlsx" || ext === "csv") {
    return { label: "XLS", className: "bg-emerald-100 text-emerald-700 border-emerald-200", Icon: FileSpreadsheet };
  }
  if (mime.includes("word") || ext === "doc" || ext === "docx") {
    return { label: "DOC", className: "bg-blue-100 text-blue-700 border-blue-200", Icon: FileText };
  }
  if (mime === "application/zip" || mime.includes("compressed") || ext === "zip") {
    return { label: "ZIP", className: "bg-amber-100 text-amber-700 border-amber-200", Icon: FileArchive };
  }
  if (mime === "message/rfc822" || mime === "application/vnd.ms-outlook" || ext === "eml" || ext === "msg") {
    return { label: "EML", className: "bg-violet-100 text-violet-700 border-violet-200", Icon: Mail };
  }
  if (mime === "text/plain" || ext === "txt") {
    return { label: "TXT", className: "bg-slate-100 text-slate-700 border-slate-200", Icon: FileText };
  }
  return { label: "FILE", className: "bg-muted text-muted-foreground border-border", Icon: FileIcon };
}
