import { describe, it, expect } from "vitest";

/**
 * Unit tests for email service pure functions.
 * Tests auto-association decision logic and HTML stripping
 * without database dependencies.
 */

// Inline stripHtml for unit testing
function stripHtml(html: string): string {
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, " ")
    .trim();
}

// Auto-association decision function (pure logic, extracted for testing)
function decideAssociation(activeDeals: Array<{ id: string; name: string }>): {
  action: "auto_associate" | "create_task" | "contact_only";
  dealId: string | null;
} {
  if (activeDeals.length === 1) {
    return { action: "auto_associate", dealId: activeDeals[0].id };
  }
  if (activeDeals.length > 1) {
    return { action: "create_task", dealId: null };
  }
  return { action: "contact_only", dealId: null };
}

describe("Email Service", () => {
  describe("stripHtml", () => {
    it("should strip HTML tags", () => {
      expect(stripHtml("<p>Hello <strong>world</strong></p>")).toBe("Hello world");
    });

    it("should decode HTML entities", () => {
      expect(stripHtml("A &amp; B &lt;C&gt; &quot;D&quot;")).toBe('A & B <C> "D"');
    });

    it("should replace &nbsp; with space", () => {
      expect(stripHtml("Hello&nbsp;world")).toBe("Hello world");
    });

    it("should collapse whitespace", () => {
      expect(stripHtml("<p>  Hello   world  </p>")).toBe("Hello world");
    });

    it("should handle empty string", () => {
      expect(stripHtml("")).toBe("");
    });

    it("should handle complex HTML email body", () => {
      const html = `
        <div style="font-family: Arial">
          <p>Hi Brett,</p>
          <p>Following up on the <strong>Project Alpha</strong> bid.</p>
          <br />
          <p>Best regards,<br />John</p>
        </div>
      `;
      const result = stripHtml(html);
      expect(result).toContain("Hi Brett");
      expect(result).toContain("Project Alpha");
      expect(result).toContain("Best regards");
      expect(result).not.toContain("<");
    });
  });

  describe("decideAssociation", () => {
    it("should auto-associate when contact has exactly 1 active deal", () => {
      const result = decideAssociation([{ id: "deal-1", name: "Deal A" }]);
      expect(result.action).toBe("auto_associate");
      expect(result.dealId).toBe("deal-1");
    });

    it("should create task when contact has multiple active deals", () => {
      const result = decideAssociation([
        { id: "deal-1", name: "Deal A" },
        { id: "deal-2", name: "Deal B" },
      ]);
      expect(result.action).toBe("create_task");
      expect(result.dealId).toBeNull();
    });

    it("should be contact-only when 0 active deals", () => {
      const result = decideAssociation([]);
      expect(result.action).toBe("contact_only");
      expect(result.dealId).toBeNull();
    });

    it("should create task for 3+ active deals", () => {
      const result = decideAssociation([
        { id: "d1", name: "A" },
        { id: "d2", name: "B" },
        { id: "d3", name: "C" },
      ]);
      expect(result.action).toBe("create_task");
      expect(result.dealId).toBeNull();
    });
  });
});
