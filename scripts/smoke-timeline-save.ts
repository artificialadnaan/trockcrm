const LEAD_PREFIX = "SMOKE TEST DELETE - Timeline Save";
const CREATE_TIMELINE_DATE = "2026-12-31";
const UPDATE_TIMELINE_DATE = "2027-06-15";

type Session = {
  user: { id: string; email: string };
  cookies: string;
  csrf: string;
};

type Fixture = {
  companyId: string;
  propertyId: string;
  contactId: string;
  projectTypeId: string;
  officeCode: string;
};

function readArg(name: string) {
  const prefix = `${name}=`;
  const match = process.argv.find((arg) => arg.startsWith(prefix));
  return match ? match.slice(prefix.length) : null;
}

function apiBaseUrl() {
  return (
    readArg("--api-base") ??
    process.env.SMOKE_API_BASE_URL ??
    process.env.API_BASE_URL ??
    "https://api-production-ad218.up.railway.app"
  ).replace(/\/$/, "");
}

function origin() {
  return readArg("--origin") ?? process.env.SMOKE_ORIGIN ?? process.env.FRONTEND_URL ?? "https://trockcrm.com";
}

function smokeEmail() {
  return readArg("--email") ?? process.env.SMOKE_EMAIL ?? "test-sales@trock.test";
}

function smokePassword() {
  return readArg("--password") ?? process.env.SMOKE_PASSWORD ?? "TrockTest123!";
}

function adminEmail() {
  return readArg("--admin-email") ?? process.env.SMOKE_ADMIN_EMAIL ?? "test-admin@trock.test";
}

function adminPassword() {
  return readArg("--admin-password") ?? process.env.SMOKE_ADMIN_PASSWORD ?? "dev123!";
}

function cookieHeaderFrom(setCookie: string[]) {
  return setCookie.map((entry) => entry.split(";")[0]).join("; ");
}

function cookieValue(cookies: string, name: string) {
  const match = cookies
    .split(";")
    .map((part) => part.trim())
    .find((part) => part.startsWith(`${name}=`));
  return match ? decodeURIComponent(match.slice(name.length + 1)) : null;
}

async function apiJson<T>(
  url: string,
  init: RequestInit & { expectedStatus?: number | number[] } = {}
): Promise<{ status: number; headers: Headers; body: T }> {
  const response = await fetch(url, init);
  const expected = Array.isArray(init.expectedStatus)
    ? init.expectedStatus
    : [init.expectedStatus ?? 200];
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T) : ({} as T);
  if (!expected.includes(response.status)) {
    throw new Error(`HTTP ${response.status} for ${url}: ${text.slice(0, 500)}`);
  }
  return { status: response.status, headers: response.headers, body };
}

async function login(email: string, password: string): Promise<Session> {
  const result = await apiJson<{
    user: { id: string; email: string };
  }>(`${apiBaseUrl()}/api/auth/local/login`, {
    method: "POST",
    headers: { "content-type": "application/json", origin: origin() },
    body: JSON.stringify({ email, password }),
  });
  const cookies = cookieHeaderFrom(result.headers.getSetCookie?.() ?? []);
  const csrf = cookieValue(cookies, "csrf_token");
  if (!cookies.includes("token=") || !csrf) {
    throw new Error(`Login for ${email} succeeded but token/csrf cookies were not returned`);
  }
  return { user: result.body.user, cookies, csrf };
}

function authHeaders(session: Session) {
  return {
    "content-type": "application/json",
    "x-csrf-token": session.csrf,
    cookie: session.cookies,
    origin: origin(),
  };
}

function authGetHeaders(session: Session) {
  return {
    cookie: session.cookies,
    origin: origin(),
  };
}

function getList<T>(body: unknown, key: string): T[] {
  if (Array.isArray(body)) return body as T[];
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>)[key])) {
    return (body as Record<string, T[]>)[key];
  }
  if (body && typeof body === "object" && Array.isArray((body as Record<string, unknown>).data)) {
    return (body as { data: T[] }).data;
  }
  return [];
}

function getLead(body: unknown) {
  if (body && typeof body === "object" && "lead" in body) return (body as { lead: any }).lead;
  return body as any;
}

async function findProjectType(session: Session) {
  const result = await apiJson<unknown>(`${apiBaseUrl()}/api/pipeline/project-types`, {
    headers: authGetHeaders(session),
  });
  const projectTypes = getList<any>(result.body, "projectTypes");
  const selected =
    projectTypes.find((type) => type.isActive !== false && String(type.name ?? "").toLowerCase() === "commercial") ??
    projectTypes.find((type) => type.isActive !== false) ??
    projectTypes[0];
  if (!selected?.id) throw new Error("No project type available for smoke lead creation");
  return selected.id as string;
}

async function findOfficeCode(session: Session) {
  const me = await apiJson<any>(`${apiBaseUrl()}/api/auth/me`, {
    headers: authGetHeaders(session),
  });
  const officeSlug = me.body?.user?.office?.slug ?? me.body?.office?.slug ?? "";
  if (officeSlug === "atlanta") return "atl";
  return "dfw";
}

