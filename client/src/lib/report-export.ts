function escapeHtml(value: unknown) {
  return String(value ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function formatHeader(column: string) {
  return column
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (char) => char.toUpperCase())
    .trim();
}

function formatCellValue(value: unknown) {
  if (value == null) return "";
  if (Array.isArray(value)) return value.join(", ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}

export function buildReportExportFilename(
  name: string,
  ext: "pdf" | "csv",
  now = new Date(),
) {
  const date = now.toISOString().slice(0, 10);
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return `${slug || "report"}-${date}.${ext}`;
}

export function normalizeReportRows(data: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(data)) {
    return data.filter((row): row is Record<string, unknown> => !!row && typeof row === "object");
  }

  if (data && typeof data === "object") {
    return [data as Record<string, unknown>];
  }

  return [];
}

export function serializeRowsToCsv(rows: Array<Record<string, unknown>>) {
  if (rows.length === 0) return "";

  const columns = Object.keys(rows[0]);
  const escape = (value: unknown) => {
    const rawText = formatCellValue(value);
    const text = /^[=+\-@\t\r]/.test(rawText) ? `'${rawText}` : rawText;
    return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
  };

  return [
    columns.map(escape).join(","),
    ...rows.map((row) => columns.map((column) => escape(row[column])).join(",")),
  ].join("\n");
}

export function buildPrintableReportHtml({
  reportName,
  rows,
  generatedAtLabel,
  metadata = [],
}: {
  reportName: string;
  rows: Array<Record<string, unknown>>;
  generatedAtLabel: string;
  metadata?: Array<{ label: string; value: string }>;
}) {
  const columns = rows.length > 0 ? Object.keys(rows[0]) : [];
  const headerCells = columns
    .map((column) => `<th>${escapeHtml(formatHeader(column))}</th>`)
    .join("");
  const bodyRows = rows
    .map(
      (row) =>
        `<tr>${columns
          .map((column) => `<td>${escapeHtml(formatCellValue(row[column]))}</td>`)
          .join("")}</tr>`,
    )
    .join("");
  const metadataRows = metadata
    .filter((item) => item.value.trim().length > 0)
    .map(
      (item) =>
        `<li><strong>${escapeHtml(item.label)}:</strong> ${escapeHtml(item.value)}</li>`,
    )
    .join("");

  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>${escapeHtml(reportName)}</title>
    <style>
      body { font-family: Arial, sans-serif; margin: 32px; color: #111827; }
      h1 { font-size: 24px; margin: 0 0 8px; }
      p { color: #6b7280; margin: 0 0 24px; }
      ul { margin: 0 0 24px; padding-left: 18px; color: #374151; }
      li { margin: 0 0 6px; font-size: 12px; }
      table { border-collapse: collapse; width: 100%; }
      th, td { border: 1px solid #d1d5db; text-align: left; padding: 8px; font-size: 12px; }
      th { background: #f3f4f6; }
    </style>
  </head>
  <body>
    <h1>${escapeHtml(reportName)}</h1>
    <p>Generated ${escapeHtml(generatedAtLabel)}</p>
    ${metadataRows ? `<ul>${metadataRows}</ul>` : ""}
    <table>
      <thead><tr>${headerCells}</tr></thead>
      <tbody>${bodyRows}</tbody>
    </table>
  </body>
</html>`;
}

export function downloadTextFile(content: string, filename: string, mimeType: string) {
  const blob = new Blob([content], { type: mimeType });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);
  URL.revokeObjectURL(url);
}

export function openPrintableReportWindow(html: string) {
  const printWindow = window.open("", "_blank");
  if (!printWindow) {
    throw new Error("Unable to open export window. Check your browser pop-up settings.");
  }

  printWindow.document.open();
  printWindow.document.write(html);
  printWindow.document.close();
  printWindow.focus();
  printWindow.print();
}
