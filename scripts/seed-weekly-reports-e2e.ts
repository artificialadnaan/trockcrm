/**
 * Seed a LOCAL verification database for the Weekly Reports end-to-end walk-through.
 *
 * Idempotent and re-runnable: every row is keyed by a fixed UUID (or by a natural key) and upserted, so
 * running it twice leaves the same database. Every date is derived from the office's business "today" at
 * run time, so the shape of the backlog stays the same however long after it was written you run it —
 * a seed pinned to literal dates goes stale the week after it is committed.
 *
 * Usage:
 *   DATABASE_URL=postgresql://<user>@localhost:5432/trock_wr_verify npx tsx scripts/seed-weekly-reports-e2e.ts
 *
 * LOCAL ONLY. The script refuses to run against anything that is not localhost — see assertLocalOnly().
 */
import pg from "pg";
// The REAL hasher, not a local re-derivation of `scrypt$salt$key`. If the scheme ever changes, a seed
// that restated the format would keep writing hashes the login route silently rejects.
import { hashPassword } from "../server/src/modules/auth/local-auth-service.js";
import {
  WEEKLY_REPORT_PHOTO_WINDOW_DAYS,
  shiftIsoDate,
  weeklyReportDaysLate,
  weeklyReportExpectedWeeks,
  weeklyReportWeekOf,
} from "@trock-crm/shared/types";

// ---------------------------------------------------------------------------
// Safety
// ---------------------------------------------------------------------------

/**
 * Refuse anything that is not a local database.
 *
 * This script writes deals, users and files. Pointing it at a shared or hosted database by pasting the
 * wrong URL is a single-keystroke mistake with no undo, so the check is on the host rather than on a
 * confirmation prompt somebody would learn to hit through.
 */
function assertLocalOnly(rawUrl: string): void {
  const url = new URL(rawUrl);
  const host = url.hostname.toLowerCase();
  if (host !== "localhost" && host !== "127.0.0.1" && host !== "::1") {
    throw new Error(
      `Refusing to seed a non-local database (host=${host}). This script is for the local verification DB only.`,
    );
  }
}

// ---------------------------------------------------------------------------
// Dates
// ---------------------------------------------------------------------------

/** "Today" in the office's timezone — the same anchor the API's `businessToday()` uses. */
function businessToday(): string {
  return new Date().toLocaleDateString("en-CA", { timeZone: "America/Chicago" });
}

const TODAY = businessToday();
const ago = (days: number) => shiftIsoDate(TODAY, -days);

// ---------------------------------------------------------------------------
// Fixed identities. Stable across runs so the seed is an UPSERT, not an append.
// ---------------------------------------------------------------------------

const OFFICE_SLUG = process.env.WR_E2E_OFFICE_SLUG?.trim() || "dallas";

/**
 * The password every persona shares on the local verification database.
 *
 * The CRM's login screen is an email + password form; the `/auth/dev/users` picker component exists but
 * is not mounted, so without a real `user_local_auth` row there is NO way to sign in through the browser
 * and the whole walk-through would have to be driven from a console. 12 characters is the server's floor.
 */
const LOCAL_PASSWORD = process.env.WR_E2E_PASSWORD?.trim() || "WeeklyReports!2026";

/** Personas. Dev login only accepts @trock.dev addresses (server/src/modules/auth/routes.ts). */
const PERSONAS = [
  {
    key: "leadership",
    email: "admin@trock.dev",
    displayName: "Admin User",
    role: "admin",
    why: "Leadership. Reaches /projects/weekly-reports and PUT /weekly-reports/settings.",
  },
  {
    key: "leadership2",
    email: "director@trock.dev",
    displayName: "James Director",
    role: "director",
    why: "Second leadership persona; also on the digest recipient list.",
  },
  {
    key: "pm",
    email: "pm@trock.dev",
    displayName: "Priya Mendes",
    // NOT `rep`. The PM must be BOTH assignable (ASSIGNABLE_ROLES = field_contractor | construction |
    // admin | director) and admitted to the CRM weekly-reports router (requireRole admin | director |
    // rep). The intersection is admin/director, so a PM who can be assigned AND can approve/send from
    // the CRM has to hold one of those two. A `rep` would be rejected by assertAssignableUser.
    role: "director",
    why: "The assigned T-Rock PM. Approves and sends.",
  },
  {
    key: "super",
    email: "super@trock.dev",
    displayName: "Steve Sanchez",
    role: "construction",
    why: "The assigned superintendent. Authors in T-Rock Cam (/api/field).",
  },
  {
    key: "super2",
    email: "super2@trock.dev",
    displayName: "Marcus Webb",
    role: "field_contractor",
    why: "Second superintendent — proves the picker includes field_contractor as well as construction.",
  },
] as const;

