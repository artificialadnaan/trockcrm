# MCP Chart Seam — Build Spec (GREEN lane)

**Status:** design-frozen, ready to build. Authored from the GREEN design panel
(security-strict synthesis). **Security core is fixed — do not weaken it. Only the
file paths in this doc were remapped** off the now-dropped `apps/ai-demo` workspace.

**Owner of this seam:** GREEN (AI chat endpoint + connector + chat UI + chart seam).
**Out of scope here (owned by BLUE / orchestrator):** the scoped MCP session token
(`mintSessionToken` / `validateSessionToken`), the `/mcp` server, and the read-only
MCP tools. This spec consumes them; it does not define them.

---

## 0. Final file layout (remapped — `apps/ai-demo` is dropped)

All code lives in the **existing** `server` and `client` workspaces. The demo is
deployed as a **separate Railway service from the `server` workspace** (same code, a
distinct start target) — not a new workspace.

| Concern | Path |
|---|---|
| Chat endpoint (SSE) | `server/src/modules/ai-chat/routes.ts` |
| Anthropic stream relay + capture + `pause_turn` loop + fence splitter | `server/src/modules/ai-chat/anthropic-stream.ts` |
| **Chart seam — the single enforcement point** | `server/src/modules/ai-chat/chart-seam.ts` |
| System prompt builder | `server/src/modules/ai-chat/system-prompt.ts` |
| MCP server / auth / tools (BLUE) | `server/src/mcp/**` (imported, not authored here) |
| SSE write helper (REUSE) | `server/src/modules/notifications/sse-manager.ts` (`writeSse`, `buildSsePaddingComment`) |
| Raw-fetch-to-Anthropic precedent (REUSE pattern) | `server/src/modules/ai-copilot/provider.ts` |
| Streaming hook | `client/src/hooks/use-ai-chat-stream.ts` |
| Chat panel | `client/src/components/ai/green-chat-panel.tsx` |
| Chart renderer (vega-embed) | `client/src/components/ai/chart-block.tsx` |
| Debug strip (off by default) | `client/src/components/ai/tool-debug-strip.tsx` |

New client dependency: **`vega-embed`** (not currently in `client/package.json`).
Lazy-load `chart-block.tsx` so non-chart turns / the rest of the CRM don't pay the
bundle cost.

---

## 1. The invariant (non-negotiable)

> **Model-typed numbers must NEVER reach a rendered chart. A chart's data comes ONLY
> from the verbatim output of an allowlisted analytics tool (a SQL result observed in
> an `mcp_tool_result` block). If the data cannot be resolved to real tool output, NO
> chart renders — there is never a fallback to model numbers.**

This is made **structural**, not advisory, by three stacked guarantees (each
independently sufficient):

1. **Channel separation.** The client renders charts **only** from validated `chart`
   SSE events — never by parsing assistant text. An inline ` ```vega `/` ```json `
   block with numbers in prose renders as **inert text**; it can never reach
   `vega-embed`.
2. **Zero-number skeleton.** The model-authored spec subtree is asserted to contain
   **no numeric literal anywhere** (`typeof === 'number' | 'bigint'`). Field names
   stay strings (column references), so `fy2024_total` passes; any `data.values`,
   `datum`, numeric `value`, `scale.domain`, `tickValues`, or `transform` literal
   trips the check and **drops the whole chart**.
3. **Server-only data.** The final `spec.data.values` is assigned **exclusively** from
   `parseAnalyticsRows(capturedResult)`. The model spec is **allowlist-rebuilt** (not
   strip-in-place), so there is no structural slot for model data even before the
   number check runs.

**Why this is safe even against an adversarial model:** numbers and chart-shape travel
on two disjoint channels that only ever join inside one server function, where the
model's contribution is rebuilt to a closed set of string/enum fields, asserted
number-free, and the sole numeric field (`data.values`) is sourced only from verbatim
allowlisted-analytics output. An `mcp_tool_result` is a content-block **type the model
does not author** (Anthropic emits it after executing BLUE's read-only tool
server-side), so the model can never forge chart data.

---

## 2. Model output contract

A chart is a **fenced code block** whose info-string is exactly **`trock-chart`**,
containing one JSON object with keys `dataRef`, `spec`, and optional `title`. `spec`
is a Vega-Lite spec **minus any data**.

````
```trock-chart
{"dataRef":{"tool":"run_analytics_query"},
 "spec":{"mark":"bar",
   "encoding":{
     "x":{"field":"stage_name","type":"nominal","sort":"-y"},
     "y":{"field":"total_value","type":"quantitative","title":"Pipeline value"}}},
 "title":"Pipeline value by stage"}
```
````

