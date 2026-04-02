import { ConfidentialClientApplication, type Configuration } from "@azure/msal-node";
import { upsertGraphTokens, getGraphTokens, markReauthNeeded } from "./graph-token-service.js";

const GRAPH_SCOPES = [
  "Mail.Read",
  "Mail.Send",
  "Mail.ReadWrite",
  "User.Read",
  "offline_access",
];

function getMsalConfig(): Configuration {
  const clientId = process.env.AZURE_CLIENT_ID;
  const clientSecret = process.env.AZURE_CLIENT_SECRET;
  const tenantId = process.env.AZURE_TENANT_ID || "common";

  if (!clientId || !clientSecret) {
    throw new Error("AZURE_CLIENT_ID and AZURE_CLIENT_SECRET must be set for Graph auth");
  }

  return {
    auth: {
      clientId,
      clientSecret,
      authority: `https://login.microsoftonline.com/${tenantId}`,
    },
  };
}

let msalInstance: ConfidentialClientApplication | null = null;

function getMsalClient(): ConfidentialClientApplication {
  if (!msalInstance) {
    msalInstance = new ConfidentialClientApplication(getMsalConfig());
  }
  return msalInstance;
}

/**
 * Generate the Microsoft OAuth consent URL for a user.
 */
export function getConsentUrl(redirectUri: string, state?: string): string {
  const clientId = process.env.AZURE_CLIENT_ID;
  const tenantId = process.env.AZURE_TENANT_ID || "common";

  if (!clientId) {
    throw new Error("AZURE_CLIENT_ID must be set");
  }

  const params = new URLSearchParams({
    client_id: clientId,
    response_type: "code",
    redirect_uri: redirectUri,
    response_mode: "query",
    scope: GRAPH_SCOPES.join(" "),
    prompt: "consent",
  });
  if (state) params.set("state", state);

  return `https://login.microsoftonline.com/${tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
}

/**
 * Exchange an authorization code for tokens and store them encrypted.
 */
export async function exchangeCodeForTokens(
  userId: string,
  code: string,
  redirectUri: string
): Promise<void> {
  const client = getMsalClient();

  const result = await client.acquireTokenByCode({
    code,
    scopes: GRAPH_SCOPES,
    redirectUri,
  });

  if (!result?.accessToken) {
    throw new Error("Failed to acquire tokens from Microsoft");
  }

  const expiresAt = result.expiresOn ?? new Date(Date.now() + 3600 * 1000);

  // Use MSAL's token cache to persist the full cache (includes refresh token).
  // MSAL doesn't directly expose refresh tokens from acquireTokenByCode;
  // the intended pattern is to serialize the cache and use acquireTokenSilent for refresh.
  const serializedCache = client.getTokenCache().serialize();

  await upsertGraphTokens(userId, {
    accessToken: result.accessToken,
    refreshToken: serializedCache, // Store the full serialized MSAL cache (encrypted at rest)
    expiresAt,
    scopes: GRAPH_SCOPES,
  });

  console.log(`[GraphAuth] Tokens stored for user ${userId}`);
}

/**
 * Refresh an expired access token using the stored refresh token.
 * Returns the new access token, or null if refresh fails (triggers reauth).
 */
export async function refreshAccessToken(userId: string): Promise<string | null> {
  const stored = await getGraphTokens(userId);
  if (!stored) {
    console.error(`[GraphAuth] No tokens found for user ${userId}`);
    return null;
  }

  try {
    const client = getMsalClient();

    // Deserialize the stored MSAL cache (stored.refreshToken holds the serialized cache)
    client.getTokenCache().deserialize(stored.refreshToken);

    // Get the cached account to use with acquireTokenSilent
    const accounts = await client.getTokenCache().getAllAccounts();
    if (accounts.length === 0) {
      await markReauthNeeded(userId, "No cached MSAL account found — reauth required");
      return null;
    }

    // acquireTokenSilent handles refresh token exchange internally via MSAL's cache
    const result = await client.acquireTokenSilent({
      account: accounts[0],
      scopes: GRAPH_SCOPES,
    });

    if (!result?.accessToken) {
      await markReauthNeeded(userId, "Token refresh returned empty response");
      return null;
    }

    const expiresAt = result.expiresOn ?? new Date(Date.now() + 3600 * 1000);

    // Re-serialize the updated cache (may contain a new refresh token)
    const serializedCache = client.getTokenCache().serialize();

    await upsertGraphTokens(userId, {
      accessToken: result.accessToken,
      refreshToken: serializedCache,
      expiresAt,
      scopes: GRAPH_SCOPES,
    });

    return result.accessToken;
  } catch (err: any) {
    console.error(`[GraphAuth] Token refresh failed for user ${userId}:`, err.message);
    await markReauthNeeded(userId, `Refresh failed: ${err.message}`);
    return null;
  }
}

/**
 * Get a valid access token for a user. Refreshes if expired.
 * Returns null if the user needs to reauthorize.
 */
export async function getValidAccessToken(userId: string): Promise<string | null> {
  const stored = await getGraphTokens(userId);
  if (!stored) return null;
  if (stored.status === "reauth_needed" || stored.status === "revoked") return null;

  // If token expires within 5 minutes, refresh proactively
  const bufferMs = 5 * 60 * 1000;
  if (stored.expiresAt.getTime() - Date.now() < bufferMs) {
    return refreshAccessToken(userId);
  }

  return stored.accessToken;
}

/**
 * Check if Graph auth is available (AZURE_CLIENT_ID is set).
 * In dev mode without Azure credentials, email features return mock data.
 */
export function isGraphAuthConfigured(): boolean {
  return !!process.env.AZURE_CLIENT_ID && !!process.env.AZURE_CLIENT_SECRET;
}