type PersonaKey = (typeof PERSONAS)[number]["key"];

/** Deals. `stage` is a `public.pipeline_stage_config.slug`. */
const DEALS = [
  {
    id: "00000000-0000-4000-8000-000000008001",
    name: "4123 Cedar Springs",
    dealNumber: "DFW-10432",
    projectNumber: "DFW-10432",
    stage: "won",
    address: "4123 Cedar Springs Rd, Dallas, TX 75219",
  },
  {
    id: "00000000-0000-4000-8000-000000008002",
    name: "8800 Preston Road",
    dealNumber: "DFW-10501",
    projectNumber: "DFW-10501",
    stage: "won",
    address: "8800 Preston Rd, Dallas, TX 75225",
  },
  {
    id: "00000000-0000-4000-8000-000000008003",
    name: "1500 Marilla Street",
    dealNumber: "DFW-10502",
    projectNumber: "DFW-10502",
    stage: "won",
    address: "1500 Marilla St, Dallas, TX 75201",
  },
  {
    id: "00000000-0000-4000-8000-000000008004",
    name: "2200 Ross Avenue",
    dealNumber: "DFW-10503",
    projectNumber: "DFW-10503",
    stage: "won",
    address: "2200 Ross Ave, Dallas, TX 75201",
  },
  {
    id: "00000000-0000-4000-8000-000000008005",
    name: "700 North Pearl",
    dealNumber: "DFW-10504",
    projectNumber: "DFW-10504",
    stage: "won",
    address: "700 N Pearl St, Dallas, TX 75201",
  },
  {
    // Won, and deliberately left WITHOUT a weekly-report setup: this is the deal the browser walk-through
    // picks in the "New project" form. Every other Won deal already has one, and the picker filters those
    // out — with nothing free the form step has nothing to select.
    id: "00000000-0000-4000-8000-000000008007",
    name: "3300 Oak Lawn Avenue",
    dealNumber: "DFW-10506",
    projectNumber: "DFW-10506",
    stage: "won",
    address: "3300 Oak Lawn Ave, Dallas, TX 75219",
  },
  {
    // Deliberately NOT Won. createWeeklyReportProject answers 400 "Weekly reports can only be set up on
    // a Won project" for this one — the negative case the server guard exists for.
    id: "00000000-0000-4000-8000-000000008006",
    name: "9001 Forest Lane",
    dealNumber: "DFW-10505",
    projectNumber: "DFW-10505",
    stage: "estimating",
    address: "9001 Forest Ln, Dallas, TX 75243",
  },
] as const;

interface ProjectSeed {
  id: string;
  dealId: string;
  label: string;
  propertyDisplayName: string;
  clientName: string;
  clientTeam: { doc: [string, string]; pm: [string, string]; rm: [string, string]; cm: [string, string] };
  pm: PersonaKey;
  super: PersonaKey;
  cadenceWeekday: number;
  cadenceStartDate: string;
  contractDate: string;
  projectStartDate: string;
  projectCompletionDate: string | null;
  projectCompletionDateNote: string | null;
  projectedDurationWeeks: number;
  status: "active" | "paused" | "completed";
  /** Closed and/or open pause intervals to record in weekly_report_pauses. */
  pauses: Array<{ from: string; to: string | null }>;
  /** Days back from today for each seeded photo. Values > 14 sit OUTSIDE the picker window on purpose. */
  photoDaysAgo: number[];
  note: string;
}

