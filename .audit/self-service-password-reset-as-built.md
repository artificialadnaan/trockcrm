# Self-service password reset — as-built spec

Supersedes the design half of `.audit/self-service-password-reset-handoff.md` for anything that
disagrees. That document was written before implementation; this one records what actually shipped,
including five places where following the plan verbatim would have produced a broken or dead feature.

**Branch:** `feat/self-service-password-reset`

---

## 1. Problem

The login screen's "Forgot password?" was a `mailto:aiqbal@trockgc.com`. Every forgotten password was a
manual admin action, and resending an invite was the working remedy — which is also why it masked a
separate lockout bug for so long.

## 2. Decisions

| Question | Decision | Why |
|---|---|---|
| Mechanism | Single-use emailed link | An unauthenticated endpoint that emails a working password immediately invalidates the real one, making it an **anonymous lockout button** against anyone whose address you know. A link leaves the existing password valid until someone with mailbox access opens it. |
| Link TTL | **60 minutes** | Field uses 30. Longer on purpose: a link that expires while someone walks away sends them back to emailing an admin, which is the problem being solved. The token is single-use and 256-bit, so the TTL bounds blast radius rather than doing the security work. |
| Reset link origin | **`https://trockcrm.com`** | The branded domain, the API container that serves the SPA, and the origin whose breakage was reported as a live outage in #1077 — direct evidence real people work there. Same-origin with the API, so the reset page needs no CORS and no cross-site cookie on a security-critical flow. |
| Eligibility | Active + invited + enabled + **not revoked** | Revocation must not be undoable by self-serve reset. |
| Auto-login on completion | **No** | Do not mint a session directly from an email link. |

## 3. Security design

**Token.** 32 bytes from `crypto.randomBytes` (256 bits), base64url. SHA-256 at rest. Deliberately not a
password KDF: the input is already uniform random so there is no dictionary to attack, and a slow KDF on
an unauthenticated lookup path is a DoS lever. `token_hash` is `UNIQUE`; the raw token is never logged,
never stored, and never placed in audit metadata.

**Token placement — fragment, not query string.** `https://trockcrm.com/reset-password#token=<...>`.
The fragment is never transmitted to the server, keeping the token out of proxy/access logs, out of
`Referer`, and out of error reporting that captures request URLs. The SPA reads `location.hash`,
immediately calls `history.replaceState` to strip it, and POSTs it in a body.

**Single-use is atomic.** Consumption is one `UPDATE ... RETURNING`. `used_at IS NULL` is evaluated under
the row lock the UPDATE itself takes, so two concurrent requests carrying the same token cannot both
succeed. A `SELECT`-then-`UPDATE` races even inside a transaction at READ COMMITTED. Expiry is enforced
**here**; the `validate` pre-check is UX only and carries no security weight. Covered by an actual
concurrency test, not a comment.

**Session invalidation.** Completion bumps `users.token_version`, killing every existing session. This is
the single most important control: the primary reason to reset is suspected compromise, and a reset that
leaves the attacker's 30-day session alive accomplishes nothing.

**Lockout cleared on completion.** Someone who forgot their password has usually just burned
`MAX_FAILED_LOGIN_ATTEMPTS` and is inside the 15-minute lockout; without clearing it they reset
successfully, still cannot log in, and contact the admin anyway. This does mean mailbox access clears a
lockout — correct, because the lockout defends against online guessing, not against someone who controls
the account's email.

**Anti-enumeration.** `request` returns an identical status, body and byte-for-byte payload for unknown,
inactive, never-invited, revoked, disabled, rate-limited and successful alike. Timing is equalised
structurally: the handler resolves eligibility, responds, and only then sends mail, so the one
variable-cost step happens after response time is already fixed. Service errors are swallowed to a
generic 200 — otherwise a database blip that only errors for rows that exist becomes the same oracle.

**Rate limiting, two layers.**

| Layer | Limit | Defends against |
|---|---|---|
| Per-IP | existing `authLimiter` | broad scanning from one host |
| Per-account | 3 per 15 min, counted from persisted rows | mailbox flooding from rotating IPs |

The per-account count includes **used and invalidated** rows; counting only live ones would let someone
refill the quota by burning each link as it arrived. Counted from rows, not memory, so it holds across
replicas and restarts. When it trips the response is still the generic 200.

**Email.** Both messages pass `suppressGlobalBcc: true` and `requireConfiguredTransport: true`.
`SYSTEM_EMAIL_BCC` is live on the API and BCCs every system email — without suppression, every reset link
in the company would land in a personal inbox. A separate "your password was changed" notice makes an
unauthorized reset visible rather than silent; it carries no token and no action link.

## 4. Endpoints