- The model references columns it **saw** in the tool result (`stage_name`,
  `total_value`) as string field names — it never restates their numeric values.
- **`dataRef = { tool: string, resultIndex?: number }`** — `tool` is the analytics
  tool **name** the model just invoked (it copies this straight off its own
  `mcp_tool_use`, so it is trivial to reproduce; no opaque id to echo, no number to
  invent). `resultIndex` (0-based) is **only** needed to disambiguate when the same
  tool was called more than once in the turn.

---

## 3. System prompt (`system-prompt.ts`) — verbatim

General rules:

- SQL/analytics tools **own every number**. The model knows no figure on its own; the
  only way a real number reaches the answer is by querying it.
- For email: call **`list_email_threads` first**, then **`get_email_thread` only for
  the specific thread(s) needed** — never bulk-fetch bodies (protects the context
  budget).

Chart contract sentences (ship verbatim):

- "To draw a chart, emit a fenced block whose info string is exactly `trock-chart`
  containing a JSON object with keys `dataRef` and `spec`. Emit it AFTER you have
  received the analytics tool result you want to chart."
- "`dataRef.tool` MUST be the name of the analytics tool whose result you are charting
  (e.g. the tool you just called). If you called that same tool more than once this
  turn, also set `dataRef.resultIndex` to the 0-based position of the specific result
  among ALL analytics results you have received so far."
- "`spec` is a Vega-Lite spec WITHOUT any data: provide only `mark`, `encoding`, and
  optional `title`. In each encoding channel use only `field` (a column NAME from the
  tool result), `type` (nominal|ordinal|quantitative|temporal), and optionally
  `aggregate`, `timeUnit`, `sort`, `title`."
- "NEVER write numeric values anywhere in the chart block — no `data`, no `datum`, no
  `value`, no `scale`, no axis numbers, no totals in the title. Reference data ONLY by
  column name; the system fills in the real numbers. A chart block containing any
  number will be discarded."
- "If you want to state a figure in prose, do so in normal text outside the chart
  block."

Ship **one** one-shot example identical in shape to §2 so first-try formatting is
locked in. `aggregate` (sum/mean/count) is allowed: it is a deterministic computation
over verbatim trusted rows, introducing no model numbers.

---

## 4. Connector call (context — the surrounding endpoint)

`server/src/modules/ai-chat/routes.ts` → `POST /api/ai-chat`. Stateless: the client
sends the **full message history** each call. Raw `fetch` to
`https://api.anthropic.com/v1/messages` (matching `ai-copilot/provider.ts`; no SDK),
`stream: true`, headers `x-api-key: ANTHROPIC_API_KEY`, `anthropic-version: 2023-06-01`,
and **`anthropic-beta: mcp-client-2025-11-20`** (current MCP-connector beta; the
`…-04-04` header is deprecated). Body:

```jsonc
{
  "model": "claude-sonnet-4-6",
  "stream": true,
  "max_tokens": 4096,
  "system": "<system-prompt.ts>",
  "messages": [ /* full history */ ],
  "mcp_servers": [
    { "type": "url", "url": "<PUBLIC_BASE_URL>/mcp",
      "name": "trock-data", "authorization_token": "<minted scoped token>" }
  ],
  "tools": [ { "type": "mcp_toolset", "mcp_server_name": "trock-data" } ]
}
```

> **Required, easy to miss:** the current beta **requires** the paired
> `tools: [{ type: "mcp_toolset", mcp_server_name: "trock-data" }]` for every
> `mcp_servers` entry — the `mcp_servers`-only shape returns a 400
> ("every MCP server must be referenced by exactly one MCPToolset").

`PUBLIC_BASE_URL` resolves to the server's public origin (existing precedent:
`API_BASE_URL` → `FRONTEND_URL` fallback). The MCP-connector URL must be `https://`.

**Auth seam (BLUE-owned, out of scope here):** the endpoint sits behind BLUE's page
password gate, validates BLUE's cookie via `validateSessionToken`, then mints a
**fixed Dallas `read_all`** token via `mintSessionToken` and passes it as
`authorization_token`. The client never sees the token; office is derived
server-side (`office_dallas`), never from the request body. There is no role/403 path
in this lane.

---

## 5. Server flow (`anthropic-stream.ts`)

Relays the Anthropic SSE to the client while running a content-block state machine.
Turn state is **preserved across `pause_turn` continuations**:

