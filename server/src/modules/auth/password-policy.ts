import { AppError } from "../../middleware/error-handler.js";

/**
 * The password policy, deliberately in its own module with no database imports.
 *
 * It used to live inside local-auth-service.ts. That module pulls in the Drizzle client, so any suite
 * that wanted the real policy had to `vi.importActual` a DB-importing module -- and because several
 * suites mock local-auth-service with a plain factory, whichever mock registered first in a worker
 * silently won and the policy came back undefined. That surfaced only in the full `test:ci` run, never
 * in a single-file run. A pure function with no dependencies cannot be shadowed that way.
 *
 * 12 characters, above the NIST SP 800-63B minimum of 8. No composition rules and no forced rotation --
 * both are discouraged by SP 800-63B.
 */
export const PASSWORD_MIN_LENGTH = 12;

// Matches the field flow's PASSWORD_RESET_MAX_LENGTH. Without a ceiling, scrypt runs over whatever
// arrives inside the 10 MB body limit; the omission here was an inconsistency rather than a decision.
export const PASSWORD_MAX_LENGTH = 256;

export function validatePasswordPolicy(password: string) {
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw new AppError(400, `Password must be at least ${PASSWORD_MIN_LENGTH} characters`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw new AppError(400, `Password must be at most ${PASSWORD_MAX_LENGTH} characters`);
  }
}
