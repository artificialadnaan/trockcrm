import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Eye, Search, Star, X } from "lucide-react";
import { api, getActiveOfficeId } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, TextInput } from "../components/ui";
import { type FieldProject, isProjectOffOffice, relativeDate } from "../lib/field-projects";

function ProjectCard({
  project,
  onToggleStar,
  writableOfficeId,
}: {
  project: FieldProject;
  onToggleStar: (project: FieldProject) => void;
  writableOfficeId: string | undefined;
}) {
  // Cross-office projects are view-only until cross-office writes ship: their single-office star write
  // would 404 against the active office's schema, so suppress the star and show why.
  const offOffice = isProjectOffOffice(project, writableOfficeId);
  return (
    <Link
      to={`/projects/${project.id}`}
      className="block border-b border-border bg-white py-4 active:bg-muted"
      aria-label={`Open ${project.name} (${project.projectNumber ?? "project pending"})`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold">{project.name}</h2>
          <div className="mt-1 flex flex-wrap items-start gap-2 text-sm">
            <p className="font-semibold text-foreground break-all">
              {project.projectNumber ? `Project # ${project.projectNumber}` : "Project pending"}
            </p>
            <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-bold text-muted-foreground">{project.stage}</span>
            {offOffice ? (
              <span className="rounded-full bg-amber-100 px-2 py-0.5 text-xs font-bold uppercase text-amber-700">
                {project.officeSlug} · view-only
              </span>
            ) : null}
          </div>
          <p className="mt-1 truncate text-sm text-muted-foreground">{project.propertyAddress || "No address on file"}</p>
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            {project.photoCount} photos • {relativeDate(project.lastActivityAt)}
          </p>
        </div>
        {offOffice ? (
          <span
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground"
            aria-label={`Managed by the ${project.officeSlug} office — view only`}
          >
            <Eye className="h-6 w-6" />
          </span>
        ) : (
          <button
            type="button"
            aria-label={project.starred ? "Unstar project" : "Star project"}
            className="flex min-h-11 min-w-11 items-center justify-center rounded-full text-primary hover:bg-muted"
            onClick={(event) => {
              event.preventDefault();
              event.stopPropagation();
              onToggleStar(project);
            }}
          >
            <Star className={project.starred ? "h-6 w-6 fill-primary" : "h-6 w-6"} />
          </button>
        )}
      </div>
    </Link>
  );
}

export function ProjectsPage() {
  const { user } = useAuth();
  // Which office the single-office write endpoints target (active office, else the user's home office).
  const writableOfficeId = getActiveOfficeId() ?? user?.tenantId;
  const [projects, setProjects] = useState<FieldProject[]>([]);
  const [starred, setStarred] = useState<FieldProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [search, setSearch] = useState("");

  async function loadProjects({ quiet = false } = {}) {
    if (quiet) setRefreshing(true);
    else setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ status: "active", page: "1", perPage: "50" });
      if (search.trim()) params.set("search", search.trim());
      const [projectResult, starredResult] = await Promise.all([
        api<{ projects: FieldProject[] }>(`/field/projects?${params}`),
        search.trim() ? Promise.resolve({ projects: [] }) : api<{ projects: FieldProject[] }>("/field/projects/starred"),
      ]);
      setProjects(projectResult.projects);
      setStarred(starredResult.projects);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load projects");
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }

  useEffect(() => {
    const timer = window.setTimeout(() => void loadProjects(), search ? 200 : 0);
    return () => window.clearTimeout(timer);
  }, [search]);

  async function toggleStar(project: FieldProject) {
    const nextStarred = !project.starred;
    setProjects((current) => current.map((item) => item.id === project.id ? { ...item, starred: nextStarred } : item));
    setStarred((current) => nextStarred
      ? [{ ...project, starred: true }, ...current.filter((item) => item.id !== project.id)]
      : current.filter((item) => item.id !== project.id));
    try {
      await api(`/field/projects/${project.id}/star`, { method: nextStarred ? "POST" : "DELETE" });
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to update star");
      void loadProjects({ quiet: true });
    }
  }

  const showingSearch = search.trim().length > 0;
  const activeProjects = useMemo(
    () => projects.filter((project) => !starred.some((star) => star.id === project.id)),
    [projects, starred]
  );

  return (
    <section className="space-y-4">
      <header>
        <h1 className="text-3xl font-black">Projects</h1>
      </header>

      {/* Always-visible search at the top — a prominent field, not a tap-to-open icon. */}
      <div className="relative">
        <Search className="pointer-events-none absolute left-4 top-1/2 h-5 w-5 -translate-y-1/2 text-muted-foreground" />
        <TextInput
          value={search}
          onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
          placeholder="Search name, deal #, or address"
          aria-label="Search projects"
          className="min-h-14 pl-12 pr-12 text-lg"
        />
        {search ? (
          <button
            type="button"
            className="absolute right-3 top-1/2 flex h-8 w-8 -translate-y-1/2 items-center justify-center rounded-full text-muted-foreground hover:bg-muted"
            aria-label="Clear search"
            onClick={() => setSearch("")}
          >
            <X className="h-5 w-5" />
          </button>
        ) : null}
      </div>

      <Button variant="ghost" className="w-full border border-border" onClick={() => void loadProjects({ quiet: true })} disabled={refreshing}>
        {refreshing ? "Refreshing..." : "Pull to refresh"}
      </Button>

      {error ? <p className="rounded-md bg-red-50 p-3 text-sm font-semibold text-red-700">{error}</p> : null}

      {loading ? (
        <div className="space-y-3" aria-label="Loading projects">
          {Array.from({ length: 4 }).map((_, index) => <div key={index} className="h-24 animate-pulse rounded-md bg-muted" />)}
        </div>
      ) : showingSearch ? (
        <ProjectSection
          title="RESULTS"
          projects={projects}
          empty={`No projects match "${search.trim()}".`}
          onToggleStar={toggleStar}
          writableOfficeId={writableOfficeId}
        />
      ) : (
        <>
          {starred.length > 0 ? <ProjectSection title="STARRED" projects={starred} onToggleStar={toggleStar} writableOfficeId={writableOfficeId} /> : null}
          {starred.length > 0 ? <div className="h-px bg-border" /> : null}
          <ProjectSection title="ALL ACTIVE" projects={activeProjects} empty="No active projects yet." onToggleStar={toggleStar} writableOfficeId={writableOfficeId} />
        </>
      )}
    </section>
  );
}

function ProjectSection({
  title,
  projects,
  empty,
  onToggleStar,
  writableOfficeId,
}: {
  title: string;
  projects: FieldProject[];
  empty?: string;
  onToggleStar: (project: FieldProject) => void;
  writableOfficeId: string | undefined;
}) {
  return (
    <section>
      <p className="mb-1 text-xs font-black tracking-[0.18em] text-muted-foreground">{title}</p>
      {projects.length === 0 ? (
        <p className="rounded-md bg-muted p-4 text-sm font-medium text-muted-foreground">{empty}</p>
      ) : (
        <div className="border-y border-border">
          {projects.map((project) => (
            <ProjectCard key={project.id} project={project} onToggleStar={onToggleStar} writableOfficeId={writableOfficeId} />
          ))}
        </div>
      )}
    </section>
  );
}