const PROJECTS: ProjectSeed[] = [
  {
    id: "00000000-0000-4000-8000-00000000b001",
    dealId: DEALS[0].id,
    label: "A — deep backlog",
    propertyDisplayName: "4123 Cedar Springs",
    clientName: "Mack Real Estate Group",
    clientTeam: {
      doc: ["Dana Ortiz", "dana.ortiz@mackreg.example.com"],
      pm: ["Chris Lau", "chris.lau@mackreg.example.com"],
      rm: ["Renee Park", "renee.park@mackreg.example.com"],
      cm: ["Cal Mendoza", "cal.mendoza@mackreg.example.com"],
    },
    pm: "pm",
    super: "super",
    cadenceWeekday: 4, // Thursday
    cadenceStartDate: ago(56),
    contractDate: ago(70),
    projectStartDate: ago(60),
    projectCompletionDate: null,
    projectCompletionDateNote: "TBD Permit",
    projectedDurationWeeks: 26,
    status: "active",
    pauses: [],
    photoDaysAgo: [1, 3, 5, 8, 12, 30],
    note: "Eight weeks of cadence, nothing filed — the oldest week should sort to the top of This Week.",
  },
  {
    id: "00000000-0000-4000-8000-00000000b002",
    dealId: DEALS[1].id,
    label: "B — short backlog",
    propertyDisplayName: "8800 Preston Road",
    clientName: "Weitzman Group",
    clientTeam: {
      doc: ["Alex Trent", "alex.trent@weitzman.example.com"],
      pm: ["Nadia Rowe", "nadia.rowe@weitzman.example.com"],
      rm: ["", ""],
      cm: ["", ""],
    },
    pm: "pm",
    super: "super2",
    cadenceWeekday: 3, // Wednesday
    cadenceStartDate: ago(21),
    contractDate: ago(35),
    projectStartDate: ago(28),
    projectCompletionDate: shiftIsoDate(TODAY, 120),
    projectCompletionDateNote: null,
    projectedDurationWeeks: 20,
    status: "active",
    pauses: [],
    photoDaysAgo: [0, 2, 6, 11, 20],
    note: "Three-ish outstanding weeks — a middle-of-the-board age.",
  },
  {
    id: "00000000-0000-4000-8000-00000000b003",
    dealId: DEALS[2].id,
    label: "C — current week only",
    propertyDisplayName: "1500 Marilla Street",
    clientName: "City of Dallas",
    clientTeam: {
      doc: ["Toni Baker", "toni.baker@dallas.example.gov"],
      pm: ["Ray Suarez", "ray.suarez@dallas.example.gov"],
      rm: ["", ""],
      cm: ["", ""],
    },
    pm: "pm",
    super: "super",
    cadenceWeekday: 1, // Monday
    cadenceStartDate: TODAY,
    contractDate: ago(10),
    projectStartDate: ago(5),
    projectCompletionDate: null,
    projectCompletionDateNote: null,
    projectedDurationWeeks: 12,
    status: "active",
    pauses: [],
    photoDaysAgo: [0, 4],
    note: 'Exactly one row, "Due", zero days late — the bottom of the ordering.',
  },
  {
    id: "00000000-0000-4000-8000-00000000b004",
    dealId: DEALS[3].id,
    label: "D — resumed after a pause",
    propertyDisplayName: "2200 Ross Avenue",
    clientName: "Hillwood Properties",
    clientTeam: {
      doc: ["Gene Alvarez", "gene.alvarez@hillwood.example.com"],
      pm: ["Sam Whitlock", "sam.whitlock@hillwood.example.com"],
      rm: ["", ""],
      cm: ["", ""],
    },
    pm: "pm",
    super: "super",
    cadenceWeekday: 5, // Friday
    cadenceStartDate: ago(49),
    contractDate: ago(63),
    projectStartDate: ago(56),
    projectCompletionDate: null,
    projectCompletionDateNote: null,
    projectedDurationWeeks: 30,
    status: "active",
    // Closed interval: reporting stopped for three weeks and has since resumed. The weeks INSIDE the
    // interval must not be generated; the weeks BEFORE it must still be outstanding. That asymmetry is
    // the whole point of migration 0223 and is the cheapest thing on this board to get wrong.
    pauses: [{ from: ago(35), to: ago(14) }],
    photoDaysAgo: [2, 9],
    note: "Pre-pause weeks outstanding, paused weeks absent — 0223's invariant, visible on the board.",
  },
  {
    id: "00000000-0000-4000-8000-00000000b005",
    dealId: DEALS[4].id,
    label: "E — currently paused",
    propertyDisplayName: "700 North Pearl",
    clientName: "Crow Holdings",
    clientTeam: {
      doc: ["Lena Fry", "lena.fry@crowholdings.example.com"],
      pm: ["", ""],
      rm: ["", ""],
      cm: ["", ""],
    },
    pm: "pm",
    super: "super2",
    cadenceWeekday: 2, // Tuesday
    cadenceStartDate: ago(42),
    contractDate: ago(56),
    projectStartDate: ago(49),
    projectCompletionDate: null,
    projectCompletionDateNote: null,
    projectedDurationWeeks: 18,
    status: "paused",
    pauses: [{ from: ago(28), to: null }],
    photoDaysAgo: [],
    note: "Must appear on the Projects tab and NOWHERE on This Week (dashboard filters status='active').",
  },
];

