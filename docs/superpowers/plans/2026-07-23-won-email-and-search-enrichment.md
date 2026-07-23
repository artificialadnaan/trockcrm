# Won-metric email + global search enrichment — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the "Won metric reduced" alert email human-readable (rep names not UUIDs, plus a why-summary, job, amount, location) and add sales-rep name + deal amount to global search deal results.

**Architecture:** Feature 1 is worker-only: the pure `buildWonMetricReductionEmail` gains a summary line + Job/Amount/Location/Sales-rep rows and resolves UUID-valued changed-fields to names; the async handler supplies a batched `public.users` name map and a one-row property-location lookup (both non-fatal, no migration — snapshots already carry the $ amount). Feature 2 adds a `users` LEFT JOIN + best-value columns to `searchDeals`, threads `assignedRepName`/`dealValue` through the shared `SearchResult` type, and renders amount right-aligned with rep on the meta sub-line in both the command palette and the full search page.

**Tech Stack:** TypeScript, Node worker, Drizzle ORM (node-postgres + PGlite for runtime tests), React, Vitest.

**Spec:** `docs/superpowers/specs/2026-07-23-won-email-and-search-enrichment-design.md`

**Working dir:** the `feat/won-email-search-enrichment` worktree. All paths below are repo-relative.

---

## Task 1: Email builder — summary line, new rows, UUID→name resolution (pure)

**Files:**
- Modify: `worker/src/jobs/won-metric-reduction-alert.ts`
- Test: `worker/tests/jobs/won-metric-reduction-alert.test.ts`

The builder `buildWonMetricReductionEmail` is a pure function (no DB). This task adds all rendering logic; Task 2 wires the DB lookups that feed it.

- [ ] **Step 1: Write failing builder tests**

Add this `describe` block to `worker/tests/jobs/won-metric-reduction-alert.test.ts` (after the existing `resolveWonMetricImpact` block). It exercises the pure builder directly.

```ts
const REP_FROM = "f5ade4ca-ee41-5188-b6d6-d58a2630e89c";
const REP_TO = "e537cc4a-fc5e-46d4-901a-99a9bf5e2ec6";
const NAMES = { [REP_FROM]: "Chris Higingbotham", [REP_TO]: "Caleb Stone" };

const REASSIGN_EVENT = {
  dealId: DEAL_ID,
  dealName: "Terraces at Highbury Court",
  dealNumber: "DFW-4-16326-af",
  reportMetricKey: "assigned_rep.won_ytd",
  definitionVersion: null,
  releaseReference: null,
  actionLabel: "Won deal reassigned",
  reasonCode: "won_reassigned",
  changedFields: { assigned_rep_id: { from: REP_FROM, to: REP_TO } },
  auditReference: { actorName: "Chris Higingbotham", auditLogIds: ["10893467"] },
  newSnapshot: { awardedAmount: 12322.86, bidEstimate: 12322.86, ddEstimate: 12155.0, assignedRepId: REP_TO },
  oldSnapshot: { awardedAmount: 12322.86, assignedRepId: REP_FROM },
};

const REASSIGN_IMPACT = {
  metricKey: "assigned_rep.won_ytd",
  before: 12322.86,
  after: 0,
  delta: -12322.86,
  countBefore: 1,
  countAfter: 0,
  countDelta: -1,
  unit: "usd",
  isNegative: true,
};

describe("buildWonMetricReductionEmail — enrichment", () => {
  it("resolves rep UUIDs to names, adds a why-summary and Job/Amount/Location rows", () => {
    const email = buildWonMetricReductionEmail({
      event: REASSIGN_EVENT,
      impact: REASSIGN_IMPACT,
      officeId: OFFICE_ID,
      frontendUrl: "https://trockcrm.com",
      userNames: NAMES,
      dealLocation: { address: "50 Mount Zion Rd", city: "Atlanta", state: "GA" },
    });

    // Names, never raw UUIDs.
    expect(email.html).toContain("Chris Higingbotham");
    expect(email.html).toContain("Caleb Stone");
    expect(email.html).not.toContain(REP_FROM);
    expect(email.html).not.toContain(REP_TO);
    // Why-summary sentence.
    expect(email.html).toContain("reassigned");
    expect(email.text).toContain("Chris Higingbotham → Caleb Stone");
    // New rows.
    expect(email.html).toContain("Terraces at Highbury Court");
    expect(email.html).toContain("$12,322.86"); // Amount row (full currency)
    expect(email.html).toContain("Atlanta, GA"); // Location row
    // Existing behavior preserved.
    expect(email.html).toContain("Open Terraces at Highbury Court");
  });

  it("falls back to the raw id when a rep uuid is unknown and never throws on missing enrichment", () => {
    const email = buildWonMetricReductionEmail({
      event: REASSIGN_EVENT,
      impact: REASSIGN_IMPACT,
      frontendUrl: "https://trockcrm.com",
      // no userNames, no dealLocation
    });
    expect(email.html).toContain(REP_FROM); // unresolved id shown, not a crash
    expect(email.html).toContain("$12,322.86"); // amount still derived from snapshot
  });
});
```

- [ ] **Step 2: Run the builder tests to verify they fail**

