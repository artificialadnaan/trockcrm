import { describe, expect, it } from "vitest";
import {
  decideHeartbeat,
  renderDeadLetterEmail,
  renderHeartbeatEmail,
  type DeadLetterRow,
} from "../../src/scripts/bid-board-sync-heartbeat.js";

const MIN = 60_000;
const NOW = new Date("2026-06-18T22:00:00Z");
const T = (msAgo: number) => new Date(NOW.getTime() - msAgo);

describe("decideHeartbeat — silence/recovery decision (pure)", () => {
  const base = { now: NOW, thresholdMinutes: 60, realertMinutes: 60 };

  it("healthy: a recent success within the threshold → no action, state ok", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: T(20 * MIN), priorState: "ok", lastAlertedAt: null });
    expect(d.stalled).toBe(false);
    expect(d.action).toBe("none");
    expect(d.nextState).toBe("ok");
  });

  // THE INCIDENT: failed runs roll back and leave NO row, so the only signal is an old last-success.
  // Absence-of-success (not a recorded failure) must trip the alert. This is what would have caught the
  // 24h outage.
  it("stalled: last success older than the threshold → alert_stalled even with no recorded failure", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: T(25 * 60 * MIN), priorState: "ok", lastAlertedAt: null });
    expect(d.stalled).toBe(true);
    expect(d.action).toBe("alert_stalled");
    expect(d.nextState).toBe("stalled");
    expect(d.minutesSinceSuccess).toBe(25 * 60);
  });

  it("stalled: no successful run has EVER been recorded (null) → alert_stalled", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: null, priorState: null, lastAlertedAt: null });
    expect(d.stalled).toBe(true);
    expect(d.action).toBe("alert_stalled");
    expect(d.minutesSinceSuccess).toBeNull();
  });

  it("throttle: already stalled and within the re-alert window → no repeat email", () => {
    const d = decideHeartbeat({
      ...base,
      lastSuccessAt: T(25 * 60 * MIN),
      priorState: "stalled",
      lastAlertedAt: T(10 * MIN), // alerted 10 min ago, re-alert window is 60 min
    });
    expect(d.stalled).toBe(true);
    expect(d.action).toBe("none");
    expect(d.nextState).toBe("stalled");
  });

  it("throttle: already stalled but past the re-alert window → re-alert", () => {
    const d = decideHeartbeat({
      ...base,
      lastSuccessAt: T(25 * 60 * MIN),
      priorState: "stalled",
      lastAlertedAt: T(90 * MIN), // 90 > 60 → due for a re-alert
    });
    expect(d.action).toBe("alert_stalled");
  });

  it("recovery: was stalled, now a fresh success within threshold → alert_recovered, state ok", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: T(5 * MIN), priorState: "stalled", lastAlertedAt: T(30 * MIN) });
    expect(d.stalled).toBe(false);
    expect(d.action).toBe("alert_recovered");
    expect(d.nextState).toBe("ok");
  });

  it("first run, healthy: no prior state and a recent success → no spurious alert", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: T(5 * MIN), priorState: null, lastAlertedAt: null });
    expect(d.action).toBe("none");
    expect(d.nextState).toBe("ok");
  });

  it("threshold boundary is exclusive: exactly at the threshold is still healthy", () => {
    const d = decideHeartbeat({ ...base, lastSuccessAt: T(60 * MIN), priorState: "ok", lastAlertedAt: null });
    expect(d.stalled).toBe(false);
  });
});

describe("renderHeartbeatEmail (pure)", () => {
  it("stalled email names the office, the last-success timestamp and the gap", () => {
    const { subject, html } = renderHeartbeatEmail({
      kind: "stalled",
      office: "dallas",
      lastSuccessAt: new Date("2026-06-17T21:00:00Z"),
      minutesSinceSuccess: 25 * 60,
      thresholdMinutes: 60,
    });
    expect(subject.toLowerCase()).toContain("dallas");
    expect(subject.toLowerCase()).toMatch(/stall|silent|down/);
    expect(html).toContain("2026-06-17T21:00:00.000Z");
  });

  it("stalled email handles the never-succeeded case (null last success)", () => {
    const { html } = renderHeartbeatEmail({
      kind: "stalled",
      office: "dallas",
      lastSuccessAt: null,
      minutesSinceSuccess: null,
      thresholdMinutes: 60,
    });
    expect(html.toLowerCase()).toContain("never");
  });

  it("recovered email names the office and the recovery timestamp", () => {
    const { subject, html } = renderHeartbeatEmail({
      kind: "recovered",
      office: "dallas",
      lastSuccessAt: new Date("2026-06-18T21:55:00Z"),
      minutesSinceSuccess: 5,
      thresholdMinutes: 60,
    });
    expect(subject.toLowerCase()).toMatch(/recover|resumed|back/);
    expect(html).toContain("2026-06-18T21:55:00.000Z");
  });
});

describe("renderDeadLetterEmail (pure)", () => {
  const row = (i: number): DeadLetterRow => ({
    id: `id-${i}`,
    sourceFilename: `File-${i}.xlsx`,
    lastError: `err-${i}`,
    idempotencyKey: `hash-${i}`,
    finishedAt: new Date("2026-07-22T03:00:00.000Z"),
  });

  it("renders a batch: pluralized subject, each file/error/key, and finished timestamp", () => {
    const { subject, html } = renderDeadLetterEmail({ office: "dallas", rows: [row(1), row(2)], now: NOW });
    expect(subject).toContain("DEAD-LETTERED");
    expect(subject).toContain("2 failed imports");
    expect(html).toContain("File-1.xlsx");
    expect(html).toContain("err-2");
    expect(html).toContain("hash-1");
    expect(html).toContain("2026-07-22T03:00:00.000Z");
  });

  it("states the CORRECT recovery: a same-payload re-POST is a no-op; needs a fresh payload / requeue", () => {
    const { html } = renderDeadLetterEmail({ office: "dallas", rows: [row(1)], now: NOW });
    // The old copy said "re-trigger the push", which hits ON CONFLICT DO NOTHING and enqueues nothing.
    expect(html).not.toMatch(/re-trigger the push/i);
    expect(html.toLowerCase()).toContain("no-op");
    expect(html.toLowerCase()).toMatch(/fresh scrape|new idempotency key|requeue/);
  });

  it("uses the singular for one failure", () => {
    const { subject } = renderDeadLetterEmail({ office: "dallas", rows: [row(1)], now: NOW });
    expect(subject).toMatch(/1 failed import\b/);
    expect(subject).not.toContain("imports");
  });

  it("caps the emailed list at 20 and notes how many more", () => {
    const rows = Array.from({ length: 26 }, (_, i) => row(i));
    const { subject, html } = renderDeadLetterEmail({ office: "dallas", rows, now: NOW });
    expect(subject).toContain("26 failed imports"); // subject reflects the TRUE count
    expect(html).toContain("File-19.xlsx"); // the 20th shown (0-indexed)
    expect(html).not.toContain("File-20.xlsx"); // capped
    expect(html).toContain("and 6 more");
  });
});