| Route | Auth | Request | Response |
|---|---|---|---|
| `POST /api/auth/password-reset/request` | none | `{ email }` | always `200 { ok: true }` |
| `POST /api/auth/password-reset/validate` | none | `{ token }` | `200 { valid: boolean }` |
| `POST /api/auth/password-reset/complete` | none | `{ token, password }` | `200 { ok: true }` / generic `400` |

All three are POST (keeping the token out of the request line and therefore out of access logs), all
three sit under `authLimiter`, and all three are in `isPublicAuthCsrfExempt` — the CSRF gate engages
whenever an unsafe request arrives with a `token` cookie, and this flow's audience is precisely someone
holding a stale cookie who cannot sign in.

`complete` returns one generic message for invalid/expired/used/invalidated, but deliberately does **not**
flatten a password-policy rejection into it: the link was fine, only the password was too short, and
saying "your link is dead" would send the user back for an email they do not need.

---

## 5. Five corrections to the original plan

These are the places where implementing the plan as written would have shipped a defect.

1. **Migration number.** The plan said `0190`. The tree was already at `0225`. Shipped as `0226`.

2. **The token-helper move was a runtime break.** The plan said to replace the helpers in
   `field-users/service.ts` with `export { generateResetToken as generateInviteToken } from "..."`.
   A bare re-export creates **no local binding**, and that module calls both helpers internally — so it
   typechecks cleanly and then throws `hashInviteToken is not defined` on every field invite and every
   field login. Caught by running the field suites; 26 tests failed. Shipped as `import` + `export const`.

3. **The `dbClient` shim did not bind parameters.** The plan's
   `db.execute(sql.raw(text, params))` does not substitute `$n` placeholders, so every raw-SQL helper
   would have received unbound placeholders in production while passing under PGlite in tests. Backed by
   the shared `pg` pool instead, so production runs the same parameterised statements the tests exercise.

4. **`resetUrl` threw when its env var was unset.** Combined with "respond 200 before sending mail", an
   unset `PASSWORD_RESET_BASE_URL` would mean every user sees "check your email" and no email is ever
   sent, with only a log line to show for it. Now hard-defaults to `https://trockcrm.com`, matching the
   durable-backstop shape `resolveFrontendBaseUrl` already uses, and ignores blank / relative / malformed
   overrides.

5. **The tokenized-path matcher needed whole-segment matching.** A naive `startsWith("/p")` also matches
   `/properties` and `/pipeline` — two of the highest-write pages in the CRM — and putting `no-referrer`
   on those documents reintroduces #1077. Matching is `pathname === base || pathname.startsWith(base + "/")`,
   and the negative cases were mutation-tested to prove they are not vacuous.

Two further notes:

- **`recordLocalAuthEvent`'s event union** was hand-maintained and had already drifted
  (`password_change_forced` was legal in the database but a type error at the call site). It is now
  derived from the Drizzle enum. The guard test's `Record<...>` annotation looks like a compile-time
  check but is **not** one — neither `tsconfig.json` nor `tsconfig.typecheck.json` typechecks
  `server/tests`. The runtime assertion is the real guard; both facts were verified by mutation.

- **The canonical server typecheck is `npm run typecheck --workspace server`**
  (`tsconfig.typecheck.json`, `rootDir: ".."`). Running `tsc -p server/tsconfig.json` directly reports
  two spurious `TS6059` errors that do not exist under the real config.

---

## 6. Out of scope, still open

1. **scrypt cost.** `hashPassword` runs at Node's default N=2^14; current OWASP guidance is N=2^17.
   Raising it needs a rehash-on-successful-login path and a `maxmem` bump.
2. **Derek Barr's lockout** — whether `failed_login_attempts` resets on a *successful* login. Memory
   `adam-shaw-lockout-diagnosis` records this exact bug as a previous root cause, so it may be the same
   defect hitting a second person.
3. **`crm.trockconstruction.com`** is still in `CORS_ALLOWED_ORIGINS`, `RAILWAY_SERVICE_FRONTEND_URL` and
   the client's `FRONTEND_API_FALLBACK_HOSTS` despite having no DNS.

## 7. Deploy checklist

- [ ] `PASSWORD_RESET_BASE_URL` on the **API** service — optional. Unset defaults to
      `https://trockcrm.com`, which is the intended value, so this is only needed if that ever changes.
- [ ] Migration `0226` runs automatically on API deploy (the worker does not run migrations).
- [ ] After deploy, confirm the header split:
      `curl -sSI https://trockcrm.com/` → `strict-origin-when-cross-origin`
      `curl -sSI https://trockcrm.com/reset-password` → `no-referrer`
- [ ] End-to-end with a real account: request a link, confirm it does **not** appear in the
      `SYSTEM_EMAIL_BCC` inbox, use it once, confirm reuse fails, and confirm a pre-existing session in
      another browser is signed out.
