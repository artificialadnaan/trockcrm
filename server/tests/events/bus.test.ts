import { describe, it, expect, vi } from "vitest";
import { EventEmitter } from "events";
import { DOMAIN_EVENTS, type DomainEvent } from "../../src/events/types.js";

describe("EventBus", () => {
  it("should emit and receive local events", () => {
    const bus = new EventEmitter();
    const handler = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_WON, handler);

    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_WON,
      payload: { dealId: "123", dealName: "Test Deal" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date(),
    };

    bus.emit(event.name, event);

    expect(handler).toHaveBeenCalledOnce();
    expect(handler).toHaveBeenCalledWith(event);
  });

  it("should support multiple listeners for the same event", () => {
    const bus = new EventEmitter();
    const handler1 = vi.fn();
    const handler2 = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_STAGE_CHANGED, handler1);
    bus.on(DOMAIN_EVENTS.DEAL_STAGE_CHANGED, handler2);

    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_STAGE_CHANGED,
      payload: { dealId: "123" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date(),
    };

    bus.emit(event.name, event);

    expect(handler1).toHaveBeenCalledOnce();
    expect(handler2).toHaveBeenCalledOnce();
  });

  it("should not cross-fire between different event types", () => {
    const bus = new EventEmitter();
    const wonHandler = vi.fn();
    const lostHandler = vi.fn();

    bus.on(DOMAIN_EVENTS.DEAL_WON, wonHandler);
    bus.on(DOMAIN_EVENTS.DEAL_LOST, lostHandler);

    bus.emit(DOMAIN_EVENTS.DEAL_WON, { name: DOMAIN_EVENTS.DEAL_WON });

    expect(wonHandler).toHaveBeenCalledOnce();
    expect(lostHandler).not.toHaveBeenCalled();
  });

  it("should serialize DomainEvent timestamp to ISO string for PG NOTIFY payload", () => {
    const event: DomainEvent = {
      name: DOMAIN_EVENTS.DEAL_WON,
      payload: { dealId: "123" },
      officeId: "office-1",
      userId: "user-1",
      timestamp: new Date("2026-04-01T12:00:00Z"),
    };

    // Simulate what emitRemote does
    const serialized = JSON.stringify({
      ...event,
      timestamp: event.timestamp.toISOString(),
    });
    const parsed = JSON.parse(serialized);

    // timestamp becomes a string after JSON serialization
    expect(typeof parsed.timestamp).toBe("string");
    expect(parsed.timestamp).toBe("2026-04-01T12:00:00.000Z");

    // Worker must parse it back to Date
    const restored = new Date(parsed.timestamp);
    expect(restored.getTime()).toBe(event.timestamp.getTime());
  });
});
