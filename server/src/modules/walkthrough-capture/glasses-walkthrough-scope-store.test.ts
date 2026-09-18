// The PRODUCTION TROCK Scope reader, against a stubbed `fetch`.
//
// Everything that touches TROCK_SCOPE_SERVICE_TOKEN lives in the module under test, so this suite is where
// the two rules that cannot be checked anywhere else are pinned: the credential goes out as a bearer header
// and appears in NOTHING this module throws, and the 404/everything-else split that the panel's `missing`
// vs `unavailable` states are built on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createGlassesWalkthroughScopeReader } from "./glasses-walkthrough-scope-store.js";

const SCOPE_ID = "b91a5bfd-1111-4222-8333-444455556666";
/** A distinctive stand-in for the real secret — never the real one — so a leak is unmistakable in an
 *  assertion. Same convention the worker's forward suite uses. */
const TOKEN = "test-scope-token-DO-NOT-LEAK-8f21";

const originalFetch = globalThis.fetch;
const originalBaseUrl = process.env.TROCK_SCOPE_BASE_URL;
const originalToken = process.env.TROCK_SCOPE_SERVICE_TOKEN;

function stubFetch(impl: (url: string, init: RequestInit) => Promise<Response>) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const fetchImpl = vi.fn(async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return impl(url, init);
  });
  globalThis.fetch = fetchImpl as unknown as typeof fetch;
  return { calls };
}

beforeEach(() => {
  process.env.TROCK_SCOPE_BASE_URL = "https://scope.example.com/";
  process.env.TROCK_SCOPE_SERVICE_TOKEN = TOKEN;
});

afterEach(() => {
  globalThis.fetch = originalFetch;
  if (originalBaseUrl === undefined) delete process.env.TROCK_SCOPE_BASE_URL;
  else process.env.TROCK_SCOPE_BASE_URL = originalBaseUrl;
  if (originalToken === undefined) delete process.env.TROCK_SCOPE_SERVICE_TOKEN;
  else process.env.TROCK_SCOPE_SERVICE_TOKEN = originalToken;
});

describe("createGlassesWalkthroughScopeReader — the request it makes", () => {
  it("GETs TROCK Scope's scope-items route with the service token as a bearer credential", async () => {
    const { calls } = stubFetch(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal);

    // The trailing slash on the configured base URL is stripped, so the path is not doubled — the same
    // normalisation the worker's client does.
    expect(calls[0]!.url).toBe(`https://scope.example.com/api/walkthroughs/${SCOPE_ID}/scope-items`);
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).authorization).toBe(`Bearer ${TOKEN}`);
  });

  it("passes the caller's abort signal down, so the deadline ends the REQUEST and not just the wait", async () => {
    const controller = new AbortController();
    const { calls } = stubFetch(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    await createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, controller.signal);
    expect(calls[0]!.init.signal).toBe(controller.signal);
  });

  it("reads process.env per call, so a variable set after import is picked up", async () => {
    // A module-level snapshot would bake in whatever the environment looked like at import time — the same
    // reason `createGlassesWalkthroughArtifactStore` evaluates `isR2Configured()` per call.
    const reader = createGlassesWalkthroughScopeReader();
    delete process.env.TROCK_SCOPE_BASE_URL;
    expect(reader.isConfigured()).toBe(false);

    process.env.TROCK_SCOPE_BASE_URL = "https://scope.example.com";
    expect(reader.isConfigured()).toBe(true);
  });
});

describe("createGlassesWalkthroughScopeReader — 404 is the ONLY negative claim", () => {
  it('answers `missing` for a 404', async () => {
    stubFetch(async () => new Response(JSON.stringify({ error: "walkthrough_not_found" }), { status: 404 }));

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).resolves.toEqual({ outcome: "missing" });
  });

  it.each([500, 502, 503, 504])("THROWS on a %i, which the panel renders as unavailable", async (status) => {
    stubFetch(async () => new Response("upstream boom", { status }));

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).rejects.toThrow(String(status));
  });

  it.each([401, 403])("THROWS on a %i rather than reporting the walkthrough as missing", async (status) => {
    // TODAY'S REAL CASE, and the reason this distinction is not academic: `GET /walkthroughs/:id/scope-items`
    // is not in TROCK Scope's SERVICE_ALLOWED_ROUTES allowlist, so the CRM's service token is refused there.
    // Reported as `missing`, every walk on every deal page would claim TROCK Scope had never heard of it.
    stubFetch(async () => new Response(JSON.stringify({ error: "forbidden" }), { status }));

    const reader = createGlassesWalkthroughScopeReader();
    await expect(reader.fetchScopeItems(SCOPE_ID, new AbortController().signal)).rejects.toThrow(String(status));
    await expect(reader.fetchScopeItems(SCOPE_ID, new AbortController().signal)).rejects.not.toThrow(/missing/i);
  });

  it("THROWS when the connection never comes up at all", async () => {
    const cause = Object.assign(new Error("connect ECONNREFUSED 10.0.0.1:443"), { code: "ECONNREFUSED" });
    stubFetch(async () => {
      throw Object.assign(new TypeError("fetch failed"), { cause });
    });

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).rejects.toThrow(/did not answer/);
  });
});

