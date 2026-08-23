import request from "supertest";
import { describe, expect, it, vi } from "vitest";

// THE ONE AUTHENTICATED ROUTE IN THIS APP THAT SPENDS MONEY PER CALL.
//
// `/api/field/weekly-reports/dictation` reaches Anthropic with `claude-opus-5` on every request, and every
// field account in the company can authenticate against the surface it is mounted on. The per-call cost was
// already bounded — 4k-char transcript in, section ceiling out — but nothing bounded calls per ACTOR, so a
// stuck retry loop in the app or one stolen field token could spend without limit, and the first sign of it
// would have been an invoice.
//
// WHAT THESE ASSERT, and why each matters:
//   * the limiter fires at all — a middleware that is mounted but never reached is the usual way this goes
//     wrong, since it sits behind an auth guard that could just as easily short-circuit first;
//   * the bucket is PER USER — the sizing argument only holds if one runaway cannot exhaust the crew's
//     budget, and a crew on one jobsite shares a cellular NAT, so an IP key would do exactly that;
//   * the limit is not so tight that a real session trips it.
//
// The model call itself is stubbed away. This is about the guard, not the pass — the pass has its own suite.

const dictationMock = vi.fn(async () => ({ text: "- did the thing", source: "local" as const }));

vi.mock("../../../src/modules/weekly-reports/dictation-service.js", () => ({
  formatWeeklyReportDictation: dictationMock,
  MAX_DICTATION_TRANSCRIPT_CHARS: 20000,
}));

// Two distinct field identities, switched per request by a header the fake auth reads. Real
// `requireFieldContractor` is replaced wholesale: what is under test is the limiter's key, not the guard.
vi.mock("../../../src/middleware/field-auth.js", () => ({
  requireFieldContractor: (req: any, _res: any, next: () => void) => {
    req.fieldUser = { id: req.headers["x-test-user"] ?? "field-user-1", role: "construction" };
    next();
  },
}));

vi.mock("../../../src/middleware/tenant.js", () => ({
  tenantMiddleware: (req: any, _res: any, next: () => void) => {
    req.tenantClient = { query: async () => ({ rows: [], rowCount: 0 }) };
    req.commitTransaction = async () => {};
    next();
  },
}));

const { weeklyReportFieldRoutes } = await import("../../../src/modules/weekly-reports/field-routes.js");
const express = (await import("express")).default;
const { weeklyReportDictationDailyLimiter, weeklyReportDictationLimiter } = await import(
  "../../../src/middleware/rate-limit.js"
);

function app() {
  const a = express();
  a.use(express.json());
  a.use("/api/field/weekly-reports", weeklyReportFieldRoutes);
  return a;
}

async function dictate(a: ReturnType<typeof app>, user: string) {
  return request(a)
    .post("/api/field/weekly-reports/dictation")
    .set("x-test-user", user)
    .send({ transcript: "we poured the slab", existingChars: 0 });
}

describe("the dictation endpoint is rate limited per field user", () => {
  it("serves an ordinary dictation without complaint", async () => {
    // The control. Every assertion below is about a REFUSAL, and a route that 500'd on the first call
    // would satisfy all of them for the wrong reason.
    const a = app();
    const response = await dictate(a, "solo-user");
    expect(response.status).toBe(200);
    expect(response.body.text).toBe("- did the thing");
  });

  it("refuses once one user has burned through the window", async () => {
    // 30/min. Driven past it in a loop rather than asserting the constant, because the number is not the
    // property worth pinning — that a runaway is STOPPED is.
    const a = app();
    let refused = 0;
    let served = 0;
    for (let i = 0; i < 40; i += 1) {
      const response = await dictate(a, "loop-user");
      if (response.status === 429) refused += 1;
      else served += 1;
    }
    expect(served).toBeGreaterThan(0);
    expect(refused).toBeGreaterThan(0);
  });

  it("does NOT spend one user's budget on another — the crew shares a NAT, not a bucket", async () => {
    // THE ASSERTION THE SIZING ARGUMENT RESTS ON. Every other limiter in this codebase keys by IP, which
    // is right for the unauthenticated surfaces they protect and wrong here: a crew on one jobsite comes
    // from one cellular address, so an IP bucket would let one superintendent's stuck retry loop cut off
    // everybody standing next to them. Supertest sends every request from the same address, so if the key
    // were the IP this test fails.
    const a = app();
    for (let i = 0; i < 40; i += 1) await dictate(a, "greedy-user");

    const neighbour = await dictate(a, "innocent-user");
    expect(neighbour.status).toBe(200);
  });

  it("leaves room for a real session before it ever fires", async () => {
    // The recorder stops itself at 60 seconds, so a person cannot physically produce more than roughly one
    // transcript a minute per section. Ten in a window is already an implausibly frantic session; it must
    // not trip. Without this the limit could be tightened to something that fires on ordinary use and
    // every other test here would still pass.
    const a = app();
    for (let i = 0; i < 10; i += 1) {
      expect((await dictate(a, "busy-user")).status).toBe(200);
    }
  });
});

