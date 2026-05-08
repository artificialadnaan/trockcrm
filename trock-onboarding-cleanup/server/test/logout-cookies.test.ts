import assert from "node:assert/strict";
import test from "node:test";
import { logoutCookieClears } from "../src/routes/auth.js";

test("logout clears shared and host-only token and csrf cookies", () => {
  const previousNodeEnv = process.env.NODE_ENV;
  process.env.NODE_ENV = "production";
  const clears = logoutCookieClears();
  process.env.NODE_ENV = previousNodeEnv;

  assert.deepEqual(
    clears.map((clear) => [clear.name, "domain" in clear.options ? clear.options.domain : null, clear.options.path, clear.options.maxAge]),
    [
      ["token", ".trockcrm.com", "/", 0],
      ["token", null, "/", 0],
      ["csrf_token", ".trockcrm.com", "/", 0],
      ["csrf_token", null, "/", 0],
    ],
  );
});
