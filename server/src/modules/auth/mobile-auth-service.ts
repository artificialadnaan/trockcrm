import { loginWithLocalPassword } from "./local-auth-service.js";
import { signJwt } from "./service.js";

/**
 * Native CRM app (mobile-crm) session lifetime. Pinned here rather than inheriting the web default in
 * service.ts because this token is a Bearer credential living in the device keychain, not an httpOnly
 * cookie — its lifetime is its own decision. Mirrors the field app's convention. Revocation stays
 * instant regardless: authMiddleware re-reads users.is_active and the monotonic users.token_version on
 * EVERY request, so a deactivation or role change kills the session well inside this window.
 */
export const MOBILE_JWT_EXPIRES_IN = "30d";

/**
 * Log a CRM user in from the native app, returning the JWT **in the response body**.
 *
 * The web CRM's /api/auth/local/login delivers its JWT as an httpOnly cookie, which a native client
 * cannot read — that, and only that, is why this exists. Everything security-relevant is delegated to
 * the UNMODIFIED web credential path (`loginWithLocalPassword`), so bcrypt comparison, the
 * failed_login_attempts / locked_until lockout, is_enabled, invite expiry, must_change_password, and the
 * field_contractor bar are byte-identical to the web login rather than a second implementation that can
 * drift. This function adds exactly one thing: the surface:"mobile" claim.
 *
 * Errors propagate unchanged from `loginWithLocalPassword`:
 *   401 unknown email / disabled local auth / inactive user / wrong password
 *   403 field_contractor role, or a first login past invite_expires_at
 *   423 locked out (pre-existing lock, or the attempt that trips the threshold)
 *
 * `mustChangePassword` is NOT an error — it rides on `user`, and the client must route to the
 * change-password screen, because authMiddleware 403s a must-change session on every route except
 * /api/auth/me, /api/auth/logout and /api/auth/local/change-password.
 */
export async function loginMobileUser(input: { email: string; password: string }) {
  const { user, tokenVersion } = await loginWithLocalPassword(input);

  const token = signJwt(
    {
      userId: user.id,
      email: user.email,
      officeId: user.officeId,
      role: user.role,
      // Both of these are load-bearing, not cosmetic: authMiddleware treats an absent tokenVersion as 0
      // (→ immediately stale → 401) and hard-401s a token with no authMethod.
      tokenVersion,
      authMethod: "local",
      surface: "mobile",
    },
    { expiresIn: MOBILE_JWT_EXPIRES_IN },
  );

  return { token, user };
}
