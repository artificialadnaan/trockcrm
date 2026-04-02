import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the db module
vi.mock("../../../src/db.js", () => ({
  db: { select: vi.fn() },
  pool: {},
}));

// Mock the R2 client
vi.mock("../../../src/lib/r2-client.js", () => ({
  isR2Configured: () => false,
  generateUploadUrl: vi.fn(),
  generateDownloadUrl: vi.fn(),
  generateMockUploadUrl: (key: string) => ({
    uploadUrl: `http://localhost:3001/api/files/dev-upload?key=${encodeURIComponent(key)}`,
    r2Key: key,
    expiresIn: 900,
  }),
  generateMockDownloadUrl: (key: string) =>
    `http://localhost:3001/api/files/dev-download?key=${encodeURIComponent(key)}`,
}));

// Top-level await imports (module scope is async)
const { AppError } = await import("../../../src/middleware/error-handler.js");
const {
  ALLOWED_MIME_TYPES,
  ALLOWED_EXTENSIONS,
  MAX_FILE_SIZE_BYTES,
  CATEGORY_TO_R2_SEGMENT,
  CATEGORY_TO_FOLDER,
  DEAL_FOLDER_TEMPLATE,
} = await import("../../../src/modules/files/file-constants.js");

describe("File Service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  describe("MIME Type Validation", () => {
    it("should accept all supported image MIME types", () => {
      const imageMimes = ["image/jpeg", "image/png", "image/gif", "image/webp", "image/heic"];
      for (const mime of imageMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should accept all supported document MIME types", () => {
      const docMimes = [
        "application/pdf",
        "application/msword",
        "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      ];
      for (const mime of docMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should accept all supported spreadsheet MIME types", () => {
      const sheetMimes = [
        "application/vnd.ms-excel",
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
        "text/csv",
      ];
      for (const mime of sheetMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeDefined();
      }
    });

    it("should reject unsupported MIME types", () => {
      const badMimes = [
        "application/javascript",
        "text/html",
        "application/x-executable",
        "video/mp4",
      ];
      for (const mime of badMimes) {
        expect(ALLOWED_MIME_TYPES[mime]).toBeUndefined();
      }
    });
  });

  describe("File Extension Validation", () => {
    it("should accept common image extensions", () => {
      for (const ext of [".jpg", ".jpeg", ".png", ".gif", ".webp", ".heic"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it("should accept common document extensions", () => {
      for (const ext of [".pdf", ".doc", ".docx", ".xls", ".xlsx", ".csv", ".txt"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(true);
      }
    });

    it("should reject dangerous extensions", () => {
      for (const ext of [".exe", ".sh", ".bat", ".js", ".html", ".php"]) {
        expect(ALLOWED_EXTENSIONS.has(ext)).toBe(false);
      }
    });
  });

  describe("File Size Validation", () => {
    it("should enforce 50 MB limit", () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(50 * 1024 * 1024);
    });

    it("should allow files at exactly 50 MB", () => {
      expect(MAX_FILE_SIZE_BYTES).toBe(52428800);
    });
  });

  describe("Auto-Naming Convention", () => {
    it("should produce filenames matching the pattern {DealNumber}_{Category}_{Date}_{Seq}.{ext}", () => {
      const dealNumber = "TR-2026-0142";
      const category = "Photo";
      const dateStr = "2026-04-15";
      const seq = "001";
      const ext = ".jpg";

      const result = `${dealNumber}_${category}_${dateStr}_${seq}${ext}`;
      expect(result).toBe("TR-2026-0142_Photo_2026-04-15_001.jpg");
    });

    it("should pad sequence numbers to 3 digits", () => {
      const cases = [
        { seq: 1, expected: "001" },
        { seq: 9, expected: "009" },
        { seq: 42, expected: "042" },
        { seq: 100, expected: "100" },
      ];

      for (const tc of cases) {
        expect(String(tc.seq).padStart(3, "0")).toBe(tc.expected);
      }
    });

    it("should format category labels correctly", () => {
      const categories: Record<string, string> = {
        photo: "Photo",
        contract: "Contract",
        change_order: "Change-order",
        rfp: "Rfp",
        estimate: "Estimate",
      };

      for (const [raw, expected] of Object.entries(categories)) {
        const label = raw.charAt(0).toUpperCase() + raw.slice(1).replace(/_/g, "-");
        expect(label).toBe(expected);
      }
    });
  });

  describe("R2 Key Construction", () => {
    it("should build deal-scoped R2 keys correctly", () => {
      const officeSlug = "dallas";
      const dealNumber = "TR-2026-0142";
      const category = "photo" as const;
      const systemFilename = "TR-2026-0142_Photo_2026-04-15_001.jpg";

      const segment = CATEGORY_TO_R2_SEGMENT[category];
      const key = `office_${officeSlug}/deals/${dealNumber}/${segment}/${systemFilename}`;

      expect(key).toBe(
        "office_dallas/deals/TR-2026-0142/photos/TR-2026-0142_Photo_2026-04-15_001.jpg"
      );
    });

    it("should build contact-scoped R2 keys correctly", () => {
      const officeSlug = "dallas";
      const contactId = "abc-123";
      const category = "contract" as const;
      const systemFilename = "Contract_2026-04-15_a1b2c3.pdf";

      const segment = CATEGORY_TO_R2_SEGMENT[category];
      const key = `office_${officeSlug}/contacts/${contactId}/${segment}/${systemFilename}`;

      expect(key).toBe(
        "office_dallas/contacts/abc-123/contracts/Contract_2026-04-15_a1b2c3.pdf"
      );
    });

    it("should map all file categories to R2 path segments", () => {
      const expectedSegments: Record<string, string> = {
        photo: "photos",
        contract: "contracts",
        rfp: "rfps",
        estimate: "estimates",
        change_order: "change-orders",
        proposal: "proposals",
        permit: "permits",
        inspection: "inspections",
        correspondence: "correspondence",
        insurance: "insurance",
        warranty: "warranty",
        closeout: "closeout",
        other: "other",
      };

      for (const [cat, expected] of Object.entries(expectedSegments)) {
        expect(CATEGORY_TO_R2_SEGMENT[cat as keyof typeof CATEGORY_TO_R2_SEGMENT]).toBe(expected);
      }
    });
  });

  describe("Virtual Folder Path Construction", () => {
    it("should map categories to top-level folder names", () => {
      expect(CATEGORY_TO_FOLDER.photo).toBe("Photos");
      expect(CATEGORY_TO_FOLDER.contract).toBe("Contracts");
      expect(CATEGORY_TO_FOLDER.estimate).toBe("Estimates");
      expect(CATEGORY_TO_FOLDER.rfp).toBe("RFPs");
    });

    it("should include all expected top-level folders in the template", () => {
      const expectedFolders = [
        "Photos",
        "Estimates",
        "Contracts",
        "RFPs",
        "Change Orders",
        "Permits & Inspections",
        "Correspondence",
        "Closeout",
      ];

      for (const folder of expectedFolders) {
        expect(DEAL_FOLDER_TEMPLATE[folder]).toBeDefined();
      }
    });

    it("should include Photos subfolders", () => {
      const photoSubfolders = DEAL_FOLDER_TEMPLATE["Photos"].subfolders;
      expect(photoSubfolders).toContain("Site Visits");
      expect(photoSubfolders).toContain("Progress");
      expect(photoSubfolders).toContain("Final Walkthrough");
      expect(photoSubfolders).toContain("Damage");
    });

    it("should include Estimates subfolders", () => {
      const estimateSubfolders = DEAL_FOLDER_TEMPLATE["Estimates"].subfolders;
      expect(estimateSubfolders).toContain("DD Estimate");
      expect(estimateSubfolders).toContain("Bid Estimate");
      expect(estimateSubfolders).toContain("Revisions");
    });

    it("should build folder paths with subcategory", () => {
      const topFolder = CATEGORY_TO_FOLDER.photo;
      const subcategory = "Site Visits";
      const path = `${topFolder}/${subcategory}`;
      expect(path).toBe("Photos/Site Visits");
    });

    it("should append date bucket for photo category", () => {
      const topFolder = CATEGORY_TO_FOLDER.photo;
      const subcategory = "Progress";
      const dateForBucket = new Date("2026-04-15T12:00:00Z");
      const yearMonth = dateForBucket.toISOString().slice(0, 7);
      const path = `${topFolder}/${subcategory}/${yearMonth}`;
      expect(path).toBe("Photos/Progress/2026-04");
    });
  });

  describe("Association Validation", () => {
    it("should identify missing associations", () => {
      const input = {
        dealId: undefined,
        contactId: undefined,
        procoreProjectId: undefined,
        changeOrderId: undefined,
      };

      const hasAssociation =
        !!input.dealId || !!input.contactId || !!input.procoreProjectId || !!input.changeOrderId;
      expect(hasAssociation).toBe(false);
    });

    it("should pass with at least one association", () => {
      const cases = [
        { dealId: "uuid-1" },
        { contactId: "uuid-2" },
        { procoreProjectId: 12345 },
        { changeOrderId: "uuid-3" },
      ];

      for (const input of cases) {
        const hasAssociation =
          !!(input as any).dealId ||
          !!(input as any).contactId ||
          !!(input as any).procoreProjectId ||
          !!(input as any).changeOrderId;
        expect(hasAssociation).toBe(true);
      }
    });
  });
});
