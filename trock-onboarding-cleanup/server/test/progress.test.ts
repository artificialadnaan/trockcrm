import assert from "node:assert/strict";
import test from "node:test";
import { buildProgressPercent, normalizeFieldChanges } from "../src/modules/cleanup/service.js";

test("buildProgressPercent treats completed and skipped records as done", () => {
  assert.equal(buildProgressPercent(10, 6, 2), 80);
  assert.equal(buildProgressPercent(0, 0, 0), 100);
});

test("normalizeFieldChanges keeps only actual value changes", () => {
  assert.deepEqual(
    normalizeFieldChanges(
      { phone: null, email: "old@example.com", name: "Same" },
      { phone: "214-555-1234", email: "", name: "Same" },
      ["phone", "email", "name"],
    ),
    [
      { field: "phone", before: null, after: "214-555-1234" },
      { field: "email", before: "old@example.com", after: null },
    ],
  );
});
