import { describe, expect, it } from "vitest";
import {
  WEEKLY_REPORT_DELIVERY_TAG,
  parseWeeklyReportDeliveryEvent,
  weeklyReportBounceClass,
  weeklyReportDeliveryFailed,
  weeklyReportDeliveryLabel,
  weeklyReportDeliverySupersedes,
} from "./weeklyReportDelivery.js";

// The two rules the delivery webhook turns on, tested with no database and no HTTP in the way:
// what a provider payload MEANS, and which of two verdicts wins.
//
// EVERY TIMESTAMP HERE IS ABSOLUTE. Nothing is computed from `Date.now()` or from the module under test —
// an ordering rule tested with fixtures derived from itself agrees with itself no matter what it does, and
// this repo has shipped exactly that mistake before. The three instants below are chosen once and reused:
//
//   T1 < T2 < T3, all real ISO instants, all on the same afternoon.

const T1 = "2026-08-13T21:00:00.000Z";
const T2 = "2026-08-13T21:04:00.000Z";
const T3 = "2026-08-13T21:09:00.000Z";
const KEY = "9f2a1c44-3f6b-4a2f-9d55-6e7c8b9a0d12";

/**
 * `tags` is typed as an open record rather than inferred: the computed key would otherwise make it a
 * literal type with that one property REQUIRED, and the cases below that clear or replace the tag — which
 * are the whole point of those tests — would not compile.
 */
interface ProviderEvent {
  type: string;
  created_at?: string;
  data: {
    email_id: string;
    from: string;
    to: string[];
    subject: string;
    created_at: string;
    tags: Record<string, string>;
    [key: string]: unknown;
  };
}

function event(type: string, createdAt: string, extra: Record<string, unknown> = {}): ProviderEvent {
  return {
    type,
    created_at: createdAt,
    data: {
      email_id: "e1f2a3b4-0000-4000-8000-000000000001",
      from: "crm@trockconstruction.com",
      to: ["jay@client-example.com"],
      subject: "Weekly Progress Report",
      created_at: "2026-08-13T20:59:00.000Z",
      tags: { [WEEKLY_REPORT_DELIVERY_TAG]: KEY },
      ...extra,
    },
  };
}

describe("reading a provider delivery event", () => {
  it("takes the ENVELOPE's created_at, not the email's", () => {
    // The two are different facts and the payload carries both: `data.created_at` is when the EMAIL was
    // created and is identical on every event about it, so ordering on it would make a delivery and the
    // bounce that followed it indistinguishable. The fixture above deliberately sets them apart.
    const parsed = parseWeeklyReportDeliveryEvent(event("email.delivered", T2));
    expect(parsed?.occurredAt).toBe(T2);
  });

  it("reads the delivery key off the message's own tag", () => {
    const parsed = parseWeeklyReportDeliveryEvent(event("email.delivered", T1));
    expect(parsed?.deliveryKey).toBe(KEY);
    expect(parsed?.status).toBe("delivered");
  });

  it("classifies a permanent bounce as hard and a transient one as soft", () => {
    const hard = parseWeeklyReportDeliveryEvent(
      event("email.bounced", T2, {
        bounce: { type: "Permanent", subType: "NoEmail", message: "550 5.1.1 user unknown" },
      }),
    );
    expect(hard?.status).toBe("bounced");
    expect(hard?.detail.bounceClass).toBe("hard");
    expect(hard?.detail.bounceSubType).toBe("NoEmail");
    expect(hard?.detail.message).toBe("550 5.1.1 user unknown");

    const soft = parseWeeklyReportDeliveryEvent(
      event("email.bounced", T2, { bounce: { type: "Transient", subType: "MailboxFull", message: "full" } }),
    );
    expect(soft?.detail.bounceClass).toBe("soft");
  });

  it("does not guess at a bounce the provider would not classify", () => {
    // `Undetermined` is the provider saying it does not know. Reading it as "soft" tells a PM the address
    // is merely busy and to wait, which is the one wrong answer that produces no further signal.
    expect(weeklyReportBounceClass("Undetermined")).toBe("unknown");
    expect(weeklyReportBounceClass(undefined)).toBe("unknown");
    expect(weeklyReportBounceClass("PERMANENT")).toBe("hard");
  });

  it("records a complaint and a provider-side failure", () => {
    expect(parseWeeklyReportDeliveryEvent(event("email.complained", T3))?.status).toBe("complained");
    expect(
      parseWeeklyReportDeliveryEvent(event("email.failed", T3, { failed: { reason: "no route" } }))?.status,
    ).toBe("failed");
    expect(
      parseWeeklyReportDeliveryEvent(
        event("email.suppressed", T3, { suppressed: { type: "bounce", message: "on the list" } }),
      )?.detail.message,
    ).toBe("on the list");
  });

  it("ignores an event with no weekly-report tag", () => {
    // The provider webhook is configured per ACCOUNT, so every system email this company sends arrives
    // here. A scorecard notification is the ORDINARY case, not an error.
    const untagged = event("email.bounced", T2);
    untagged.data.tags = {};
    expect(parseWeeklyReportDeliveryEvent(untagged)).toBeNull();
  });

  it("ignores a tag that is not a uuid", () => {
    // The value is about to be bound as a uuid. Refusing here keeps a malformed tag from reaching the
    // database as a 22P02 on a public endpoint.
    const bad = event("email.bounced", T2);
    bad.data.tags = { [WEEKLY_REPORT_DELIVERY_TAG]: "not-a-key" };
    expect(parseWeeklyReportDeliveryEvent(bad)).toBeNull();
  });

  it("ignores event types this platform takes no position on", () => {
    // `email.sent` is the one worth stating: it means the provider accepted the API call, which is exactly
    // what `send_delivered_at` already recorded when the worker made it. Storing it again would let a late
    // `email.sent` outrank a real verdict on timestamp.
    for (const type of ["email.sent", "email.opened", "email.clicked", "contact.created"]) {
      expect(parseWeeklyReportDeliveryEvent(event(type, T2)), type).toBeNull();
    }
  });

  it("DROPS an event with no usable timestamp rather than dating it on arrival", () => {
    // The single most important refusal in this file. Substituting `now` would order events by ARRIVAL,
    // and arrival order is precisely what must not decide this: a provider retrying a `delivered` can land
    // it after the `bounced` that superseded it, and both stamped "now" resolve backwards.
    const missing = event("email.delivered", T2);
    delete missing.created_at;
    expect(parseWeeklyReportDeliveryEvent(missing)).toBeNull();
    expect(parseWeeklyReportDeliveryEvent(event("email.delivered", "not a date"))).toBeNull();
  });

  it("ignores junk without throwing", () => {
    for (const junk of [null, undefined, 42, "x", {}, { type: "email.delivered" }]) {
      expect(parseWeeklyReportDeliveryEvent(junk)).toBeNull();
    }
  });
});