Run: `npm run test -w worker -- won-metric-reduction-alert`
Expected: FAIL — `buildWonMetricReductionEmail` does not accept `userNames`/`dealLocation` and does not add the new rows/summary.

- [ ] **Step 3: Extend the builder's event type to read both snapshots**

In `worker/src/jobs/won-metric-reduction-alert.ts`, change `WonMetricReductionEmailEvent` (currently ends `> & { newSnapshot?: unknown };`) to also include `oldSnapshot`:

```ts
type WonMetricReductionEmailEvent = Pick<
  WonMetricReductionEvent,
  | "dealId"
  | "dealName"
  | "dealNumber"
  | "reportMetricKey"
  | "definitionVersion"
  | "releaseReference"
  | "actionLabel"
  | "reasonCode"
  | "changedFields"
  | "auditReference"
> & { newSnapshot?: unknown; oldSnapshot?: unknown };
```

- [ ] **Step 4: Add enrichment inputs + rows + summary to the builder**

In `buildWonMetricReductionEmail`, update the signature to accept the two optional inputs:

```ts
export function buildWonMetricReductionEmail(input: {
  event: WonMetricReductionEmailEvent;
  impact: WonMetricImpact;
  officeId?: string | null;
  frontendUrl: string;
  userNames?: Record<string, string> | Map<string, string>;
  dealLocation?: { address: string | null; city: string | null; state: string | null } | null;
}) {
```

Immediately after the existing `const changedFields = formatChangedFields(input.event.changedFields);` line, replace that line and add the derived values:

```ts
  const names = toNameMap(input.userNames);
  const changedFields = formatChangedFields(input.event.changedFields, names);
  const dealAmount = dealAmountFromSnapshot(input.event.newSnapshot, input.event.oldSnapshot);
  const locationText = formatDealLocation(input.dealLocation);
  const repChangeText = formatRepChange(input.event.changedFields, names);
  const summary = buildReductionSummary({
    event: input.event,
    names,
    amount: dealAmount,
    locationText,
    actorName: auditActorName(input.event.auditReference),
  });
```

Add `summary` to the plaintext body — change the `textLines` array so the summary is the first line when present:

```ts
  const textLines = [
    summary ?? "Won metric reduction detected",
    figure,
    `Reason: ${reason}`,
    `Exact action: ${action}`,
    dealName ? `Job: ${dealName}${dealNumber ? ` (${dealNumber})` : ""}` : null,
    dealAmount != null ? `Amount: ${formatCurrency(dealAmount)}` : null,
    locationText ? `Location: ${locationText}` : null,
    repChangeText ? `Sales rep: ${repChangeText}` : null,
    changedFields ? `Changed fields: ${changedFields}` : null,
    auditCitation ? `Audit citation: ${auditCitation}` : null,
    definition,
    releaseReference ? `Release reference: ${releaseReference}` : null,
    dealUrl ? `Deal: ${dealName}${dealNumber ? ` (${dealNumber})` : ""} — ${dealUrl}` : `Report: ${reportUrl}`,
  ].filter((line): line is string => Boolean(line));
```

Insert the new rows into the `rows` array (Job/Amount/Location/Sales-rep go between "Exact action" and "Changed fields"):

```ts
  const rows: Array<[string, string]> = [
    ["Figure", figure] as [string, string],
    ["Reason", reason] as [string, string],
    ["Exact action", action] as [string, string],
    ...(dealName ? ([["Job", dealNumber ? `${dealName} (${dealNumber})` : dealName]] as Array<[string, string]>) : []),
    ...(dealAmount != null ? ([["Amount", formatCurrency(dealAmount)]] as Array<[string, string]>) : []),
    ...(locationText ? ([["Location", locationText]] as Array<[string, string]>) : []),
    ...(repChangeText ? ([["Sales rep", repChangeText]] as Array<[string, string]>) : []),
    ...(changedFields ? ([["Changed fields", changedFields]] as Array<[string, string]>) : []),
    ...(auditCitation ? ([["Audit citation", auditCitation]] as Array<[string, string]>) : []),
    ...(definition ? ([["Definition", definition]] as Array<[string, string]>) : []),
    ...(releaseReference ? ([["Release", releaseReference]] as Array<[string, string]>) : []),
  ];
```

Render the summary paragraph in the HTML — replace the existing subheader paragraph
(`<p ...>A Won figure decreased and needs review.</p>`) so the summary follows it:

```ts
        <p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:20px;color:#334155;">A Won figure decreased and needs review.</p>
        ${summary ? `<p style="margin:0 0 20px;font-family:Arial,Helvetica,sans-serif;font-size:14px;line-height:21px;color:#111827;font-weight:bold;">${escapeHtml(summary)}</p>` : ""}
```

- [ ] **Step 5: Add the pure helper functions**

Add these helpers near the other formatting helpers in `worker/src/jobs/won-metric-reduction-alert.ts` (e.g. after `formatChangedFields`). Also update `formatChangedFields` to accept and use the name map.

Replace the existing `formatChangedFields`:

