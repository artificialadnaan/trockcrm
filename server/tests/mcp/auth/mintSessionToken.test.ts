import { describe, it, expect, beforeEach, afterEach } from "vitest";
import jwt from "jsonwebtoken";
import { mintSessionToken } from "../../../src/mcp/auth/mintSessionToken.js";
import {
  MCP_AUDIENCE,
  MCP_TOKEN_TTL_SECONDS,
} from "../../../src/mcp/auth/contract.js";
import { isKnownOfficeSchema } from "../../../src/mcp/auth/officeSchemas.js";

const ORIGINAL = process.env.MCP_SESSION_SECRET;
const SECRET = "test-mcp-secret-mint";

describe("mintSessionToken (fixed, role-free demo token)", () => {
  beforeEach(() => {
    process.env.MCP_SESSION_SECRET = SECRET;
  });
  afterEach(() => {
    if (ORIGINAL === undefined) delete process.env.MCP_SESSION_SECRET;
    else process.env.MCP_SESSION_SECRET = ORIGINAL;
  });

  it("issues a token with the hardcoded office_dallas / read_all / trock-mcp claims", () => {
    const token = mintSessionToken();
    const decoded = jwt.verify(token, SECRET, { audience: MCP_AUDIENCE }) as Record<string, unknown>;
    expect(decoded.office).toBe("office_dallas");
    expect(decoded.scope).toBe("read_all");
    expect(decoded.aud).toBe(MCP_AUDIENCE);
  });

  it("expires in exactly the configured short TTL", () => {
    const decoded = jwt.verify(mintSessionToken(), SECRET, { audience: MCP_AUDIENCE }) as {
      iat: number;
      exp: number;
    };
    expect(decoded.exp - decoded.iat).toBe(MCP_TOKEN_TTL_SECONDS);
  });

  it("is signed with HS256 (no alg-confusion surface)", () => {
    const [headerB64] = mintSessionToken().split(".");
    const header = JSON.parse(Buffer.from(headerB64, "base64url").toString());
    expect(header.alg).toBe("HS256");
  });

  it("cannot be verified with a different secret (dedicated MCP secret)", () => {
    const token = mintSessionToken();
    expect(() => jwt.verify(token, "some-other-secret", { audience: MCP_AUDIENCE })).toThrow();
  });

  it("the hardcoded office is a member of the allowlist", () => {
    const decoded = jwt.verify(mintSessionToken(), SECRET, { audience: MCP_AUDIENCE }) as {
      office: string;
    };
    expect(isKnownOfficeSchema(decoded.office)).toBe(true);
  });
});
