// The scorecard submit's `clientSubmissionId` must be a real UUID — the server parser rejects anything
// else (assertValidUuid). No expo-crypto/uuid dep is bundled, so generate an RFC-4122 v4 here. Math.random
// is acceptable for an idempotency key (needs uniqueness + UUID shape, not cryptographic strength).
export function newSubmissionId(): string {
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === "x" ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
