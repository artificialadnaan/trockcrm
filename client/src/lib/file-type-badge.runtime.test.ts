import { describe, it, expect } from "vitest";
import { ImageIcon, FileText, FileSpreadsheet, FileArchive, Mail, FileIcon } from "lucide-react";
import { getFileTypeBadge } from "./file-type-badge";

/**
 * The Files tab renders a colored type badge so a user can spot the Excel among photos. Mapping is by
 * mime first, extension as a fallback — distinct label + color per family.
 */
describe("getFileTypeBadge", () => {
  it("maps images to IMG", () => {
    const b = getFileTypeBadge("image/jpeg", ".jpg");
    expect(b.label).toBe("IMG");
    expect(b.Icon).toBe(ImageIcon);
  });

  it("maps PDF (mime or extension) to a red PDF badge", () => {
    expect(getFileTypeBadge("application/pdf", ".pdf").label).toBe("PDF");
    expect(getFileTypeBadge("application/octet-stream", ".pdf").label).toBe("PDF");
    expect(getFileTypeBadge("application/pdf", ".pdf").className).toContain("red");
    expect(getFileTypeBadge("application/pdf", ".pdf").Icon).toBe(FileText);
  });

  it("maps Excel/CSV to XLS and Word to DOC with distinct colors", () => {
    expect(getFileTypeBadge("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx").label).toBe("XLS");
    expect(getFileTypeBadge("text/csv", ".csv").label).toBe("XLS");
    expect(getFileTypeBadge("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet", ".xlsx").Icon).toBe(FileSpreadsheet);
    expect(getFileTypeBadge("application/msword", ".doc").label).toBe("DOC");
    expect(getFileTypeBadge("application/vnd.openxmlformats-officedocument.wordprocessingml.document", ".docx").label).toBe("DOC");
    // XLS and DOC must not share a color.
    const xls = getFileTypeBadge("text/csv", ".csv").className;
    const doc = getFileTypeBadge("application/msword", ".doc").className;
    expect(xls).not.toBe(doc);
  });

  it("maps ZIP, EML and TXT", () => {
    expect(getFileTypeBadge("application/zip", ".zip").label).toBe("ZIP");
    expect(getFileTypeBadge("application/zip", ".zip").Icon).toBe(FileArchive);
    expect(getFileTypeBadge("message/rfc822", ".eml").label).toBe("EML");
    expect(getFileTypeBadge("application/vnd.ms-outlook", ".msg").label).toBe("EML");
    expect(getFileTypeBadge("message/rfc822", ".eml").Icon).toBe(Mail);
    expect(getFileTypeBadge("text/plain", ".txt").label).toBe("TXT");
  });

  it("falls back to a generic FILE badge for unknown types", () => {
    const b = getFileTypeBadge("application/x-weird", ".zzz");
    expect(b.label).toBe("FILE");
    expect(b.Icon).toBe(FileIcon);
  });
});