```ts
toolUseById: Map<string, string>            // mcp_tool_use id -> tool name
analyticsResults: Array<{                    // ORDERED, turn-global
  toolUseId: string; toolName: string;
  rows: Row[] | null; valid: boolean;
}>
// + fence-splitter carry buffer
```

**Capture (keyed by Anthropic stream `index`):**

1. `message_start` → init turn state.
2. `content_block_start` type `mcp_tool_use` → record `{id, name, server_name}`,
   `toolUseById.set(id, name)`; emit `tool_debug{kind:'tool_use'}`. (Tool input streams
   via `input_json_delta`; ignored for charts.)
3. `content_block_start` type `mcp_tool_result` `{tool_use_id, is_error}` → accumulate
   `content[].text` across deltas until `content_block_stop`. On stop:
   `name = toolUseById[tool_use_id]`; push an `analyticsResults` entry, **`valid` only
   if** `name ∈ ANALYTICS_TOOL_NAMES` **and** `is_error !== true` **and**
   `parseAnalyticsRows` succeeds; else `rows=null, valid=false`. Emit
   `tool_debug{kind:'tool_result', is_error, rowCount|reason}`. Email-tool results
   (`list_email_threads`/`get_email_thread`) are **not** in the allowlist → never
   chartable.
   > NOTE: server-executed MCP results may arrive whole at `content_block_start`
   > rather than via deltas — accumulate at **start AND on any delta**, finalize at
   > `content_block_stop`, or rows get missed and charts silently drop.
4. `content_block_delta` type `text_delta` → feed into the **fence splitter**.

**`parseAnalyticsRows` (strict, drop-on-doubt):** concat result text → `JSON.parse`
(reject on throw) → accept a top-level array **or** `{rows:[...]}` / `{data:[...]}` →
require an array of length **1..1000** → require every element to be a **plain object
whose every value is `string|number|boolean|null`** (reject nested objects/arrays) →
cap total cells (~20k). Rows kept **verbatim** (no coercion). Any failure ⇒
`valid=false`.

**Fence splitter (quarantines chart JSON from prose):**
- NORMAL: append delta to a small carry buffer; emit as `text` everything except a
  trailing tail that could be a prefix of the sentinel `` ```trock-chart ``. On the
  full sentinel, drop it from user-facing text and switch to CHART.
- CHART: append to a chart buffer, **never** emit as text; on the next closing
  `` ``` `` hand the buffer to `buildChartFromModelBlock(buffer, analyticsResults)`.