describe("which verdict wins", () => {
  const delivered = { status: "delivered", occurredAt: T2 } as const;
  const bounced = { status: "bounced", occurredAt: T2 } as const;

  it("takes anything when the row has no verdict yet", () => {
    expect(weeklyReportDeliverySupersedes(null, delivered)).toBe(true);
    expect(weeklyReportDeliverySupersedes({ status: null, occurredAt: null }, delivered)).toBe(true);
  });

  it("lets a MORE conclusive verdict replace a weaker one, whenever it is dated", () => {
    // The provider emits one event PER RECIPIENT and tags them all identically, so the two events below
    // are two facts about ONE message and neither one's clock says anything about the other's outcome.
    // Later than the row's verdict...
    expect(
      weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T1 }, { status: "bounced", occurredAt: T2 }),
    ).toBe(true);
    // ...and EARLIER than it, which is the case pure recency got backwards: the bounce off the client's
    // address at T1 and the delivery of the bcc copy at T3 are both true, and only one of them means
    // somebody has to act.
    expect(
      weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T3 }, { status: "bounced", occurredAt: T1 }),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "delayed", occurredAt: T3 }, { status: "delivered", occurredAt: T1 }),
    ).toBe(true);
  });

  it("lets a later event of the SAME verdict refresh the row", () => {
    // The clock still decides INSIDE a verdict, and has to: it is what keeps `send_delivery_status_at`
    // and the stored detail describing the most recent event of that kind — a second recipient's bounce,
    // or the hard bounce that follows a soft one off the same message — rather than the first one seen.
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T1 }, { status: "bounced", occurredAt: T3 }),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T3 }, { status: "bounced", occurredAt: T1 }),
    ).toBe(false);
  });

  it("refuses an EARLIER event, even a `delivered` arriving after a bounce", () => {
    // The out-of-order case, stated as a rule rather than as a scenario. A late `delivered` loses to a
    // recorded bounce whatever it is dated — here, dated before it.
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T2 }, { status: "delivered", occurredAt: T1 }),
    ).toBe(false);
  });

  it("NEVER lets a later happier event clear a recorded delivery failure", () => {
    // INVERTED, and this is the assertion the whole rule turns on. It used to read "still lets a
    // genuinely later delivery clear a bounce", justified by a provider retry that finally gets through.
    // That justification does not survive contact with the payload: one send goes to up to four client
    // contacts PLUS the live SYSTEM_EMAIL_BCC, the provider emits one event per RECIPIENT and tags every
    // one of them with the same delivery key, and `data.to` cannot tell us which address an event is
    // about. So the later `delivered` is overwhelmingly the bcc copy or a second contact — not a retry —
    // and letting it win took the bounce off the board, dropped the row out of "Send failures", and filed
    // the week away as settled while the client had nothing.
    //
    // The retry story does not hold up on its own terms either. A `bounced` event is emitted when the
    // sending side has STOPPED trying: SES retries a transient failure internally and only reports the
    // bounce once it gives up, so there is no provider-side retry left to succeed afterwards.
    //
    // `complained` is the sharpest version of the same bug: a spam complaint is a human pressing a button
    // in a mail client, so it is ALWAYS dated after the bounce it would have erased.
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T1 }, { status: "delivered", occurredAt: T3 }),
    ).toBe(false);
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T1 }, { status: "delayed", occurredAt: T3 }),
    ).toBe(false);
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T1 }, { status: "complained", occurredAt: T3 }),
    ).toBe(false);
    expect(
      weeklyReportDeliverySupersedes({ status: "failed", occurredAt: T1 }, { status: "delivered", occurredAt: T3 }),
    ).toBe(false);
  });

  it("records a COMPLAINT over a delivery, and never a delivery over a complaint", () => {
    // The direction question the ratchet has to answer for the non-failure verdicts too. A complaint can
    // only follow a delivery, so it STRICTLY ADDS to what `delivered` already said — it is worth
    // recording whichever instant it carries. The reverse would erase a signal about the NEXT report the
    // moment another recipient's `delivered` landed.
    expect(
      weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T1 }, { status: "complained", occurredAt: T3 }),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T3 }, { status: "complained", occurredAt: T1 }),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "complained", occurredAt: T1 }, { status: "delivered", occurredAt: T3 }),
    ).toBe(false);
  });

  it("is idempotent: replaying the winning event changes nothing", () => {
    expect(weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T2 }, bounced)).toBe(false);
    expect(weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T2 }, delivered)).toBe(false);
  });

  it("settles two events on the SAME instant towards the more conclusive failure", () => {
    // Two events carrying the same millisecond is a shape the provider does not promise never to emit,
    // and there is no clock left to separate them. It needs no separate rule now — the precedence decides
    // it, as it decides every other cross-verdict pair — but it is asserted because the costs are
    // asymmetric and worth pinning: a wrong `bounced` is a chip somebody dismisses, a wrong `delivered`
    // is the silence this feature exists to break.
    expect(weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: T2 }, bounced)).toBe(true);
    expect(weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: T2 }, delivered)).toBe(false);
    expect(
      weeklyReportDeliverySupersedes({ status: "delayed", occurredAt: T2 }, { status: "delivered", occurredAt: T2 }),
    ).toBe(true);
  });

  it("accepts a Date on the row, which is what node-postgres returns", () => {
    // The SAME-VERDICT pair is the one that proves the coercion: a cross-verdict pair is decided by the
    // precedence and would pass with the timestamp never read at all.
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: new Date(T1) }, bounced),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: new Date(T3) }, bounced),
    ).toBe(false);
    expect(
      weeklyReportDeliverySupersedes({ status: "delivered", occurredAt: new Date(T1) }, bounced),
    ).toBe(true);
    expect(
      weeklyReportDeliverySupersedes({ status: "bounced", occurredAt: new Date(T3) }, delivered),
    ).toBe(false);
  });
});

