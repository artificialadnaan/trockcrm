import "dotenv/config";

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const HUBSPOT_BASE_URL = "https://api.hubapi.com";
const OUTPUT_DIR = "migration-snapshot";
const PAGE_SIZE = 100;
const REQUEST_TIMEOUT_MS = 30_000;

interface HubSpotPage<T> {
  results?: T[];
  paging?: { next?: { after?: string } };
}

interface HubSpotAccountDetails {
  portalId: number;
  accountType?: string;
  uiDomain?: string;
  dataHostingLocation?: string;
}

interface HubSpotOwner {
  id: string;
  email?: string;
  firstName?: string;
  lastName?: string;
  archived?: boolean;
  [key: string]: unknown;
}

function getToken() {
  const token = process.env.HUBSPOT_PRIVATE_APP_TOKEN?.trim();
  if (!token) throw new Error("HUBSPOT_PRIVATE_APP_TOKEN is required");
  return token;
}

async function hubspotFetch<T>(path: string): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${HUBSPOT_BASE_URL}${path}`, {
      headers: {
        Authorization: `Bearer ${getToken()}`,
        "Content-Type": "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`HubSpot API error ${res.status} ${path}: ${body}`);
    }
    return (await res.json()) as T;
  } finally {
    clearTimeout(timeout);
  }
}

async function fetchAllOwners(archived: boolean) {
  const owners: HubSpotOwner[] = [];
  let after: string | undefined;
  do {
    const params = new URLSearchParams({
      archived: String(archived),
      limit: String(PAGE_SIZE),
    });
    if (after) params.set("after", after);
    const page = await hubspotFetch<HubSpotPage<HubSpotOwner>>(`/crm/v3/owners?${params}`);
    owners.push(...(page.results ?? []).map((owner) => ({ ...owner, archived })));
    after = page.paging?.next?.after;
    console.log(`[hubspot:owners] fetched ${owners.length} ${archived ? "archived" : "active"} owners`);
  } while (after);
  return owners;
}

function mergeOwners(activeOwners: HubSpotOwner[], archivedOwners: HubSpotOwner[]) {
  const ownersById = new Map<string, HubSpotOwner>();
  for (const owner of activeOwners) ownersById.set(owner.id, owner);
  for (const owner of archivedOwners) ownersById.set(owner.id, owner);
  return [...ownersById.values()].sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

async function main() {
  const startedAt = new Date().toISOString();
  const account = await hubspotFetch<HubSpotAccountDetails>("/account-info/v3/details");
  if (account.accountType && account.accountType !== "STANDARD") {
    throw new Error(
      `Refusing to export non-production HubSpot account. accountType=${account.accountType} portalId=${account.portalId} uiDomain=${account.uiDomain ?? "unknown"}`
    );
  }

  await mkdir(OUTPUT_DIR, { recursive: true });
  const activeOwners = await fetchAllOwners(false);
  const archivedOwners = await fetchAllOwners(true);
  const owners = mergeOwners(activeOwners, archivedOwners);
  const output = {
    snapshotStartedAt: startedAt,
    snapshotEndedAt: new Date().toISOString(),
    source: "hubspot-rest-api",
    hubspotBaseUrl: HUBSPOT_BASE_URL,
    portalId: account.portalId,
    accountType: account.accountType,
    uiDomain: account.uiDomain,
    dataHostingLocation: account.dataHostingLocation,
    activeCount: activeOwners.length,
    archivedCount: archivedOwners.length,
    ownerCount: owners.length,
    owners,
  };

  const path = join(OUTPUT_DIR, "hubspot-owners-all.json");
  await writeFile(path, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  console.log(`[hubspot:owners] wrote ${path}`);
}

main().catch((error) => {
  console.error(error instanceof Error ? error.stack ?? error.message : String(error));
  process.exit(1);
});
