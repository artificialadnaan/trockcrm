/**
 * CompanyCam API v2 client.
 * Read-only integration — fetches projects and photos.
 */

const BASE_URL = "https://api.companycam.com/v2";

function getApiKey(): string {
  const key = process.env.COMPANYCAM_API_KEY;
  if (!key) throw new Error("COMPANYCAM_API_KEY is not configured");
  return key;
}

async function ccFetch<T>(path: string, params?: Record<string, string>): Promise<T> {
  const url = new URL(`${BASE_URL}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      url.searchParams.set(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    headers: {
      Authorization: `Bearer ${getApiKey()}`,
      Accept: "application/json",
    },
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`CompanyCam API ${res.status}: ${res.statusText} — ${body}`);
  }

  return res.json() as Promise<T>;
}

// ─── Types ───────────────────────────────────────────────────────────────────

export interface CCProject {
  id: string;
  name: string;
  status: string;
  archived: boolean;
  photo_count: number;
  address: {
    street_address_1: string | null;
    street_address_2: string | null;
    city: string | null;
    state: string | null;
    postal_code: string | null;
    country: string;
  };
  coordinates: { lat: number; lon: number };
  created_at: number; // unix timestamp
  updated_at: number;
  project_url: string;
  integrations: Array<{ type: string; relation_id: string }>;
}

export interface CCPhotoUri {
  type: "original" | "web" | "thumbnail" | "original_annotation" | "web_annotation" | "thumbnail_annotation";
  uri: string;
  url: string;
}

export interface CCPhoto {
  id: string;
  project_id: string;
  creator_name: string;
  coordinates: { lat: number; lon: number };
  status: string;
  uris: CCPhotoUri[];
  hash: string;
  captured_at: number; // unix timestamp
  created_at: number;
  updated_at: number;
  photo_url: string;
  description: string | null;
}

// ─── API Functions ───────────────────────────────────────────────────────────

/**
 * Fetch all projects (paginated, max 100 per page).
 */
export async function getAllProjects(): Promise<CCProject[]> {
  const allProjects: CCProject[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const batch = await ccFetch<CCProject[]>("/projects", {
      per_page: String(perPage),
      page: String(page),
    });

    allProjects.push(...batch);

    if (batch.length < perPage) break;
    page++;
  }

  return allProjects;
}

/**
 * Fetch all photos for a project (paginated).
 */
export async function getProjectPhotos(projectId: string): Promise<CCPhoto[]> {
  const allPhotos: CCPhoto[] = [];
  let page = 1;
  const perPage = 100;

  while (true) {
    const batch = await ccFetch<CCPhoto[]>(`/projects/${projectId}/photos`, {
      per_page: String(perPage),
      page: String(page),
    });

    allPhotos.push(...batch);

    if (batch.length < perPage) break;
    page++;
  }

  return allPhotos;
}

/**
 * Fetch a single project by ID.
 */
export async function getProject(projectId: string): Promise<CCProject> {
  return ccFetch<CCProject>(`/projects/${projectId}`);
}
