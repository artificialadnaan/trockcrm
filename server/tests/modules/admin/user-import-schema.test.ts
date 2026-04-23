import { describe, expect, it } from "vitest";
import {
  userExternalIdentities,
  userLocalAuth,
} from "../../../../shared/src/schema/index.js";

describe("user import auth schema", () => {
  it("exports external identity columns", () => {
    expect(userExternalIdentities.userId.name).toBe("user_id");
    expect(userExternalIdentities.sourceSystem.name).toBe("source_system");
    expect(userExternalIdentities.externalUserId.name).toBe("external_user_id");
  });

  it("exports local auth columns", () => {
    expect(userLocalAuth.userId.name).toBe("user_id");
    expect(userLocalAuth.passwordHash.name).toBe("password_hash");
    expect(userLocalAuth.mustChangePassword.name).toBe("must_change_password");
  });
});
