import { and, eq } from "drizzle-orm";
import {
  offices,
  userExternalIdentities,
  users,
  type externalUserSourceEnum,
} from "@trock-crm/shared/schema";
import { db } from "../../db.js";
import { AppError } from "../../middleware/error-handler.js";
import {
  fetchAllOwners,
  type HubSpotOwner,
} from "../migration/hubspot-client.js";
import {
  listProcoreUsers,
  type ProcoreUser,
} from "../../lib/procore-client.js";

type ExternalUserSource = (typeof externalUserSourceEnum.enumValues)[number];

interface ExternalIdentityCandidate {
  sourceSystem: ExternalUserSource;
  externalUserId: string;
  externalEmail: string;
  externalDisplayName: string | null;
}

interface ExternalUserCandidate {
  email: string;
  displayName: string;
  identities: ExternalIdentityCandidate[];
}

interface ImportServiceUser {
  id: string;
  email: string;
  displayName: string;
  role: "admin" | "director" | "rep";
  officeId: string;
  isActive: boolean;
}

interface ImportServiceOffice {
  id: string;
  slug: string;
  isActive: boolean;
}

interface ImportServiceDependencies {
  getOfficeBySlug: (slug: string) => Promise<ImportServiceOffice | null>;
  getUserByEmail: (email: string) => Promise<ImportServiceUser | null>;
  createUser: (input: {
    email: string;
    displayName: string;
    officeId: string;
    role: "rep";
  }) => Promise<ImportServiceUser>;
  upsertExternalIdentity: (input: {
    userId: string;
    sourceSystem: ExternalUserSource;
    externalUserId: string;
    externalEmail: string;
    externalDisplayName: string | null;
    now: Date;
  }) => Promise<void>;
}

const defaultDependencies: ImportServiceDependencies = {
  async getOfficeBySlug(slug) {
    const normalizedSlug = slug.trim().toLowerCase();
    if (!normalizedSlug) return null;

    const [office] = await db
      .select({
        id: offices.id,
        slug: offices.slug,
        isActive: offices.isActive,
      })
      .from(offices)
      .where(eq(offices.slug, normalizedSlug))
      .limit(1);

    return office ?? null;
  },
  async getUserByEmail(email) {
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        officeId: users.officeId,
        isActive: users.isActive,
      })
      .from(users)
      .where(eq(users.email, email))
      .limit(1);

    return user ?? null;
  },
  async createUser(input) {
    const [user] = await db
      .insert(users)
      .values({
        email: input.email,
        displayName: input.displayName,
        officeId: input.officeId,
        role: input.role,
        isActive: true,
      })
      .returning({
        id: users.id,
        email: users.email,
        displayName: users.displayName,
        role: users.role,
        officeId: users.officeId,
        isActive: users.isActive,
      });

    return user;
  },
  async upsertExternalIdentity(input) {
    await db
      .insert(userExternalIdentities)
      .values({
        userId: input.userId,
        sourceSystem: input.sourceSystem,
        externalUserId: input.externalUserId,
        externalEmail: input.externalEmail,
        externalDisplayName: input.externalDisplayName,
        lastImportedAt: input.now,
        updatedAt: input.now,
      })
      .onConflictDoUpdate({
        target: [
          userExternalIdentities.sourceSystem,
          userExternalIdentities.externalUserId,
        ],
        set: {
          userId: input.userId,
          externalEmail: input.externalEmail,
          externalDisplayName: input.externalDisplayName,
          lastImportedAt: input.now,
          updatedAt: input.now,
        },
      });
  },
};

export interface ImportedUsersSummary {
  scannedCount: number;
  createdCount: number;
  matchedExistingCount: number;
  skippedCount: number;
  warnings: string[];
}

export interface ImportExternalUsersOptions {
  dallasOfficeSlug?: string;
  fetchHubspotOwners?: () => Promise<HubSpotOwner[]>;
  fetchProcoreUsers?: () => Promise<ProcoreUser[]>;
  dependencies?: ImportServiceDependencies;
  now?: () => Date;
}

function normalizeEmail(email: string | null | undefined): string | null {
  const normalized = email?.trim().toLowerCase() ?? "";
  if (!normalized) return null;
  return normalized.includes("@") ? normalized : null;
}