```ts
function formatChangedFields(value: unknown, names?: Map<string, string>): string | null {
  const parsed = parseJson(value);
  if (!isRecord(parsed)) return normalizeText(typeof parsed === "string" ? parsed : null);
  const render = (v: unknown): string => {
    if (v === undefined) return "—";
    const name = names ? resolveUserName(names, v) : null;
    return name ?? formatBrief(v);
  };
  const parts: string[] = [];
  for (const [field, change] of Object.entries(parsed).slice(0, 5)) {
    if (isRecord(change)) {
      const before = readValue(change, ["before", "old", "oldValue", "old_value", "previous", "from"]);
      const after = readValue(change, ["after", "new", "newValue", "new_value", "current", "to"]);
      if (before !== undefined || after !== undefined) {
        parts.push(`${humanizeToken(field)}: ${render(before)} → ${render(after)}`);
        continue;
      }
    }
    parts.push(`${humanizeToken(field)}: ${render(change)}`);
  }
  return parts.length ? parts.join("; ") : null;
}
```

New helpers:

```ts
function toNameMap(userNames?: Record<string, string> | Map<string, string>): Map<string, string> {
  if (userNames instanceof Map) {
    const m = new Map<string, string>();
    for (const [k, v] of userNames) m.set(k.toLowerCase(), v);
    return m;
  }
  const m = new Map<string, string>();
  if (userNames) for (const [k, v] of Object.entries(userNames)) m.set(k.toLowerCase(), v);
  return m;
}

function resolveUserName(names: Map<string, string>, value: unknown): string | null {
  if (typeof value !== "string") return null;
  const v = value.trim();
  if (!UUID_RE.test(v)) return null;
  return names.get(v.toLowerCase()) ?? null;
}

function snapshotBestValue(snapshot: unknown): number | null {
  const s = parseJson(snapshot);
  if (!isRecord(s)) return null;
  return (
    numericValue(s.awardedAmount) ??
    numericValue(s.bidBoardTotalSales) ??
    numericValue(s.bidEstimate) ??
    numericValue(s.ddEstimate)
  );
}

function dealAmountFromSnapshot(newSnapshot: unknown, oldSnapshot: unknown): number | null {
  return snapshotBestValue(newSnapshot) ?? snapshotBestValue(oldSnapshot);
}

function formatDealLocation(loc?: { address: string | null; city: string | null; state: string | null } | null): string | null {
  if (!loc) return null;
  const cityState = [loc.city, loc.state].filter(Boolean).join(", ");
  return [loc.address, cityState].filter(Boolean).join(" · ") || null;
}

// Read a UUID-valued from/to change, resolving to display names (falling back to the raw id).
function repFromTo(changedFields: unknown, names: Map<string, string>, key: string): { from: string; to: string } | null {
  const parsed = parseJson(changedFields);
  if (!isRecord(parsed)) return null;
  const change = parsed[key];
  if (!isRecord(change)) return null;
  const from = readValue(change, ["from", "old", "previous"]);
  const to = readValue(change, ["to", "new", "current"]);
  const label = (v: unknown): string => resolveUserName(names, v) ?? (typeof v === "string" && v ? v : "—");
  return { from: label(from), to: label(to) };
}

function formatRepChange(changedFields: unknown, names: Map<string, string>): string | null {
  const parts: string[] = [];
  const rep = repFromTo(changedFields, names, "assigned_rep_id");
  if (rep) parts.push(`${rep.from} → ${rep.to}`);
  const est = repFromTo(changedFields, names, "estimator_user_id");
  if (est) parts.push(`Estimator: ${est.from} → ${est.to}`);
  return parts.length ? parts.join("; ") : null;
}

function valueFromTo(changedFields: unknown): { from: string; to: string } | null {
  const parsed = parseJson(changedFields);
  if (!isRecord(parsed)) return null;
  for (const key of ["awarded_amount", "bid_board_total_sales", "bid_estimate", "dd_estimate"]) {
    const c = parsed[key];
    if (isRecord(c)) {
      const from = numericValue(readValue(c, ["from", "old", "previous"]));
      const to = numericValue(readValue(c, ["to", "new", "current"]));
      return { from: from != null ? formatCurrency(from) : "—", to: to != null ? formatCurrency(to) : "—" };
    }
  }
  return null;
}

function auditActorName(auditReference: unknown): string | null {
  const parsed = parseJson(auditReference);
  if (!isRecord(parsed)) return null;
  return (
    normalizeText(parsed.actorName) ??
    normalizeText(parsed.actor_name) ??
    normalizeText(parsed.actorSystemProcess) ??
    null
  );
}

function buildReductionSummary(input: {
  event: WonMetricReductionEmailEvent;
  names: Map<string, string>;
  amount: number | null;
  locationText: string | null;
  actorName: string | null;
}): string | null {
  const { event, names, amount, locationText, actorName } = input;
  const name = event.dealName ?? "This deal";
  const idParts = [event.dealNumber, amount != null ? formatCurrency(amount) : null, locationText].filter(Boolean);
  const idSuffix = idParts.length ? ` (${idParts.join(" · ")})` : "";
  const by = actorName ? ` by ${actorName}` : "";
  const rep = repFromTo(event.changedFields, names, "assigned_rep_id");
  switch (event.reasonCode) {
    case "won_reassigned": {
      const fromTo = rep ? ` from ${rep.from} → ${rep.to}` : "";
      const moved = rep ? ` The Won credit moved to ${rep.to}; company Won is unchanged.` : "";
      return `Won deal ${name}${idSuffix} was reassigned${fromTo}${by}.${moved}`;
    }
    case "won_estimator_reassigned": {
      const est = repFromTo(event.changedFields, names, "estimator_user_id");
      const fromTo = est ? ` from ${est.from} → ${est.to}` : "";
      return `The estimator on Won deal ${name}${idSuffix} was reassigned${fromTo}${by}.`;
    }
    case "won_value_reduced": {
      const vc = valueFromTo(event.changedFields);
      const detail = vc ? ` from ${vc.from} to ${vc.to}` : "";
      return `The Won value of ${name}${idSuffix} was lowered${detail}${by}.`;
    }
    case "deal_deleted":
      return `Won deal ${name}${idSuffix} was deleted${by}, removing it from Won.`;
    case "archived_or_deactivated":
      return `Won deal ${name}${idSuffix} was deactivated${by}, removing it from Won.`;
    case "placed_on_hold":
      return `Won deal ${name}${idSuffix} was placed on hold${by}, removing it from the Won figure.`;
    case "marked_test_data":
      return `${name}${idSuffix} was marked as test data${by}, excluding it from Won.`;
    case "won_stage_changed":
      return `${name}${idSuffix} was moved out of a Won stage${by}.`;
    case "won_date_rebucketed":
      return `The Won close date of ${name}${idSuffix} changed${by}, moving it out of this period.`;
    default:
      return `A Won contribution from ${name}${idSuffix} was reduced${by}.`;
  }
}
```