describe("createGlassesWalkthroughScopeReader — a 200 is not automatically an answer", () => {
  it("returns the items array on a well-formed 200", async () => {
    stubFetch(
      async () =>
        new Response(JSON.stringify({ items: [{ id: "item-1", description: "Paint wall red" }] }), { status: 200 }),
    );

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).resolves.toEqual({
      outcome: "found",
      items: [{ id: "item-1", description: "Paint wall red" }],
      // A non-empty scope is finished by construction — there are rows, so consolidation ran. The
      // walkthrough is not re-fetched for it, which is why this reader makes one request here.
      pipeline: "finished",
    });
  });

  it("passes TROCK Scope's `pipeline` health object through UNREAD", async () => {
    // Deliberately not validated here. `toPanelPipelineHealth` (the scope service) is the single place
    // that decides what a usable health object looks like; a second opinion in this module would give the
    // panel two chances to disagree with itself about the same bytes. So this asserts transport, and the
    // scope-service suite asserts judgement.
    stubFetch(
      async () =>
        new Response(
          JSON.stringify({
            items: [{ id: "item-1", description: "Paint wall red" }],
            pipeline: { state: "stale", stage: null, reason: "media replaced", since: "2026-09-02T10:00:00.000Z" },
          }),
          { status: 200 },
        ),
    );

    const answer = await createGlassesWalkthroughScopeReader().fetchScopeItems(
      SCOPE_ID,
      new AbortController().signal,
    );

    expect(answer).toMatchObject({
      pipelineHealth: { state: "stale", reason: "media replaced", since: "2026-09-02T10:00:00.000Z" },
    });
  });

  it("REGRESSION: THROWS on a 200 with no `items` array, instead of reporting an empty scope", async () => {
    // Coercing an unrecognised body to `[]` would render as "this walk produced no line items" — a claim
    // about the estimator's site visit rather than about our failure to read the answer, and unfalsifiable
    // from the panel. That is the one failure here that is silent, so it is the one that must not be.
    stubFetch(async () => new Response(JSON.stringify({ data: { items: [] } }), { status: 200 }));

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).rejects.toThrow(/items/);
  });

  it("THROWS on a 200 whose body is not JSON at all (a proxy's HTML error page)", async () => {
    stubFetch(async () => new Response("<html>502 Bad Gateway</html>", { status: 200 }));

    await expect(
      createGlassesWalkthroughScopeReader().fetchScopeItems(SCOPE_ID, new AbortController().signal),
    ).rejects.toThrow(/not JSON/);
  });
});

describe("createGlassesWalkthroughScopeReader — the token never leaves this module", () => {
  it("REGRESSION: no thrown message on ANY failure path contains the service token", async () => {
    // The credential is on the outbound request and must be on nothing else. `fetch` rejections in
    // particular hold a reference to the request — and therefore to the Authorization header — which is why
    // this module drops the original rather than re-throwing it or hanging it off `cause`.
    const paths: Array<() => Promise<Response>> = [
      async () => new Response("boom", { status: 500 }),
      async () => new Response("<html/>", { status: 200 }),
      async () => new Response(JSON.stringify({ nope: true }), { status: 200 }),
      async () => {
        throw Object.assign(new TypeError("fetch failed"), {
          // A rejection carrying the credential, which is exactly what must not be re-surfaced.
          cause: new Error(`request failed with authorization: Bearer ${TOKEN}`),
        });
      },
    ];

    for (const impl of paths) {
      stubFetch(impl);
      const error = await createGlassesWalkthroughScopeReader()
        .fetchScopeItems(SCOPE_ID, new AbortController().signal)
        .then(() => null)
        .catch((err: unknown) => err as Error);

      expect(error).toBeInstanceOf(Error);
      const serialized = `${error!.message}|${String((error as { cause?: unknown }).cause ?? "")}|${error!.stack ?? ""}`;
      expect(serialized).not.toContain(TOKEN);
    }
  });

  it("refuses to send an EMPTY bearer credential when the variable is unset", async () => {
    // `Authorization: Bearer ` is a credential TROCK Scope has to make a decision about — its own
    // `tokensMatch` refuses an empty string precisely so an unset variable cannot authenticate the
    // internet. Not sending it at all is this side of that agreement.
    delete process.env.TROCK_SCOPE_SERVICE_TOKEN;
    const { calls } = stubFetch(async () => new Response(JSON.stringify({ items: [] }), { status: 200 }));

    const reader = createGlassesWalkthroughScopeReader();
    expect(reader.isConfigured()).toBe(false);
    await expect(reader.fetchScopeItems(SCOPE_ID, new AbortController().signal)).rejects.toThrow(/not configured/);
    expect(calls).toHaveLength(0);
  });

  it("treats a whitespace-only variable as unset, not as a credential", async () => {
    process.env.TROCK_SCOPE_SERVICE_TOKEN = "   ";
    expect(createGlassesWalkthroughScopeReader().isConfigured()).toBe(false);
  });
});