function formatDisplayName(name: string | null | undefined, email: string): string {
  const trimmedName = name?.trim();
  if (trimmedName) return trimmedName;

  const localPart = email.split("@")[0] ?? email;
  return localPart
    .split(/[._-]+/)
    .filter(Boolean)
    .map((segment) => segment.charAt(0).toUpperCase() + segment.slice(1))
    .join(" ") || email;
}

function hubspotDisplayName(owner: HubSpotOwner): string | null {
  const fullName = [owner.firstName, owner.lastName]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return fullName || null;
}

function procoreDisplayName(user: ProcoreUser): string | null {
  const fullName = [user.first_name, user.last_name]
    .map((part) => part?.trim())
    .filter(Boolean)
    .join(" ");

  return user.name?.trim() || fullName || null;
}

function upsertCandidate(
  candidates: Map<string, ExternalUserCandidate>,
  email: string,
  displayName: string | null,
  identity: ExternalIdentityCandidate
) {
  const existing = candidates.get(email);

  if (existing) {
    existing.identities.push(identity);
    if (!existing.displayName && displayName) {
      existing.displayName = displayName;
    }
    return;
  }

  candidates.set(email, {
    email,
    displayName: displayName ?? "",
    identities: [identity],
  });
}

function normalizeExternalUsers(
  hubspotOwners: HubSpotOwner[],
  procoreUsers: ProcoreUser[]
): { candidates: ExternalUserCandidate[]; warnings: string[] } {
  const candidates = new Map<string, ExternalUserCandidate>();
  const warnings: string[] = [];

  for (const owner of hubspotOwners) {
    const email = normalizeEmail(owner.email);
    if (!email) {
      warnings.push(`Skipped HubSpot owner ${owner.id}: missing email`);
      continue;
    }

    upsertCandidate(candidates, email, hubspotDisplayName(owner), {
      sourceSystem: "hubspot",
      externalUserId: owner.id,
      externalEmail: email,
      externalDisplayName: hubspotDisplayName(owner),
    });
  }

  for (const user of procoreUsers) {
    const email = normalizeEmail(user.email_address);
    if (!email) {
      warnings.push(`Skipped Procore user ${user.id}: missing email`);
      continue;
    }

    upsertCandidate(candidates, email, procoreDisplayName(user), {
      sourceSystem: "procore",
      externalUserId: String(user.id),
      externalEmail: email,
      externalDisplayName: procoreDisplayName(user),
    });
  }

  return {
    candidates: [...candidates.values()].map((candidate) => ({
      ...candidate,
      displayName: formatDisplayName(candidate.displayName, candidate.email),
    })),
    warnings,
  };
}

export async function importExternalUsers(
  options: ImportExternalUsersOptions = {}
): Promise<ImportedUsersSummary> {
  const deps = options.dependencies ?? defaultDependencies;
  const now = options.now ?? (() => new Date());
  const dallasOfficeSlug = options.dallasOfficeSlug ?? "dallas";

  const office = await deps.getOfficeBySlug(dallasOfficeSlug);
  if (!office || !office.isActive) {
    throw new AppError(400, "Dallas office is missing or inactive");
  }

  const [hubspotOwners, procoreUsers] = await Promise.all([
    (options.fetchHubspotOwners ?? fetchAllOwners)(),
    (options.fetchProcoreUsers ?? listProcoreUsers)(),
  ]);

  const { candidates, warnings } = normalizeExternalUsers(
    hubspotOwners,
    procoreUsers
  );

  const summary: ImportedUsersSummary = {
    scannedCount: candidates.length,
    createdCount: 0,
    matchedExistingCount: 0,
    skippedCount: warnings.length,
    warnings,
  };

  for (const candidate of candidates) {
    const existing = await deps.getUserByEmail(candidate.email);
    const user =
      existing ??
      (await deps.createUser({
        email: candidate.email,
        displayName: candidate.displayName,
        officeId: office.id,
        role: "rep",
      }));

    if (existing) {
      summary.matchedExistingCount += 1;
    } else {
      summary.createdCount += 1;
    }

    for (const identity of candidate.identities) {
      await deps.upsertExternalIdentity({
        userId: user.id,
        sourceSystem: identity.sourceSystem,
        externalUserId: identity.externalUserId,
        externalEmail: identity.externalEmail,
        externalDisplayName: identity.externalDisplayName,
        now: now(),
      });
    }
  }

  return summary;
}