- [ ] **Step 6: Run the builder tests to verify they pass**

Run: `npm run test -w worker -- won-metric-reduction-alert`
Expected: PASS (new `buildWonMetricReductionEmail — enrichment` tests green; all pre-existing tests still green).

- [ ] **Step 7: Commit**

```bash
git add worker/src/jobs/won-metric-reduction-alert.ts worker/tests/jobs/won-metric-reduction-alert.test.ts
git commit -m "feat(worker): enrich Won-metric email builder (names, summary, job/amount/location rows)

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 2: Email handler — resolve rep names + property location, feed the builder

**Files:**
- Modify: `worker/src/jobs/won-metric-reduction-alert.ts`
- Test: `worker/tests/jobs/won-metric-reduction-alert.test.ts`

- [ ] **Step 1: Extend the test mock, then add a handler-level reassignment assertion**

In `worker/tests/jobs/won-metric-reduction-alert.test.ts`, update the `makeQuery` `public.users` branch to serve the new batched-by-id lookup, and add a deals-location branch. Also add a `NAME_BY_ID` map + a reassignment fixture.

Add near the top (after `ADNAAN_ID`):

```ts
const REP_FROM_ID = "f5ade4ca-ee41-5188-b6d6-d58a2630e89c";
const REP_TO_ID = "e537cc4a-fc5e-46d4-901a-99a9bf5e2ec6";
const NAME_BY_ID: Record<string, string> = {
  [REP_FROM_ID]: "Chris Higingbotham",
  [REP_TO_ID]: "Caleb Stone",
};
```

Replace the `if (sql.includes("FROM public.users")) { ... }` block in `makeQuery` with:

```ts
    if (sql.includes("FROM public.users")) {
      if (sql.includes("display_name")) {
        // Batched rep-name resolution by id (WHERE id = ANY($1)).
        const ids = (params[0] as string[]) ?? [];
        const rows = ids
          .map((id) => ({ id: String(id).toLowerCase(), display_name: NAME_BY_ID[String(id).toLowerCase()] }))
          .filter((r) => r.display_name);
        return { rows };
      }
      const email = String(params[0]).toLowerCase();
      if (email === TAKASHI) return { rows: [{ id: TAKASHI_ID }] };
      if (email === ADNAAN) return { rows: [{ id: ADNAAN_ID }] };
      return { rows: [] };
    }
    if (sql.includes("FROM office_dallas.deals") && sql.includes("property_state")) {
      return { rows: [{ property_address: "50 Mount Zion Rd", property_city: "Atlanta", property_state: "GA" }] };
    }
```

Add a reassignment event fixture + test in the `handleWonMetricReductionAlert` describe block:

```ts
  it("resolves rep UUIDs to names and adds the why-summary for a reassignment event", async () => {
    const reassignEvent = {
      ...BASE_EVENT,
      action_label: "Won deal reassigned",
      reason_code: "won_reassigned",
      changed_fields: { assigned_rep_id: { from: REP_FROM_ID, to: REP_TO_ID } },
      impacts: {
        "assigned_rep.won_ytd": {
          scope: "assigned_rep",
          scopeId: REP_FROM_ID,
          metric: "won_ytd",
          countBefore: 1,
          countAfter: 0,
          countDelta: -1,
          before: 12322.86,
          after: 0,
          delta: -12322.86,
          unit: "usd",
        },
      },
      new_snapshot: { awardedAmount: 12322.86, assignedRepId: REP_TO_ID },
      old_snapshot: { awardedAmount: 12322.86, assignedRepId: REP_FROM_ID },
      deal_name: "Terraces at Highbury Court",
      deal_number: "DFW-4-16326-af",
      report_metric_key: "assigned_rep.won_ytd",
    };
    const { query } = makeQuery({ event: reassignEvent });
    const sendEmail = vi.fn().mockResolvedValue({ success: true, messageId: "resend-1" });

    await handleWonMetricReductionAlert({ eventId: EVENT_ID }, null, { query, sendEmail, env: ENV, logger: silent });

    const html = sendEmail.mock.calls[0][2] as string;
    expect(html).toContain("Chris Higingbotham");
    expect(html).toContain("Caleb Stone");
    expect(html).not.toContain(REP_FROM_ID);
    expect(html).not.toContain(REP_TO_ID);
    expect(html).toContain("Atlanta, GA");
    expect(html).toContain("reassigned");
  });
