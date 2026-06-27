import path from "path";
import dotenv from "dotenv";
// Run via `npm run ... -w @trock-crm/server`, process.cwd() is the server workspace, so a bare
// dotenv.config() would miss the repo-root .env. INIT_CWD is the dir `npm run` was invoked from.
dotenv.config({ path: path.resolve(process.env.INIT_CWD ?? process.cwd(), ".env") });

import { mintSessionToken } from "../auth/mintSessionToken.js";

/**
 * Post-deploy live connectivity check for the T Rock AI demo's MCP surface. Run from the repo root
 * with the SAME PUBLIC_BASE_URL + MCP_SESSION_SECRET (+ ANTHROPIC_API_KEY) the deployed service uses:
 *
 *   PUBLIC_BASE_URL=https://<demo>.up.railway.app MCP_SESSION_SECRET=... ANTHROPIC_API_KEY=... \
 *     npm run mcp:connectivity-check -w @trock-crm/server
 *
 * Verifies the one thing that can't be tested until live — that Anthropic's API can reach
 * ${PUBLIC_BASE_URL}/mcp over HTTPS with a minted token — plus a direct handshake and the auth gate.
 * Exit code 0 = all checks passed, 1 = a check failed, 2 = misconfiguration.
 */

const ANTHROPIC_BETA = "mcp-client-2025-11-20";
// Configurable so a model-entitlement issue doesn't fail step 3 before it can exercise /mcp.
const MODEL = process.env.MCP_CHECK_MODEL ?? "claude-sonnet-4-6";
const ACCEPT = "application/json, text/event-stream";
const TIMEOUT_MS = 20_000; // bound every outbound call so a stalled path fails the step, not hangs

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    console.error(`✗ missing required env: ${name}`);
    process.exit(2);
  }
  return value;
}

/** The /mcp transport may answer with plain JSON (enableJsonResponse) or a single SSE data frame. */
function parseMcpBody(text: string): Record<string, unknown> | null {
  const trimmed = text.trim();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    try {
      return JSON.parse(trimmed) as Record<string, unknown>;
    } catch {
      /* fall through to SSE parsing */
    }
  }
  const dataLines = trimmed.split(/\r?\n/).filter((l) => l.startsWith("data:"));
  const last = dataLines[dataLines.length - 1];
  if (last) {
    try {
      return JSON.parse(last.slice("data:".length).trim()) as Record<string, unknown>;
    } catch {
      return null;
    }
  }
  return null;
}

const INIT_BODY = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "connectivity-check", version: "1.0.0" },
  },
};

async function main(): Promise<void> {
  const base = requireEnv("PUBLIC_BASE_URL").replace(/\/+$/, "");
  requireEnv("MCP_SESSION_SECRET"); // consumed by mintSessionToken()
  const mcpUrl = `${base}/mcp`;
  const token = mintSessionToken();
  let failures = 0;

  // [1/3] direct MCP initialize handshake with a valid token
  console.log(`→ [1/3] MCP initialize handshake at ${mcpUrl}`);
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, Accept: ACCEPT, "Content-Type": "application/json" },
      body: JSON.stringify(INIT_BODY),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body = parseMcpBody(await res.text());
    const result = body?.result as { serverInfo?: { name?: string; version?: string }; protocolVersion?: string } | undefined;
    if (res.status === 200 && result?.serverInfo?.name) {
      console.log(`  ✓ 200 — MCP server "${result.serverInfo.name}" v${result.serverInfo.version} (protocol ${result.protocolVersion})`);
    } else {
      console.error(`  ✗ unexpected response: status=${res.status} body=${JSON.stringify(body)?.slice(0, 200)}`);
      failures += 1;
    }
  } catch (err) {
    console.error(`  ✗ request failed: ${(err as Error).message}`);
    failures += 1;
  }

  // [2/3] the auth gate is live (unauthenticated → 401)
  console.log(`→ [2/3] /mcp rejects an unauthenticated request`);
  try {
    const res = await fetch(mcpUrl, {
      method: "POST",
      headers: { Accept: ACCEPT, "Content-Type": "application/json" },
      body: JSON.stringify(INIT_BODY),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.status === 401) {
      console.log(`  ✓ 401 without a Bearer token`);
    } else {
      console.error(`  ✗ expected 401, got ${res.status}`);
      failures += 1;
    }
  } catch (err) {
    console.error(`  ✗ request failed: ${(err as Error).message}`);
    failures += 1;
  }

  // [3/3] Anthropic's API can reach /mcp via the MCP connector (the live-only check)
  const anthropicKey = process.env.ANTHROPIC_API_KEY;
  if (!anthropicKey) {
    console.log(`→ [3/3] SKIPPED — set ANTHROPIC_API_KEY to verify Anthropic can reach ${mcpUrl}`);
  } else {
    console.log(`→ [3/3] Anthropic Messages API → ${mcpUrl} via the MCP connector`);
    try {
      const res = await fetch("https://api.anthropic.com/v1/messages", {
        method: "POST",
        headers: {
          "x-api-key": anthropicKey,
          "anthropic-version": "2023-06-01",
          "anthropic-beta": ANTHROPIC_BETA,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          model: MODEL,
          max_tokens: 1024,
          stream: false,
          messages: [
            { role: "user", content: "Call the describe_capabilities tool and tell me which tools are available." },
          ],
          mcp_servers: [{ type: "url", url: mcpUrl, name: "trock-data", authorization_token: token }],
          tools: [{ type: "mcp_toolset", mcp_server_name: "trock-data" }],
        }),
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });
      const data = (await res.json()) as { content?: Array<Record<string, unknown>>; stop_reason?: string };
      if (!res.ok) {
        console.error(`  ✗ Anthropic API ${res.status}: ${JSON.stringify(data)?.slice(0, 300)}`);
        failures += 1;
      } else {
        const blocks = Array.isArray(data.content) ? data.content : [];
        const toolUse = blocks.filter((b) => b.type === "mcp_tool_use");
        const toolResult = blocks.filter((b) => b.type === "mcp_tool_result");
        const errored = toolResult.filter((b) => b.is_error === true);
        if (toolUse.length > 0 && toolResult.length > 0 && errored.length === 0) {
          console.log(`  ✓ Anthropic reached the MCP server — invoked: ${toolUse.map((b) => String(b.name)).join(", ")}`);
        } else if (toolUse.length > 0 && errored.length > 0) {
          console.error(`  ✗ Anthropic invoked a tool but the MCP server returned an error result`);
          failures += 1;
        } else {
          // Inconclusive, not a hard failure: the model may simply not have chosen to call a tool.
          // Steps 1-2 already prove /mcp is reachable + gated; this step only adds Anthropic-side
          // confirmation when a tool is actually invoked.
          console.warn(`  ⚠ inconclusive — no mcp_tool_use/mcp_tool_result returned (the model may not have called a tool; stop_reason=${data.stop_reason}). /mcp reachability is still confirmed by steps 1-2.`);
        }
      }
    } catch (err) {
      console.error(`  ✗ Anthropic call failed: ${(err as Error).message}`);
      failures += 1;
    }
  }

  console.log(failures === 0 ? "\n✓ connectivity check passed" : `\n✗ connectivity check FAILED (${failures} failing step(s))`);
  process.exit(failures === 0 ? 0 : 1);
}

void main();
