import { expect, request as playwrightRequest } from "@playwright/test";

type DevUser = {
  email: string;
  role: string;
};

type SessionCookie = {
  name: string;
  value: string;
  domain: string;
  path: string;
  expires: number;
  httpOnly: boolean;
  secure: boolean;
  sameSite: "Strict" | "Lax" | "None";
};

export const apiBaseURL =
  process.env.PLAYWRIGHT_API_BASE_URL?.trim() ||
  process.env.API_BASE_URL?.trim() ||
  "https://api-production-ad218.up.railway.app";

const roleCookiesCache = new Map<string, SessionCookie[]>();

async function wait(ms: number) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function fetchJsonWithRetry<T>(
  request: import("@playwright/test").APIRequestContext,
  url: string,
  init?: Parameters<import("@playwright/test").APIRequestContext["fetch"]>[1]
) {
  let lastResponse: import("@playwright/test").APIResponse | null = null;

  for (let attempt = 1; attempt <= 5; attempt += 1) {
    lastResponse = await request.fetch(url, init);
    if (lastResponse.ok()) {
      return (await lastResponse.json()) as T;
    }
    if (lastResponse.status() !== 429 && lastResponse.status() < 500) {
      break;
    }
    const backoffMs = lastResponse.status() === 429 ? 1_500 * attempt : 300 * attempt;
    await wait(backoffMs);
  }

  expect(
    lastResponse?.ok(),
    `${init?.method ?? "GET"} ${url} failed with ${lastResponse?.status()}`
  ).toBeTruthy();
  return (await lastResponse!.json()) as T;
}

async function getRoleCookies(role: string) {
  let cookies = roleCookiesCache.get(role);

  if (!cookies) {
    const apiRequest = await playwrightRequest.newContext();
    const usersData = await fetchJsonWithRetry<{ users: DevUser[] }>(
      apiRequest,
      `${apiBaseURL}/api/auth/dev/users`
    );
    const selectedUser = usersData.users.find((user) => user.role === role);

    expect(selectedUser, `No dev user found for role ${role}`).toBeDefined();

    await fetchJsonWithRetry<{ user: DevUser }>(apiRequest, `${apiBaseURL}/api/auth/dev/login`, {
      method: "POST",
      data: { email: selectedUser!.email },
    });

    const storageState = await apiRequest.storageState();
    cookies = storageState.cookies as SessionCookie[];
    roleCookiesCache.set(role, cookies);
    await apiRequest.dispose();
  }

  return cookies;
}

export async function loginWithRole(page: import("@playwright/test").Page, role: string) {
  const cookies = await getRoleCookies(role);
  await page.context().addCookies(cookies);
}

export async function createRoleApiContext(role: string) {
  const cookies = await getRoleCookies(role);
  return playwrightRequest.newContext({
    baseURL: apiBaseURL,
    storageState: {
      cookies,
      origins: [],
    },
  });
}

export function createIssueCollectors(page: import("@playwright/test").Page) {
  const consoleErrors: string[] = [];
  const pageErrors: string[] = [];
  const responseErrors: string[] = [];

  page.on("console", (message) => {
    if (message.type() !== "error") return;
    consoleErrors.push(message.text());
  });

  page.on("pageerror", (error) => {
    pageErrors.push(error.message);
  });

  page.on("response", (response) => {
    if (response.status() < 400) return;
    const url = response.url();
    if (url.includes("/api/auth/me")) return;
    responseErrors.push(`${response.status()} ${response.request().method()} ${url}`);
  });

  return {
    assertClean() {
      expect(consoleErrors, `Console errors:\n${consoleErrors.join("\n")}`).toEqual([]);
      expect(pageErrors, `Page errors:\n${pageErrors.join("\n")}`).toEqual([]);
      expect(responseErrors, `Network errors:\n${responseErrors.join("\n")}`).toEqual([]);
    },
  };
}