```

- [ ] **Step 2: Run to verify the new handler test fails**

Run: `npm run test -w worker -- won-metric-reduction-alert`
Expected: FAIL — the handler does not yet resolve names/location or pass them to the builder (UUIDs still present in html).

- [ ] **Step 3: Add the two async resolvers**

Add to `worker/src/jobs/won-metric-reduction-alert.ts` (near `resolveOfficeId`):

```ts
async function resolveReductionUserNames(query: PgQuery, event: WonMetricReductionEvent): Promise<Map<string, string>> {
  const ids = new Set<string>();
  const add = (v: unknown) => {
    if (typeof v === "string" && UUID_RE.test(v.trim())) ids.add(v.trim().toLowerCase());
  };
  const changed = parseJson(event.changedFields);
  if (isRecord(changed)) {
    for (const change of Object.values(changed)) {
      if (isRecord(change)) {
        add(change.from);
        add(change.to);
      }
    }
  }
  for (const snap of [event.oldSnapshot, event.newSnapshot]) {
    const s = parseJson(snap);
    if (isRecord(s)) {
      add(s.assignedRepId);
      add(s.estimatorUserId);
    }
  }
  if (ids.size === 0) return new Map();
  const result = await query(
    `SELECT id::text AS id, display_name FROM public.users WHERE id = ANY($1::uuid[])`,
    [[...ids]],
  );
  const map = new Map<string, string>();
  for (const row of result.rows) {
    const id = normalizeUuid(row.id);
    const name = normalizeText(row.display_name);
    if (id && name) map.set(id, name);
  }
  return map;
}