// ---------------------------------------------------------------------------
// Seed
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const connectionString = process.env.DATABASE_URL;
  if (!connectionString) throw new Error("DATABASE_URL is required");
  assertLocalOnly(connectionString);

  const client = new pg.Client({ connectionString });
  await client.connect();

  try {
    await client.query("BEGIN");

    const office = await client.query(
      `SELECT id, slug FROM public.offices WHERE slug = $1 LIMIT 1`,
      [OFFICE_SLUG],
    );
    if (!office.rows[0]) throw new Error(`No office with slug "${OFFICE_SLUG}" in public.offices`);
    const officeId: string = office.rows[0].id;
    const schema = `office_${OFFICE_SLUG}`;
    await client.query(`SET LOCAL search_path TO ${schema}, public`);

    // --- personas -----------------------------------------------------------
    const userIdByKey = new Map<PersonaKey, string>();
    for (const persona of PERSONAS) {
      const result = await client.query(
        `INSERT INTO public.users (email, display_name, role, office_id, is_active, is_test_data)
         VALUES ($1, $2, $3::user_role, $4::uuid, true, false)
         ON CONFLICT (email) DO UPDATE
            SET display_name = EXCLUDED.display_name,
                role         = EXCLUDED.role,
                office_id    = EXCLUDED.office_id,
                is_active    = true,
                is_test_data = false,
                updated_at   = now()
         RETURNING id`,
        [persona.email, persona.displayName, persona.role, officeId],
      );
      userIdByKey.set(persona.key, result.rows[0].id);

      // Browser login. `loginWithLocalPassword` refuses `field_contractor` outright, so Marcus Webb
      // cannot sign in to the CRM at all — which is correct, and worth seeing rather than working around.
      if (persona.role === "field_contractor") continue;
      await client.query(
        `INSERT INTO public.user_local_auth (user_id, password_hash, must_change_password, is_enabled,
                                             failed_login_attempts, locked_until, revoked_at, password_changed_at)
         VALUES ($1::uuid, $2, false, true, 0, NULL, NULL, now())
         ON CONFLICT (user_id) DO UPDATE
            SET password_hash         = EXCLUDED.password_hash,
                must_change_password  = false,
                is_enabled            = true,
                -- Reset explicitly. Five bad attempts lock the account for 15 minutes and the counter is
                -- NOT cleared by a later success, so a poked-at database stays locked until something
                -- zeroes these two.
                failed_login_attempts = 0,
                locked_until          = NULL,
                revoked_at            = NULL,
                updated_at            = now()`,
        [result.rows[0].id, await hashPassword(LOCAL_PASSWORD)],
      );
    }

    // --- deals --------------------------------------------------------------
    const stages = await client.query(`SELECT id, slug FROM public.pipeline_stage_config`);
    const stageIdBySlug = new Map<string, string>(stages.rows.map((r) => [r.slug, r.id]));

    for (const deal of DEALS) {
      const stageId = stageIdBySlug.get(deal.stage);
      if (!stageId) throw new Error(`No pipeline stage with slug "${deal.stage}"`);
      await client.query(
        `INSERT INTO deals (id, name, deal_number, project_number, stage_id, property_address,
                            is_active, is_test_data, stage_entered_at)
         VALUES ($1::uuid, $2, $3, $4, $5::uuid, $6, true, false, now())
         ON CONFLICT (id) DO UPDATE
            SET name             = EXCLUDED.name,
                deal_number      = EXCLUDED.deal_number,
                project_number   = EXCLUDED.project_number,
                stage_id         = EXCLUDED.stage_id,
                property_address = EXCLUDED.property_address,
                is_active        = true,
                is_test_data     = false,
                updated_at       = now()`,
        [deal.id, deal.name, deal.dealNumber, deal.projectNumber, stageId, deal.address],
      );
    }

    // --- weekly report projects --------------------------------------------
    // A LIVE setup is unique per deal (weekly_report_projects_deal_uidx). Any earlier setup on one of
    // these deals — hand-made while poking at the board, or left by a previous version of this seed —
    // would collide with the fixed ids below, so it is removed first. Scoped to the seeded deals only.
    await client.query(
      `DELETE FROM weekly_report_projects
        WHERE deal_id = ANY($1::uuid[]) AND NOT (id = ANY($2::uuid[]))`,
      [DEALS.map((d) => d.id), PROJECTS.map((p) => p.id)],
    );

    for (const project of PROJECTS) {
      await client.query(
        `INSERT INTO weekly_report_projects (
           id, deal_id, property_display_name, client_name,
           client_doc_name, client_doc_email, client_pm_name, client_pm_email,
           client_rm_name, client_rm_email, client_cm_name, client_cm_email,
           trock_pm_user_id, trock_super_user_id,
           contract_date, project_start_date, project_completion_date, project_completion_date_note,
           projected_duration_weeks, cadence_weekday, cadence_start_date, status, is_active, created_by
         ) VALUES (
           $1::uuid, $2::uuid, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12,
           $13::uuid, $14::uuid, $15::date, $16::date, $17::date, $18,
           $19, $20, $21::date, $22, true, $23::uuid
         )
         ON CONFLICT (id) DO UPDATE SET
           deal_id                       = EXCLUDED.deal_id,
           property_display_name         = EXCLUDED.property_display_name,
           client_name                   = EXCLUDED.client_name,
           client_doc_name               = EXCLUDED.client_doc_name,
           client_doc_email              = EXCLUDED.client_doc_email,
           client_pm_name                = EXCLUDED.client_pm_name,
           client_pm_email               = EXCLUDED.client_pm_email,
           client_rm_name                = EXCLUDED.client_rm_name,
           client_rm_email               = EXCLUDED.client_rm_email,
           client_cm_name                = EXCLUDED.client_cm_name,
           client_cm_email               = EXCLUDED.client_cm_email,
           trock_pm_user_id              = EXCLUDED.trock_pm_user_id,
           trock_super_user_id           = EXCLUDED.trock_super_user_id,
           contract_date                 = EXCLUDED.contract_date,
           project_start_date            = EXCLUDED.project_start_date,
           project_completion_date       = EXCLUDED.project_completion_date,
           project_completion_date_note  = EXCLUDED.project_completion_date_note,
           projected_duration_weeks      = EXCLUDED.projected_duration_weeks,
           cadence_weekday               = EXCLUDED.cadence_weekday,
           cadence_start_date            = EXCLUDED.cadence_start_date,
           status                        = EXCLUDED.status,
           is_active                     = true,
           updated_at                    = now()`,
        [
          project.id,
          project.dealId,
          project.propertyDisplayName,
          project.clientName,
          project.clientTeam.doc[0] || null,
          project.clientTeam.doc[1] || null,
          project.clientTeam.pm[0] || null,
          project.clientTeam.pm[1] || null,
          project.clientTeam.rm[0] || null,
          project.clientTeam.rm[1] || null,
          project.clientTeam.cm[0] || null,
          project.clientTeam.cm[1] || null,
          userIdByKey.get(project.pm),
          userIdByKey.get(project.super),
          project.contractDate,
          project.projectStartDate,
          project.projectCompletionDate,
          project.projectCompletionDateNote,
          project.projectedDurationWeeks,
          project.cadenceWeekday,
          project.cadenceStartDate,
          project.status,
          userIdByKey.get("leadership"),
        ],
      );

      // Pauses. Rewritten wholesale so a re-run cannot accumulate overlapping intervals — and note the
      // partial unique index allows only ONE open interval per project, so an append would eventually
      // fail rather than merely duplicate.
      await client.query(`DELETE FROM weekly_report_pauses WHERE weekly_report_project_id = $1::uuid`, [
        project.id,
      ]);
      for (const pause of project.pauses) {
        await client.query(
          `INSERT INTO weekly_report_pauses (weekly_report_project_id, paused_from, resumed_on, paused_by)
           VALUES ($1::uuid, $2::date, $3::date, $4::uuid)`,
          [project.id, pause.from, pause.to, userIdByKey.get("leadership")],
        );
      }
    }

    // --- photos -------------------------------------------------------------
    // `listWeeklyReportPhotoCandidates` filters on category='photo', is_active, deleted_at IS NULL and
    // COALESCE(taken_at, created_at)::date inside the 14 days ending on week_of — so taken_at is the
    // column that decides whether a photo is offered, and it is set explicitly here.
    const uploader = userIdByKey.get("super")!;
    let photoIndex = 0;
    for (const project of PROJECTS) {
      for (const daysAgo of project.photoDaysAgo) {
        photoIndex += 1;
        const fileId = `00000000-0000-4000-8000-${String(700000000000 + photoIndex).slice(-12)}`;
        const takenAt = ago(daysAgo);
        await client.query(
          `INSERT INTO files (
             id, category, display_name, system_filename, original_filename, mime_type,
             file_size_bytes, file_extension, r2_key, r2_bucket, deal_id, description,
             taken_at, uploaded_by, is_active
           ) VALUES (
             $1::uuid, 'photo', $2, $3, $4, 'image/jpeg',
             2400000, 'jpg', $5, 'trock-local', $6::uuid, $7,
             $8::date + time '14:20', $9::uuid, true
           )
           ON CONFLICT (id) DO UPDATE SET
             deal_id     = EXCLUDED.deal_id,
             description = EXCLUDED.description,
             taken_at    = EXCLUDED.taken_at,
             is_active   = true,
             deleted_at  = NULL,
             updated_at  = now()`,
          [
            fileId,
            `${project.propertyDisplayName} — progress ${takenAt}.jpg`,
            `wr-e2e-${photoIndex}.jpg`,
            `IMG_${1000 + photoIndex}.jpg`,
            `local/wr-e2e/${fileId}.jpg`,
            project.dealId,
            `Field capture ${takenAt} (${daysAgo} days before seed run)`,
            takenAt,
            uploader,
          ],
        );
      }
    }

    // --- settings -----------------------------------------------------------
    await client.query(
      `INSERT INTO weekly_report_settings (singleton, leadership_recipient_emails, updated_by)
       VALUES (true, $1::text[], $2::uuid)
       ON CONFLICT (singleton) DO UPDATE
          SET leadership_recipient_emails = EXCLUDED.leadership_recipient_emails,
              updated_by = EXCLUDED.updated_by,
              updated_at = now()`,
      [["admin@trock.dev", "director@trock.dev"], userIdByKey.get("leadership")],
    );

    await client.query("COMMIT");

    // --- report -------------------------------------------------------------
    // The expected-week set is computed with the SHIPPED generator, imported from `shared`, rather than
    // restated here. A predictor that re-implements the thing it predicts drifts on the first change to
    // the cadence rules and then quietly reports agreement with itself.
    console.log(`\nSeeded ${schema} (business today = ${TODAY})\n`);
    console.log(`Personas — sign in on the CRM login screen; password for all: ${LOCAL_PASSWORD}`);
    for (const persona of PERSONAS) {
      const login = persona.role === "field_contractor" ? "NO CRM LOGIN" : "password";
      console.log(
        `  ${persona.email.padEnd(20)} ${String(persona.role).padEnd(16)} ${persona.displayName.padEnd(16)} [${login}] ${persona.why}`,
      );
    }

    console.log("\nDeals with no weekly-report setup, kept free on purpose:");
    console.log(
      "  3300 Oak Lawn Avenue  DFW-10506  Won      — pick this one in the \"New project\" form.\n" +
        "                                             Re-running this seed clears whatever the form created.",
    );
    console.log(
      "  9001 Forest Lane      DFW-10505  estimating — POST /weekly-reports/projects must answer 400.",
    );

    console.log("\nProjects and the weeks the cadence generates for them:");
    for (const project of PROJECTS) {
      const currentWeekOf = weeklyReportWeekOf(project.cadenceWeekday, TODAY);
      const expected =
        project.status === "active"
          ? weeklyReportExpectedWeeks({
              cadenceWeekday: project.cadenceWeekday,
              cadenceStartDate: project.cadenceStartDate,
              cadenceEndDate: null,
              throughDate: currentWeekOf,
              pausedIntervals: project.pauses,
            })
          : [];
      const window = {
        from: shiftIsoDate(currentWeekOf, -(WEEKLY_REPORT_PHOTO_WINDOW_DAYS - 1)),
        to: currentWeekOf,
      };
      const inWindow = project.photoDaysAgo.filter((d) => {
        const taken = ago(d);
        return taken >= window.from && taken <= window.to;
      }).length;

      console.log(`\n  ${project.label}  [${project.propertyDisplayName}]  status=${project.status}`);
      console.log(`    project id     ${project.id}`);
      console.log(`    deal id        ${project.dealId}`);
      console.log(`    cadence        weekday ${project.cadenceWeekday}, from ${project.cadenceStartDate}`);
      if (project.pauses.length) {
        console.log(
          `    pauses         ${project.pauses.map((p) => `[${p.from} .. ${p.to ?? "open"})`).join(", ")}`,
        );
      }
      console.log(`    photos         ${project.photoDaysAgo.length} seeded, ${inWindow} inside the ` +
        `${WEEKLY_REPORT_PHOTO_WINDOW_DAYS}-day window ${window.from}..${window.to}`);
      if (expected.length === 0) {
        console.log(`    board rows     none (${project.status === "active" ? "no weeks yet" : "not active"})`);
      } else {
        console.log(`    board rows     ${expected.length}`);
        for (const weekOf of expected) {
          const late = weeklyReportDaysLate(weekOf, TODAY);
          const tag = weekOf === currentWeekOf ? "current" : "backlog";
          console.log(`      ${weekOf}  ${tag.padEnd(8)} ${late > 0 ? `${late} days late` : "Due"}`);
        }
      }
      console.log(`    why            ${project.note}`);
    }

    const allRows = PROJECTS.filter((p) => p.status === "active").flatMap((project) => {
      const currentWeekOf = weeklyReportWeekOf(project.cadenceWeekday, TODAY);
      return weeklyReportExpectedWeeks({
        cadenceWeekday: project.cadenceWeekday,
        cadenceStartDate: project.cadenceStartDate,
        cadenceEndDate: null,
        throughDate: currentWeekOf,
        pausedIntervals: project.pauses,
      }).map((weekOf) => ({
        project: project.propertyDisplayName,
        weekOf,
        daysLate: weeklyReportDaysLate(weekOf, TODAY),
      }));
    });
    allRows.sort(
      (a, b) => b.daysLate - a.daysLate || a.weekOf.localeCompare(b.weekOf) || a.project.localeCompare(b.project),
    );
    console.log(`\nExpected "This Week" board — ${allRows.length} rows, most overdue first:`);
    for (const row of allRows) {
      console.log(
        `  ${String(row.daysLate).padStart(3)} days late  ${row.weekOf}  ${row.project}`.replace(
          "  0 days late",
          "         Due",
        ),
      );
    }
    console.log("");
  } catch (error) {
    await client.query("ROLLBACK").catch(() => {});
    throw error;
  } finally {
    await client.end();
  }
}

main()
  // Explicit exit: importing the auth service pulls in the Drizzle pool, whose idle socket keeps the
  // event loop alive long after the seed itself is finished.
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