describe("what a bounce means downstream", () => {
  it("counts bounced and failed as `the client did not get it`, and complained as not", () => {
    expect(weeklyReportDeliveryFailed("bounced")).toBe(true);
    expect(weeklyReportDeliveryFailed("failed")).toBe(true);
    // A complaint can only follow a delivery — they have the report and marked it as spam. Treating that
    // as a delivery failure would put a "not delivered" chip on a report the client demonstrably read.
    expect(weeklyReportDeliveryFailed("complained")).toBe(false);
    expect(weeklyReportDeliveryFailed("delivered")).toBe(false);
    expect(weeklyReportDeliveryFailed("delayed")).toBe(false);
    expect(weeklyReportDeliveryFailed(null)).toBe(false);
    expect(weeklyReportDeliveryFailed("anything else")).toBe(false);
  });

  it("names the bounce CLASS rather than the provider's word", () => {
    expect(weeklyReportDeliveryLabel("bounced", "hard")).toMatch(/bad address/i);
    expect(weeklyReportDeliveryLabel("bounced", "soft")).toMatch(/try again/i);
    expect(weeklyReportDeliveryLabel("bounced", "unknown")).toBe("Bounced");
    expect(weeklyReportDeliveryLabel("complained")).toMatch(/spam/i);
  });
});