async function resolveDealLocation(
  query: PgQuery,
  tenantSchema: string,
  dealId: string | null,
): Promise<{ address: string | null; city: string | null; state: string | null } | null> {
  if (!dealId || !isSafeTenantSchema(tenantSchema)) return null;
  const result = await query(
    `SELECT property_address, property_city, property_state FROM ${tenantSchema}.deals WHERE id = $1::uuid LIMIT 1`,
    [dealId],
  );
  const row = result.rows[0];
  if (!row) return null;
  return {
    address: normalizeText(row.property_address),
    city: normalizeText(row.property_city),
    state: normalizeText(row.property_state),
  };
}
```

- [ ] **Step 4: Wire the resolvers into the handler**

In `handleWonMetricReductionAlert`, after the `officeId` resolution (the `const officeId = await resolveOfficeId(...)` block) and before `const email = buildWonMetricReductionEmail({`, add:

```ts
  const userNames = await resolveReductionUserNames(query, eventForDelivery).catch((error) => {
    logger.warn("[WonMetricReductionAlert] Could not resolve rep names; sending with raw ids", { eventId: event.id, error });
    return new Map<string, string>();
  });
  const dealLocation = await resolveDealLocation(query, eventForDelivery.tenantSchema, eventForDelivery.dealId).catch((error) => {
    logger.warn("[WonMetricReductionAlert] Could not resolve deal location; sending without it", { eventId: event.id, error });
    return null;
  });
```

Then pass them into the builder call:

```ts
  const email = buildWonMetricReductionEmail({
    event: eventForDelivery,
    impact,
    officeId,
    frontendUrl: resolveFrontendUrl(env),
    userNames,
    dealLocation,
  });
```

- [ ] **Step 5: Run the worker tests to verify all pass**

Run: `npm run test -w worker -- won-metric-reduction-alert`
Expected: PASS — reassignment test green, and every pre-existing handler/receipt test still green.

- [ ] **Step 6: Typecheck the worker**

Run: `npm run typecheck:tests -w worker`
Expected: no type errors.

- [ ] **Step 7: Commit**

```bash
git add worker/src/jobs/won-metric-reduction-alert.ts worker/tests/jobs/won-metric-reduction-alert.test.ts
git commit -m "feat(worker): resolve rep names + property location for Won-metric email

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 3: Search backend — rep name + best-value amount on deal results

**Files:**
- Modify: `server/src/modules/search/service.ts` (`SearchResult` interface + `searchDeals`)
- Modify: `server/tests/modules/search/soft-deleted-won-search.runtime.test.ts` (extend deals DDL)
- Test (create): `server/tests/modules/search/deal-enrichment-search.runtime.test.ts`

- [ ] **Step 1: Extend the existing search runtime test's deals DDL (keeps it green after the SELECT change)**

In `server/tests/modules/search/soft-deleted-won-search.runtime.test.ts`, the `deals` `CREATE TABLE` lacks the value columns that `searchDeals` will now SELECT. Add them. Change the `stage_id uuid, updated_at timestamptz DEFAULT now()` tail of the deals table to:

```sql
      on_hold boolean DEFAULT false, is_change_order boolean DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, stage_id uuid,
      awarded_amount numeric(14,2), bid_estimate numeric(14,2), dd_estimate numeric(14,2),
      updated_at timestamptz DEFAULT now()
```

(Keep everything else identical. The `users` table already exists in this harness.)

- [ ] **Step 2: Write the failing enrichment runtime test**

Create `server/tests/modules/search/deal-enrichment-search.runtime.test.ts`:

```ts
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { searchDeals } from "../../../src/modules/search/service.js";

/**
 * REAL-SQL (PGlite) proof that searchDeals returns the assigned rep's display name and the
 * best-value deal amount (awarded -> bid -> dd), and degrades cleanly when rep/values are null.
 */

const U = (s: string) => `00000000-0000-0000-0000-${s.padStart(12, "0")}`;
const ST = { opp: U("57a1") };
const REP = U("re01");
const D = { withRep: U("d01"), noRep: U("d02"), bidOnly: U("d03") };

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let tdb: any;
let pg: PGlite;

beforeAll(async () => {
  pg = new PGlite();
  await pg.exec(`SET TimeZone='UTC';`);
  await pg.exec(`
    CREATE TABLE pipeline_stage_config (id uuid PRIMARY KEY, slug text);
    CREATE TABLE companies (id uuid PRIMARY KEY, name text);
    CREATE TABLE contacts (id uuid PRIMARY KEY, first_name text, last_name text);
    CREATE TABLE users (id uuid PRIMARY KEY, display_name text);
    CREATE TABLE deals (
      id uuid PRIMARY KEY, sales_source_user_id uuid, name text, deal_number text, project_number text, description text,
      property_address text, property_city text, property_state text, bid_board_customer_name text,
      company_id uuid, primary_contact_id uuid, assigned_rep_id uuid,
      on_hold boolean DEFAULT false, is_change_order boolean DEFAULT false,
      is_active boolean NOT NULL DEFAULT true, stage_id uuid,
      awarded_amount numeric(14,2), bid_estimate numeric(14,2), dd_estimate numeric(14,2),
      updated_at timestamptz DEFAULT now()
    );

    INSERT INTO pipeline_stage_config (id, slug) VALUES ('${ST.opp}','opportunity');
    INSERT INTO users (id, display_name) VALUES ('${REP}','Caleb Stone');

    INSERT INTO deals (id, name, stage_id, is_active, assigned_rep_id, awarded_amount, bid_estimate, dd_estimate) VALUES
      ('${D.withRep}', 'Zephyr Awarded',  '${ST.opp}', true, '${REP}', 12322.86, 12322.86, 12155.00),
      ('${D.noRep}',   'Zephyr No Rep',   '${ST.opp}', true, NULL,      50000.00, NULL,     NULL),
      ('${D.bidOnly}', 'Zephyr Bid Only', '${ST.opp}', true, '${REP}',  NULL,      7500.00, 7000.00);
  `);
  tdb = drizzle(pg);
}, 30000);

afterAll(async () => {
  await pg?.close?.();
});

describe("searchDeals — rep name + best-value amount enrichment", () => {
  it("returns the assigned rep name and awarded>bid>dd best value; null-safe", async () => {
    const results = await searchDeals(tdb, "Zephyr", 50);
    const byId = new Map(results.map((r) => [r.id, r]));

    const awarded = byId.get(D.withRep)!;
    expect(awarded.assignedRepName).toBe("Caleb Stone");
    expect(Number(awarded.dealValue)).toBe(12322.86); // awarded wins

    const noRep = byId.get(D.noRep)!;
    expect(noRep.assignedRepName ?? null).toBeNull();
    expect(Number(noRep.dealValue)).toBe(50000); // awarded present, rep null

    const bidOnly = byId.get(D.bidOnly)!;
    expect(bidOnly.assignedRepName).toBe("Caleb Stone");
    expect(Number(bidOnly.dealValue)).toBe(7500); // falls through to bid_estimate
  });
});
```

- [ ] **Step 3: Run to verify it fails**

Run: `npm run test -w server -- deal-enrichment-search`
Expected: FAIL — `assignedRepName`/`dealValue` are `undefined` (searchDeals doesn't select them yet).

- [ ] **Step 4: Add the fields to the server `SearchResult` interface**

In `server/src/modules/search/service.ts`, add to the `SearchResult` interface (after `isChangeOrder?: boolean;`):

```ts
  // Assigned rep display name + best-value deal amount (awarded>bid>dd, raw string). Deal results only.
  assignedRepName?: string | null;
  dealValue?: string | null;
```

- [ ] **Step 5: Add the join, value columns, and mapping in `searchDeals`**

In `searchDeals`, add the value columns + rep name to the `.select({...})` (after `stageSlug: pipelineStageConfig.slug,`):

```ts
      assignedRepName: users.displayName,
      awardedAmount: deals.awardedAmount,
      bidEstimate: deals.bidEstimate,
      ddEstimate: deals.ddEstimate,
```

Add the LEFT JOIN right after the existing `pipelineStageConfig` join:

```ts
    .leftJoin(pipelineStageConfig, eq(pipelineStageConfig.id, deals.stageId))
    .leftJoin(users, eq(users.id, deals.assignedRepId))
```

Update the `.map(...)` return object (add two fields to the mapped `SearchResult`):

```ts
  return rows.map((r): SearchResult => ({
    entityType: "deal",
    id: r.id,
    primaryLabel: r.name ?? "Unnamed Deal",
    secondaryLabel: pickDealSecondaryLabel(r.projectNumber, r.dealNumber),
    tertiaryLabel: [r.propertyCity, r.propertyState].filter(Boolean).join(", ") || undefined,
    status: deriveDealStatus(r.stageSlug, r.onHold),
    deepLink: `/deals/${r.id}`,
    rank: Number(r.relevance ?? 0),
    isChangeOrder: r.isChangeOrder === true,
    assignedRepName: r.assignedRepName ?? null,
    dealValue: firstNonEmpty(r.awardedAmount, r.bidEstimate, r.ddEstimate),
  }));
```

Add the helper below `pickDealSecondaryLabel`:

```ts
// Best-value amount for a deal search result: awarded_amount > bid_estimate > dd_estimate.
// numeric(14,2) columns arrive as strings from pg; return the first present as a raw string, else null.
function firstNonEmpty(...values: Array<string | number | null>): string | null {
  for (const v of values) {
    if (v != null && String(v).trim() !== "") return String(v);
  }
  return null;
}
```

`users` is already imported at the top of `service.ts` (line 5). No new import needed.

- [ ] **Step 6: Run the enrichment test + the existing search runtime test**

Run: `npm run test -w server -- soft-deleted-won-search deal-enrichment-search`
Expected: PASS — both runtime tests green (the DDL change keeps the soft-deleted test working).

- [ ] **Step 7: Run the mock-based search tests (regression)**

Run: `npm run test -w server -- modules/search`
Expected: PASS — `service.test.ts` / `global-search.test.ts` unaffected (their chainable mock already stubs `leftJoin`; unmapped fixture rows yield `assignedRepName: null`, `dealValue: null`).

- [ ] **Step 8: Commit**

```bash
git add server/src/modules/search/service.ts server/tests/modules/search/soft-deleted-won-search.runtime.test.ts server/tests/modules/search/deal-enrichment-search.runtime.test.ts
git commit -m "feat(search): return assigned rep name + best-value amount on deal results

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 4: Command palette — amount right-aligned, rep on the meta sub-line

**Files:**
- Modify: `client/src/hooks/use-search.ts` (`SearchResult` type)
- Modify: `client/src/components/search/command-palette.tsx` (`ResultItem`)
- Test: `client/src/components/search/command-palette.test.tsx`

- [ ] **Step 1: Write the failing render test**

Add to `client/src/components/search/command-palette.test.tsx` (inside the existing `describe`):

```ts
  it("renders a deal's amount (right-aligned, compact) and the rep name on the meta line", () => {
    const results = {
      ...fullResults(),
      deals: [
        r("deal", "d1", "Terraces at Highbury Court", "/deals/d1", {
          status: "won",
          secondaryLabel: "DFW-4-16326-af",
          tertiaryLabel: "Atlanta, GA",
          assignedRepName: "Caleb Stone",
          dealValue: "12322.86",
        }),
      ],
    };
    setSearchState({ results, loading: false });
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Caleb Stone");
    expect(text).toContain("$12.3K"); // formatCurrencyCompact(12322.86)
    expect(text).toContain("DFW-4-16326-af");
    expect(text).toContain("Atlanta, GA");
  });
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w client -- command-palette`
Expected: FAIL — rep name/amount not rendered.

- [ ] **Step 3: Add the optional fields to the client `SearchResult` type**

In `client/src/hooks/use-search.ts`, add to the `SearchResult` interface (after `rank: number;`):

```ts
  assignedRepName?: string | null;
  dealValue?: string | null;
```

- [ ] **Step 4: Update `ResultItem` to render rep + amount**

In `client/src/components/search/command-palette.tsx`, add the import at the top:

```ts
import { formatCurrencyCompact } from "@/lib/deal-utils";
```

Replace the `ResultItem` body (the `<div className="flex-1 min-w-0">…</div>` sub-line block and add the amount span before the status badge). Replace from `<div className="flex-1 min-w-0">` through the closing of that div, then insert the amount span:

```tsx
      <div className="flex-1 min-w-0">
        <div className="font-medium text-sm text-gray-900 truncate">
          {result.primaryLabel}
        </div>
        {(() => {
          const meta = [result.secondaryLabel, result.tertiaryLabel, result.assignedRepName].filter(Boolean);
          return meta.length > 0 ? (
            <div className="text-xs text-gray-500 truncate">{meta.join(" · ")}</div>
          ) : null;
        })()}
      </div>
      {result.dealValue != null && result.dealValue !== "" ? (
        <span className="text-xs font-medium text-gray-700 flex-shrink-0 tabular-nums">
          {formatCurrencyCompact(result.dealValue)}
        </span>
      ) : null}
```

(The existing status badge and entity badge blocks that follow are unchanged.)

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test -w client -- command-palette`
Expected: PASS — new render test green, existing palette tests still green.

- [ ] **Step 6: Commit**

```bash
git add client/src/hooks/use-search.ts client/src/components/search/command-palette.tsx client/src/components/search/command-palette.test.tsx
git commit -m "feat(search): show deal amount + rep name in the command palette

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 5: Full search page — same rep + amount rendering

**Files:**
- Modify: `client/src/pages/search/search-page.tsx` (`ResultCard`)
- Test: `client/src/pages/search/search-page.test.tsx`

- [ ] **Step 1: Write the failing render test**

Open `client/src/pages/search/search-page.test.tsx` and confirm how it builds result fixtures (it mocks `useSearch`). Add a test that a deal result renders the rep name + compact amount. Add this test inside the existing top-level `describe`:

```ts
  it("shows deal amount + rep name on a deal result card", () => {
    setSearchState({
      results: {
        deals: [
          {
            entityType: "deal",
            id: "d1",
            primaryLabel: "Terraces at Highbury Court",
            secondaryLabel: "DFW-4-16326-af",
            tertiaryLabel: "Atlanta, GA",
            status: "won",
            deepLink: "/deals/d1",
            rank: 1,
            assignedRepName: "Caleb Stone",
            dealValue: "12322.86",
          },
        ],
        companies: [], contacts: [], leads: [], properties: [], files: [],
        total: 1, query: "terraces",
      },
      loading: false,
    });
    render();
    const text = container!.textContent ?? "";
    expect(text).toContain("Caleb Stone");
    expect(text).toContain("$12.3K");
  });
```

Note: match the existing `search-page.test.tsx` helpers (`setSearchState`/`render`/`container`). If the file uses different helper names, adapt this test to them — read the file first and reuse its exact scaffolding (mock of `@/hooks/use-search`, jsdom env, MemoryRouter).

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test -w client -- search-page`
Expected: FAIL — rep/amount not rendered.

- [ ] **Step 3: Update `ResultCard` in `search-page.tsx`**

Add the import at the top of `client/src/pages/search/search-page.tsx`:

```ts
import { formatCurrencyCompact } from "@/lib/deal-utils";
```

Replace the `ResultCard` inner block (the `<div className="flex-1 min-w-0">…</div>` plus an amount span before the status badge):

```tsx
      <div className="flex-1 min-w-0">
        <div className="font-medium text-gray-900 truncate">{result.primaryLabel}</div>
        {(() => {
          const meta = [result.secondaryLabel, result.tertiaryLabel, result.assignedRepName].filter(Boolean);
          return meta.length > 0 ? (
            <div className="text-sm text-gray-500 truncate">{meta.join(" · ")}</div>
          ) : null;
        })()}
      </div>
      {result.dealValue != null && result.dealValue !== "" ? (
        <span className="text-sm font-medium text-gray-700 flex-shrink-0 tabular-nums">
          {formatCurrencyCompact(result.dealValue)}
        </span>
      ) : null}
```

(The status/entity `<Badge>` blocks that follow stay unchanged.)

- [ ] **Step 4: Run to verify it passes**

Run: `npm run test -w client -- search-page`
Expected: PASS — new test green, existing search-page tests still green.

- [ ] **Step 5: Commit**

```bash
git add client/src/pages/search/search-page.tsx client/src/pages/search/search-page.test.tsx
git commit -m "feat(search): show deal amount + rep name on the full search page

Co-Authored-By: Claude Opus 4.8 (1M context) <noreply@anthropic.com>"
```

---

## Task 6: Full verification

**Files:** none (verification only).

- [ ] **Step 1: Typecheck all touched workspaces**

Run:
```bash
npm run typecheck:tests -w worker
npm run typecheck:tests -w server
npm run typecheck:tests -w client
```
Expected: no type errors in any workspace.

- [ ] **Step 2: Run the full test suites for touched workspaces**

Run:
```bash
npm run test -w worker
npm run test -w server
npm run test -w client
```
Expected: all green. If the client full run is heavy, at minimum run `command-palette`, `search-page`, and `use-search` filters plus `test:ci`.

- [ ] **Step 3: Run CI-shaped configs where present**

Run:
```bash
npm run test:ci -w server
npm run test:ci -w client
```
Expected: green (these are the gates the PR must pass).

- [ ] **Step 4: Confirm no stray console/debug and the diff is clean**

Run: `git status && git diff --stat main...HEAD`
Expected: only the intended files changed; commit history shows the 5 feature commits + the spec/plan docs.

---

## Self-review notes (author)

- **Spec coverage:** email names→resolution (T1/T2), summary line (T1), Job/Amount/Location/Sales-rep rows (T1), non-fatal DB lookups (T2), search rep+value backend (T3), types (T3/T4), right-aligned amount + rep sub-line in palette (T4) and full page (T5), on-hold not zeroed (T3 mapping shows raw value). All covered.
- **Type consistency:** `assignedRepName?: string | null` and `dealValue?: string | null` are identical in the server interface (T3), the client interface (T4), and every render/test usage. Builder inputs `userNames`/`dealLocation` match between the pure tests (T1) and the handler call (T2).
- **Cross-test dependency:** T3 Step 1 extends the existing `soft-deleted-won-search.runtime.test.ts` DDL BEFORE the SELECT change so it can't regress. Mock-based search tests already stub `.leftJoin`.
- **No placeholders:** every code step has literal code; every run step has an exact command + expected outcome.