async function findFixture(session: Session): Promise<Fixture> {
  const [projectTypeId, officeCode] = await Promise.all([findProjectType(session), findOfficeCode(session)]);
  const propertiesResult = await apiJson<unknown>(`${apiBaseUrl()}/api/properties?page=1&limit=100`, {
    headers: authGetHeaders(session),
  });
  const properties = getList<any>(propertiesResult.body, "properties");

  for (const property of properties) {
    const propertyId = property.id;
    const companyId = property.companyId ?? property.company_id;
    if (!propertyId || !companyId) continue;

    const contactsResult = await apiJson<unknown>(
      `${apiBaseUrl()}/api/contacts?page=1&limit=25&companyId=${encodeURIComponent(companyId)}`,
      { headers: authGetHeaders(session) }
    );
    const contacts = getList<any>(contactsResult.body, "contacts");
    const contact = contacts.find((candidate) => candidate.id);
    if (!contact?.id) continue;

    return {
      companyId,
      propertyId,
      contactId: contact.id,
      projectTypeId,
      officeCode,
    };
  }

  throw new Error("Unable to find a company/property/contact fixture through the public API");
}

function assertTimeline(label: string, lead: any, expected: string) {
  const qualificationTimeline = lead?.qualificationPayload?.timeline_status;
  const questionnaireTimeline = lead?.leadQuestionnaire?.answers?.timeline;
  if (qualificationTimeline !== expected || questionnaireTimeline !== expected) {
    throw new Error(
      `${label} expected timeline ${expected}, got qualification=${qualificationTimeline ?? "null"} questionnaire=${questionnaireTimeline ?? "null"}`
    );
  }
}

async function cleanupLead(leadId: string) {
  const admin = await login(adminEmail(), adminPassword());
  await apiJson(`${apiBaseUrl()}/api/leads/${leadId}`, {
    method: "DELETE",
    headers: authHeaders(admin),
    expectedStatus: [200, 204],
  });
}

async function run() {
  const session = await login(smokeEmail(), smokePassword());
  const fixture = await findFixture(session);
  const headers = authHeaders(session);
  let leadId: string | null = null;

  try {
    const created = await apiJson<unknown>(`${apiBaseUrl()}/api/leads`, {
      method: "POST",
      headers,
      body: JSON.stringify({
        companyId: fixture.companyId,
        propertyId: fixture.propertyId,
        primaryContactId: fixture.contactId,
        primaryContactRole: "property_manager",
        name: `${LEAD_PREFIX} ${new Date().toISOString()}`,
        assignedRepId: session.user.id,
        salesRepId: session.user.id,
        sourceCategory: "Referral",
        sourceDetail: null,
        description: "SMOKE TEST DELETE timeline save smoke",
        officeCode: fixture.officeCode,
        projectTypeId: fixture.projectTypeId,
        bidDueDate: "2026-06-01",
        budgetStatus: "budgeted_q3",
        qualificationPayload: {
          existing_customer_status: null,
          estimated_value: 1000,
          timeline_status: CREATE_TIMELINE_DATE,
        },
        leadQuestionAnswers: {
          budget: 1000,
          timeline: CREATE_TIMELINE_DATE,
        },
      }),
      expectedStatus: 201,
    });
    const createdLead = getLead(created.body);
    leadId = createdLead.id;

    const firstFetch = await apiJson<unknown>(`${apiBaseUrl()}/api/leads/${leadId}`, {
      headers: authGetHeaders(session),
    });
    assertTimeline("create/refetch", getLead(firstFetch.body), CREATE_TIMELINE_DATE);

    await apiJson<unknown>(`${apiBaseUrl()}/api/leads/${leadId}`, {
      method: "PATCH",
      headers,
      body: JSON.stringify({
        name: createdLead.name,
        sourceCategory: "Referral",
        sourceDetail: null,
        description: "SMOKE TEST DELETE timeline save smoke update",
        projectTypeId: fixture.projectTypeId,
        qualificationPayload: {
          existing_customer_status: null,
          estimated_value: 1000,
          timeline_status: UPDATE_TIMELINE_DATE,
        },
        leadQuestionAnswers: {
          budget: 1000,
          timeline: UPDATE_TIMELINE_DATE,
        },
      }),
    });

    const secondFetch = await apiJson<unknown>(`${apiBaseUrl()}/api/leads/${leadId}`, {
      headers: authGetHeaders(session),
    });
    assertTimeline("update/refetch", getLead(secondFetch.body), UPDATE_TIMELINE_DATE);

    console.log(
      JSON.stringify(
        {
          ok: true,
          leadId,
          createdTimeline: CREATE_TIMELINE_DATE,
          updatedTimeline: UPDATE_TIMELINE_DATE,
        },
        null,
        2
      )
    );
  } finally {
    if (leadId) {
      await cleanupLead(leadId);
      console.log(JSON.stringify({ cleanup: { leadId, deleted: true } }, null, 2));
    }
  }
}

run().catch((error) => {
  console.error(error);
  process.exit(1);
});