// THE DAILY CAP, EXERCISED DIRECTLY.
//
// It cannot be driven through the route: the burst limiter sits in front of it and refuses at 30/min, so
// 200 is unreachable inside one window. That ORDER is deliberate and correct — the daily bucket only
// counts requests that got past the burst gate, which is to say requests that could actually have cost
// money — but it does mean the only honest way to exercise the day is to mount the middleware alone.
//
// Why the cap exists at all: a 60-second window replenishes. A loop pacing itself at one call every two
// seconds never trips 30/min and still runs ~43,200 requests a day, up to twice that in model attempts. A
// limiter that bounds the SHAPE of a runaway and not its total is the kind that gets trusted for more than
// it does.
describe("the daily dictation cap", () => {
  function dailyApp() {
    const a = express();
    a.use(express.json());
    a.post(
      "/dictation",
      (req: any, _res: any, next: () => void) => {
        req.fieldUser = { id: req.headers["x-test-user"] ?? "daily-user" };
        next();
      },
      weeklyReportDictationDailyLimiter,
      (_req: any, res: any) => res.json({ ok: true }),
    );
    return a;
  }

  const call = (a: ReturnType<typeof dailyApp>, user: string) =>
    request(a).post("/dictation").set("x-test-user", user).send({});

  it("stops a user once the day's allowance is gone", async () => {
    const a = dailyApp();
    let refused = 0;
    for (let i = 0; i < 230; i += 1) {
      if ((await call(a, "all-day")).status === 429) refused += 1;
    }
    expect(refused).toBeGreaterThan(0);
  });

  it("does not spend one user's day on another", async () => {
    // Asserted separately from the burst bucket because the two limiters each have a key generator to get
    // wrong. They share one helper precisely so they cannot disagree about whose spend they count — this
    // is what fails if that is ever split apart.
    const a = dailyApp();
    for (let i = 0; i < 230; i += 1) await call(a, "day-hog");
    expect((await call(a, "day-bystander")).status).toBe(200);
  });

  it("is actually MOUNTED on the dictation route, not merely exported", async () => {
    // The gap this closes was found by mutation: removing the daily limiter from the route left every
    // test above green, because they mount the middleware directly to get past the burst gate. A guard
    // that cannot fail is the failure mode this codebase has shipped before, so the mounting is asserted
    // structurally — read off the router's own stack rather than inferred from behaviour.
    //
    // Both limiters are checked, and the ORDER is checked with them: burst must run first so the daily
    // bucket only counts requests that got past it, i.e. requests that could actually have spent money.
    // Reversed, a fast loop would burn its whole day on calls the burst gate already refused.
    const layer = (weeklyReportFieldRoutes as any).stack.find(
      (l: any) => l.route?.path === "/dictation",
    );
    expect(layer).toBeDefined();
    // By IDENTITY, not by name: express stores the handler itself, and `express-rate-limit` returns an
    // ANONYMOUS function — every limiter in this file reports `name === ""`, so a name check would have
    // matched all of them or none, which is exactly the kind of assertion that looks precise and proves
    // nothing.
    const handlers = layer.route.stack.map((h: any) => h.handle);
    const burst = handlers.indexOf(weeklyReportDictationLimiter);
    const daily = handlers.indexOf(weeklyReportDictationDailyLimiter);
    expect(burst).toBeGreaterThanOrEqual(0);
    expect(daily).toBeGreaterThanOrEqual(0);
    expect(burst).toBeLessThan(daily);
  });

  it("leaves an implausibly heavy real day well clear of the cap", async () => {
    // A PM covering several jobsites, re-recording freely, is in the low tens of dictations a day. Fifty
    // must not trip, or the cap fires on work rather than on abuse.
    const a = dailyApp();
    for (let i = 0; i < 50; i += 1) {
      expect((await call(a, "heavy-but-real")).status).toBe(200);
    }
  });
});
