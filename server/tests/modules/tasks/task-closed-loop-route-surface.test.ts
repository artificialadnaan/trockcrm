/**
 * Pins the ORDER of the closed-loop routes on the tasks router.
 *
 * `GET /:id` at the foot of the file matches ANY single path segment, and Express takes the first
 * route that matches. `GET /awaiting-me` registered after it is never reached: the request falls into
 * the `/:id` handler, the literal string "awaiting-me" is passed to getTaskById as a task id, and
 * Postgres rejects it as malformed uuid input — so the caller gets a 500 with nothing in it that
 * points at the routing. That failure is invisible to a handler unit test, which never goes through
 * the router at all, so it is asserted here against the REAL router's registered stack.
 *
 * `/:id/comments`, `/:id/timeline` and `/:id/ack` are two-segment and cannot collide, but they are
 * pinned too: the cost is nil and the next person to reorder this file gets told.
 */
import { describe, expect, it } from "vitest";
import { taskRoutes } from "../../../src/modules/tasks/routes.js";

type Layer = { route?: { path: string; methods: Record<string, boolean> } };

const layers = ((taskRoutes as unknown as { stack: Layer[] }).stack ?? [])
  .filter((layer) => layer.route)
  .map((layer) => ({
    path: layer.route!.path,
    methods: Object.keys(layer.route!.methods).filter((m) => layer.route!.methods[m]),
  }));

function indexOf(method: string, path: string) {
  return layers.findIndex((layer) => layer.path === path && layer.methods.includes(method));
}

describe("closed-loop route surface", () => {
  it.each([
    ["get", "/awaiting-me"],
    ["get", "/:id/comments"],
    ["post", "/:id/comments"],
    ["get", "/:id/timeline"],
    ["post", "/:id/ack"],
  ])("registers %s %s", (method, path) => {
    expect(indexOf(method, path)).toBeGreaterThanOrEqual(0);
  });

  // THE ONE THAT MATTERS. A single-segment literal GET registered after the catch-all is dead code
  // that 500s in production and passes every unit test.
  it("registers GET /awaiting-me BEFORE the catch-all GET /:id", () => {
    const awaitingMe = indexOf("get", "/awaiting-me");
    const catchAll = indexOf("get", "/:id");

    expect(catchAll, "GET /:id must still exist").toBeGreaterThanOrEqual(0);
    expect(awaitingMe).toBeLessThan(catchAll);
  });

  it("keeps the pre-existing single-segment routes ahead of the catch-all too", () => {
    const catchAll = indexOf("get", "/:id");
    expect(indexOf("get", "/assignees")).toBeLessThan(catchAll);
    expect(indexOf("get", "/counts")).toBeLessThan(catchAll);
  });

  // The block is contiguous so a parallel branch adding its own routes produces one clean conflict
  // hunk rather than five interleaved ones.
  it("keeps the five closed-loop routes in one contiguous block", () => {
    const positions = [
      indexOf("get", "/awaiting-me"),
      indexOf("get", "/:id/comments"),
      indexOf("post", "/:id/comments"),
      indexOf("get", "/:id/timeline"),
      indexOf("post", "/:id/ack"),
    ].sort((a, b) => a - b);

    expect(positions[positions.length - 1] - positions[0]).toBe(positions.length - 1);
  });
});
