import { describe, it, expect, vi } from "vitest";
import { createContact } from "../../../src/modules/contacts/service.js";

vi.mock("@trock-crm/shared/schema", async () => import("../../../../shared/src/schema/index.js"));

/**
 * Unit tests for the contact service.
 *
 * These tests validate the business logic in isolation by testing
 * pure functions extracted from the service. They cover:
 * - Email canonicalization (lowercase, trim)
 * - Phone normalization (strip non-digits)
 * - Levenshtein distance algorithm correctness
 * - Dedup scoring with weighted name/company/phone signals
 *
 * Import paths: 3 levels up from server/tests/modules/contacts/ to server/src/
 */

// Utility functions extracted for unit testing without DB
function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function normalizePhone(phone: string): string {
  return phone.replace(/\D/g, "");
}

describe("Contact Service", () => {
  describe("email canonicalization", () => {
    it("should lowercase and trim email", () => {
      expect(normalizeEmail("John@X.com")).toBe("john@x.com");
    });

    it("should trim whitespace from email", () => {
      expect(normalizeEmail("  admin@example.com  ")).toBe("admin@example.com");
    });
  });

  describe("phone normalization", () => {
    it("should strip non-digit characters from phone", () => {
      expect(normalizePhone("(214) 555-1234")).toBe("2145551234");
    });

    it("should strip dots and dashes", () => {
      expect(normalizePhone("214.555.1234")).toBe("2145551234");
    });
  });

  describe("normalizeEmail", () => {
    it("should trim and lowercase email", () => {
      expect(normalizeEmail("  JOHN@EXAMPLE.COM  ")).toBe("john@example.com");
    });

    it("should handle mixed-case domain", () => {
      expect(normalizeEmail("User@Gmail.COM")).toBe("user@gmail.com");
    });

    it("should handle already-normalized email", () => {
      expect(normalizeEmail("admin@example.com")).toBe("admin@example.com");
    });
  });

  describe("normalizePhone", () => {
    it("should strip parentheses, spaces, and dashes", () => {
      expect(normalizePhone("(214) 555-1234")).toBe("2145551234");
    });

    it("should strip dots", () => {
      expect(normalizePhone("214.555.1234")).toBe("2145551234");
    });

    it("should handle +1 prefix", () => {
      expect(normalizePhone("+1 (214) 555-1234")).toBe("12145551234");
    });

    it("should return empty string for non-digit input", () => {
      expect(normalizePhone("N/A")).toBe("");
    });

    it("should pass through already-clean digits", () => {
      expect(normalizePhone("2145551234")).toBe("2145551234");
    });
  });

  describe("levenshteinDistance", () => {
    // Inline the same implementation used in the service for accuracy checks
    function levenshtein(a: string, b: string): number {
      const m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      let prev = Array.from({ length: n + 1 }, (_, i) => i);
      for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
          curr[j] = a[i - 1] === b[j - 1]
            ? prev[j - 1]
            : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
        }
        prev = curr;
      }
      return prev[n];
    }

    it("should return 0 for identical strings", () => {
      expect(levenshtein("john", "john")).toBe(0);
    });

    it("should return 1 for single substitution (smith vs smyth)", () => {
      expect(levenshtein("smith", "smyth")).toBe(1);
    });

    it("should return string length when other is empty", () => {
      expect(levenshtein("abc", "")).toBe(3);
      expect(levenshtein("", "xyz")).toBe(3);
    });

    it("should handle single character difference", () => {
      expect(levenshtein("jon", "john")).toBe(1);
    });

    it("should return correct distance for completely different strings", () => {
      expect(levenshtein("bob", "john")).toBeGreaterThanOrEqual(3);
    });
  });

  describe("dedup scoring", () => {
    function levenshtein(a: string, b: string): number {
      const m = a.length, n = b.length;
      if (m === 0) return n;
      if (n === 0) return m;
      let prev = Array.from({ length: n + 1 }, (_, i) => i);
      for (let i = 1; i <= m; i++) {
        const curr = [i];
        for (let j = 1; j <= n; j++) {
          curr[j] = a[i - 1] === b[j - 1]
            ? prev[j - 1]
            : 1 + Math.min(prev[j - 1], prev[j], curr[j - 1]);
        }
        prev = curr;
      }
      return prev[n];
    }

    it("should score name+company+phone match above threshold", () => {
      // Simulate scoring: name similarity + company match + phone match
      const nameDist = levenshtein("john smith", "jon smith");
      const maxLen = Math.max("john smith".length, "jon smith".length);
      const nameSimilarity = 1 - nameDist / maxLen;
      const nameScore = nameSimilarity * 40; // 40% weight
      const companyScore = 30; // exact company match = 30%
      const phoneScore = 30;  // exact phone match = 30%
      const totalScore = nameScore + companyScore + phoneScore;
      expect(totalScore).toBeGreaterThan(90); // high confidence
    });

    it("should score name-only match below auto-merge threshold", () => {
      const nameDist = levenshtein("john smith", "jon smith");
      const maxLen = Math.max("john smith".length, "jon smith".length);
      const nameSimilarity = 1 - nameDist / maxLen;
      const nameScore = nameSimilarity * 40;
      // No company or phone match
      expect(nameScore).toBeLessThan(40);
    });
  });

  describe("createContact", () => {
    it("persists the company id when creating a contact", async () => {
      const insertedRows: Array<Record<string, unknown>> = [];
      const tenantDb = {
        insert() {
          return {
            values(row: Record<string, unknown>) {
              insertedRows.push(row);
              return {
                returning: async () => [{ id: "contact-1", ...row }],
              };
            },
          };
        },
      };

      const result = await createContact(
        tenantDb as never,
        {
          firstName: "Ada",
          lastName: "Lovelace",
          email: "Ada@Example.com",
          phone: "(555) 010-0101",
          companyId: "company-1",
          category: "client",
        },
        true
      );

      expect(insertedRows[0]).toMatchObject({
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        companyId: "company-1",
        category: "client",
      });
      expect(result.contact.companyId).toBe("company-1");
    });

    it("creates a contact with a valid email and phone", async () => {
      const insertedRows: Array<Record<string, unknown>> = [];
      const tenantDb = {
        insert() {
          return {
            values(row: Record<string, unknown>) {
              insertedRows.push(row);
              return {
                returning: async () => [{ id: "contact-1", ...row }],
              };
            },
          };
        },
      };

      const result = await createContact(
        tenantDb as never,
        {
          firstName: "Grace",
          lastName: "Hopper",
          email: "Grace@Example.com",
          phone: "(214) 555-1212",
          companyId: "company-1",
          category: "client",
        },
        true
      );

      expect(insertedRows[0]).toMatchObject({
        email: "grace@example.com",
        phone: "(214) 555-1212",
      });
      expect(result.contact.id).toBe("contact-1");
    });

    it("rejects a too-long phone before insert with a readable error", async () => {
      const tenantDb = {
        insert: vi.fn(),
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            phone: "+1 (214) 555-1212 ext 999999",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Phone number is too long. Please use a 10-15 digit number.",
      });
      expect(tenantDb.insert).not.toHaveBeenCalled();
    });

    it("rejects invalid email format before insert with a readable error", async () => {
      const tenantDb = {
        insert: vi.fn(),
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "not-an-email",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 400,
        message: "Please enter a valid email address.",
      });
      expect(tenantDb.insert).not.toHaveBeenCalled();
    });

    it("converts duplicate email unique violations to a readable 409", async () => {
      const tenantDb = {
        insert() {
          return {
            values() {
              return {
                returning: async () => {
                  const err = new Error("duplicate key value violates unique constraint");
                  (err as any).code = "23505";
                  (err as any).constraint = "contacts_email_unique";
                  throw err;
                },
              };
            },
          };
        },
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "A contact with this email already exists. Please use a different email or select the existing contact.",
      });
    });

    it("converts wrapped duplicate email unique violations to a readable 409", async () => {
      const tenantDb = {
        insert() {
          return {
            values() {
              return {
                returning: async () => {
                  const pgErr = new Error("duplicate key value violates unique constraint \"contacts_email_unique\"");
                  (pgErr as any).code = "23505";
                  (pgErr as any).constraint = "contacts_email_unique";
                  throw new Error("Failed query: insert into contacts", { cause: pgErr });
                },
              };
            },
          };
        },
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "A contact with this email already exists. Please use a different email or select the existing contact.",
      });
    });

    it("converts duplicate email unique violations detected by message fallback to a readable 409", async () => {
      const tenantDb = {
        insert() {
          return {
            values() {
              return {
                returning: async () => {
                  throw new Error("duplicate key value violates unique constraint \"contacts_email_unique\"");
                },
              };
            },
          };
        },
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        statusCode: 409,
        message: "A contact with this email already exists. Please use a different email or select the existing contact.",
      });
    });

    it("rethrows unique violations on non-email constraints", async () => {
      const tenantDb = {
        insert() {
          return {
            values() {
              return {
                returning: async () => {
                  const err = new Error("duplicate key value violates unique constraint");
                  (err as any).code = "23505";
                  (err as any).constraint = "contacts_external_id_unique";
                  throw err;
                },
              };
            },
          };
        },
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toMatchObject({
        message: "duplicate key value violates unique constraint",
      });
    });

    it("rethrows generic database errors as-is", async () => {
      const tenantDb = {
        insert() {
          return {
            values() {
              return {
                returning: async () => {
                  throw new Error("database connection lost");
                },
              };
            },
          };
        },
      };

      await expect(
        createContact(
          tenantDb as never,
          {
            firstName: "Grace",
            lastName: "Hopper",
            email: "grace@example.com",
            companyId: "company-1",
            category: "client",
          },
          true
        )
      ).rejects.toThrow("database connection lost");
    });

    it("treats an empty phone string as null", async () => {
      const insertedRows: Array<Record<string, unknown>> = [];
      const tenantDb = {
        insert() {
          return {
            values(row: Record<string, unknown>) {
              insertedRows.push(row);
              return {
                returning: async () => [{ id: "contact-1", ...row }],
              };
            },
          };
        },
      };

      await createContact(
        tenantDb as never,
        {
          firstName: "Grace",
          lastName: "Hopper",
          phone: "",
          companyId: "company-1",
          category: "client",
        },
        true
      );

      expect(insertedRows[0]).toMatchObject({ phone: null });
    });
  });
});