- An **unclosed** CHART buffer at `done` ⇒ `chart_dropped` (never flushed as text).
- The opening sentinel may split across two `text_delta` chunks (e.g. `` ```troc ``
  then `k-chart`); the scanner must withhold a small tail. (Unit-test adversarial
  chunk boundaries.)

**`pause_turn`:** on `message_delta` `stop_reason: "pause_turn"`, re-POST
`/v1/messages` with the running assistant content appended (continue the server-side
tool loop) while **keeping the same turn state** — `analyticsResults` keeps growing,
`resultIndex` is turn-global, an open CHART buffer persists. Only a terminal
`stop_reason` emits `done`. Continuations are **invisible** to the client (no event
boundary).

---

## 6. The single enforcement point (`chart-seam.ts`)

`buildChartFromModelBlock(rawBlock, analyticsResults)` is the **only** function
permitted to return a renderable spec; the relay emits a `chart` event **iff** it
returns non-null. Steps — any failure ⇒ `return null` ⇒ `chart_dropped` (never a
fallback):

1. `JSON.parse(rawBlock)`; require an object with `dataRef` + `spec`. Fail ⇒ drop
   (`parse_failed`).
2. **Allowlist-REBUILD `spec`** (rebuild, not strip-in-place, so unknown keys cannot
   survive): copy only `mark` (enum string) and `encoding`; per channel copy only
   `{ field, type, aggregate, timeUnit, sort(string/enum), title(string) }`. Drop
   `data`, `transform`, `datum`, `value`, `scale`, axis numbers, `layer`, `params`,
   `datasets`.
3. **`assertNumberFree(rebuiltSpec)`** — recursively walk; if **any** node is
   `typeof === 'number' | 'bigint'` ⇒ drop (`numbers_in_spec`).
4. **Resolve `dataRef`** against `analyticsResults`:
   - `candidates = analyticsResults.filter(r => r.toolName === dataRef.tool && r.valid)`.
   - 0 candidates ⇒ drop (`unresolved_dataRef`).
   - exactly 1 ⇒ use it; `resultIndex` ignored (the common single-call demo case).
   - >1 ⇒ require `dataRef.resultIndex` to be an integer in
     `[0, analyticsResults.length)`; the entry at that **global** index must itself
     satisfy `toolName === dataRef.tool && valid`; otherwise drop. **Never guess among
     ambiguous candidates.**
5. **Field existence:** every `encoding.field` must be a key present in
   `resolved.rows[0]`; else drop (`unknown_field`) — kills invented columns.
6. `finalSpec = { $schema, width, height, config /* server constants */, ...rebuiltSpec,
   data: { values: resolved.rows } }`. **`data` is overwritten LAST**, so it can only
   ever be verbatim tool rows.

**Load-bearing line:** `finalSpec.data = { values: resolved.rows }`, reached only after
`assertNumberFree` passes; `resolved.rows` is exclusively
`parseAnalyticsRows(capturedResult)`. The model spec is never spread into `data`.

**Security note on `dataRef`:** even a maliciously wrong `dataRef` can only resolve to
a **real** captured analytics result's verbatim rows (a correctness concern — which
trusted dataset is plotted), never model numbers (the invariant), which is enforced
separately by steps 2–3 + 6.

### Enumerated leak vectors → all drop
- inline `data.values`/`data.url`, `datasets` → not copied in rebuild; numbers also
  caught in step 3.
- Vega `datum` reference line with a number → `datum` not copied; numeric caught.
- constant `value` encoding (`y:{value:0}`) → `value` not copied; numeric caught.
- `scale.domain` / `tickValues` / axis values → not copied; numeric caught.
- `transform` `calculate`/`filter` with literal numbers → `transform` not copied;
  numeric caught.
- number embedded in a string field name → harmless (string column ref; if no such
  column, step 5 drops).
- `dataRef` → email/non-analytics tool, or an `is_error` result → `valid=false` ⇒
  step 4 drops.
- malformed/huge tool rows → `parseAnalyticsRows` fails ⇒ `valid=false` ⇒ drop.
- unclosed fence at end of turn → buffer dropped, never emitted as text or chart.
- inline ` ```vega ` spec in prose → client never parses text into charts ⇒ inert.

---

## 7. SSE protocol

Transport mirrors `notifications/routes.ts`: status 200, `Content-Type:
text/event-stream`, `Connection: keep-alive`, `X-Accel-Buffering: no`,
`res.flushHeaders()`, first frame `writeSse(res, buildSsePaddingComment())` to warm
proxies, a `: keepalive` comment every ~30s, cleanup on `req.on('close')`. All frames
use the existing `event: <type>\ndata: <json>\n\n` framing via `writeSse`.

| Event | `data` payload | Channel |
|---|---|---|
| `meta` | `{ turnId }` | once, first |
| `text` | `{ delta: string }` | transcript (chart fences already stripped) |
| `chart` | `{ id: string, spec: VegaLiteSpec /* data.values already injected */ }` | transcript |
| `tool_debug` | `{ kind:'tool_use'\|'tool_result', name, server_name?, toolUseId, isError?, rowCount?, reason? }` | debug strip (NO raw rows) |
| `chart_dropped` | `{ reason:'parse_failed'\|'numbers_in_spec'\|'unresolved_dataRef'\|'unknown_field'\|'invalid_rows'\|'unclosed_fence' }` | debug strip |
| `error` | `{ message }` | terminal |
| `done` | `{ stopReason }` | terminal, exactly once |

**Ordering:** `meta` first; `done` last and exactly once; `error` is terminal if
present. `text` and `chart` are emitted in true stream order, so a chart lands exactly
where the model placed its fence relative to prose — the client just appends segments
in arrival order. A `chart` for result R is necessarily emitted **after** the
`tool_debug{tool_result}` for R. `pause_turn` continuations emit no boundary.

---

## 8. Client render

**`use-ai-chat-stream.ts`** — POST the full history with `fetch` (`credentials:
'include'`, plus CSRF + `x-office-id` mirrored from `client/src/lib/api.ts`
conventions; **`api()` itself can't be used — it JSON-parses the body**). Read
`response.body.getReader()` + `TextDecoder`, buffer by `\n\n`, parse each
`event:`/`data:` frame. Maintain an **ordered** segment array for the in-flight
assistant message: `Array<{type:'text', text} | {type:'chart', id, spec}>` — `text`
deltas append to the trailing text segment; a `chart` event pushes a chart segment and
starts a fresh text segment after it (preserving interleave from arrival order).
`tool_debug`/`chart_dropped` accumulate into a separate `debugEvents` array.

**`green-chat-panel.tsx`** — map segments in order: text → markdown/prose renderer;
chart → `chart-block.tsx`.

**`chart-block.tsx`** — `vegaEmbed(ref, spec, { actions:false, renderer:'svg' })` in a
`useEffect`, re-run on spec change, call the returned `finalize()` on cleanup. It does
**zero** data work: never fetches, computes, parses tool output, or reads assistant
text — it only renders the spec object handed to it. Wrap in the existing `ui/card`.
Lazy-load this component (vega bundle).

**`tool-debug-strip.tsx`** — OFF by default (`useState(false)`); a plain `Button`
toggles it (no `collapsible` primitive exists → conditional render). When on, lists
`debugEvents` inside a `div` with `max-h` + `overflow-y-auto` (no `scroll-area`
primitive exists). Purely diagnostic; no path to the chart renderer.

---

## 9. `ANALYTICS_TOOL_NAMES` (security-critical config)

A **default-deny** allowlist of BLUE's analytics/SQL tool names — the **only** tool
outputs eligible to back a chart. **Source it from BLUE's tool registry/constant**, do
not hardcode the strings in two places. Email tools are deliberately excluded so PII
(email bodies) can never be charted. **Pin it with a test** (asserts the set, asserts
email tools are absent) — a mis-set allowlist either drops every chart or, worse, could
chart PII.

---

## 10. TDD plan (write tests first)

CI runs `*.test.ts(x)` under `server/tests/**` + `server/src/**` and
`client/src/**` — name files accordingly so they execute in the gate.

**`server/src/modules/ai-chat/chart-seam.test.ts`** (the invariant — highest priority):
- `parseAnalyticsRows`: accepts `[...]`, `{rows:[...]}`, `{data:[...]}`; rejects
  non-array, nested-object rows, `> 1000` rows, `>` cell cap, non-JSON.
- happy path: single valid analytics result, `dataRef={tool}` → `finalSpec.data.values`
  is **deep-equal to the verbatim captured rows**.
- **numbers dropped:** spec with a numeric literal anywhere (`data.values`, `datum`,
  numeric `value`, `scale.domain`, numeric `title`) ⇒ `null` (`numbers_in_spec`).
- model supplies `data.values` full of numbers ⇒ never in output (rebuild drops +
  number-free catches) ⇒ drop.
- `dataRef.tool` not captured / `valid:false` / points at an email tool ⇒ `null`
  (`unresolved_dataRef`).
- `encoding.field` not a column in rows ⇒ `null` (`unknown_field`).
- multi-result: `>1` candidate with missing/out-of-range `resultIndex` ⇒ drop; valid
  `resultIndex` ⇒ correct dataset.
- allowlist-rebuild: `transform`/`params`/`layer`/`datasets` are stripped from output.

**`server/src/modules/ai-chat/anthropic-stream.test.ts`** (fence splitter, pure):
- sentinel split across deltas (`` ```troc `` + `k-chart`) → no partial fence leaks to
  prose; chart parsed correctly.
- backticked prose (non-`trock-chart`) is **not** mistaken for a chart.
- unclosed fence at `done` ⇒ `chart_dropped`, never emitted as text.
- `mcp_tool_result` arriving whole-at-start vs via deltas both captured.

**`client/src/components/ai/use-ai-chat-stream.test.ts`** (pure SSE parser):
- feed raw SSE frames → ordered `segments` with interleaved text + chart in stream
  order; `tool_debug`/`chart_dropped` routed to `debugEvents`, not the transcript.

**Allowlist test:** pins `ANALYTICS_TOOL_NAMES` (default-deny; email tools excluded).

---

## 11. Open items / decisions

- **`ANALYTICS_TOOL_NAMES`** must match BLUE's real tool names (source from BLUE's
  registry; default-deny). Blocks correct charts until populated.
- **Digit-bearing titles:** the number-free walk treats a `title` string as allowed
  (it is a label, not chart data). For maximum strictness, optionally reject titles
  matching `/\d/` (drops e.g. "Q1 2024 pipeline"). **Decision needed** — this is a
  UX/strictness dial, not a data-invariant requirement. Default: accept string titles.
- **`pause_turn`** re-send must replay the exact running assistant content or the
  server-side tool loop desyncs and `resultIndex` counting drifts.
- **`vega-embed`** is a sizable bundle — lazy-load `chart-block.tsx`.
- **Auth** (`mintSessionToken` / `validateSessionToken`) is BLUE/orchestrator-owned;
  the chat endpoint imports them. Not specified here.
- Out of scope of the invariant: a model-typed number in **prose** (outside a chart)
  may read as authoritative. Accepted; document in the UI if needed.
