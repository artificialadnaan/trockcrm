import { useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { Search, Star, X } from "lucide-react";
import { api } from "@/lib/api";
import { Button, TextInput } from "@/components/ui";
import { type FieldProject, relativeDate } from "@/lib/field-projects";

function ProjectCard({ project, onToggleStar }: { project: FieldProject; onToggleStar: (project: FieldProject) => void }) {
  return (
    <Link
      to={`/projects/${project.id}`}
      className="block border-b border-border bg-white py-4 active:bg-muted"
      aria-label={`Open ${project.name}`}
    >
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1">
          <h2 className="truncate text-lg font-bold">{project.name}</h2>
          <p className="truncate text-sm text-muted-foreground">{project.propertyAddress || "No address on file"}</p>
          <p className="mt-2 text-sm font-medium text-muted-foreground">
            {project.photoCount} photos • {relativeDate(project.lastActivityAt)}
          </p>
        </div>
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
      </div>
    </Link>
  );
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<FieldProject[]>([]);
  const [starred, setStarred] = useState<FieldProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchOpen, setSearchOpen] = useState(false);
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
      <header className="flex items-center justify-between gap-3">
        <h1 className="text-3xl font-black">Projects</h1>
        <button
          type="button"
          className="flex min-h-11 min-w-11 items-center justify-center rounded-full bg-muted text-foreground"
          aria-label={searchOpen ? "Close search" : "Search projects"}
          onClick={() => {
            setSearchOpen((open) => !open);
            if (searchOpen) setSearch("");
          }}
        >
          {searchOpen ? <X className="h-5 w-5" /> : <Search className="h-5 w-5" />}
        </button>
      </header>

      {searchOpen ? (
        <TextInput
          autoFocus
          value={search}
          onInput={(event) => setSearch((event.target as HTMLInputElement).value)}
          placeholder="Search name or address"
          aria-label="Search projects"
        />
      ) : null}

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
        />
      ) : (
        <>
          {starred.length > 0 ? <ProjectSection title="STARRED" projects={starred} onToggleStar={toggleStar} /> : null}
          {starred.length > 0 ? <div className="h-px bg-border" /> : null}
          <ProjectSection title="ALL ACTIVE" projects={activeProjects} empty="No active projects yet." onToggleStar={toggleStar} />
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
}: {
  title: string;
  projects: FieldProject[];
  empty?: string;
  onToggleStar: (project: FieldProject) => void;
}) {
  return (
    <section>
      <p className="mb-1 text-xs font-black tracking-[0.18em] text-muted-foreground">{title}</p>
      {projects.length === 0 ? (
        <p className="rounded-md bg-muted p-4 text-sm font-medium text-muted-foreground">{empty}</p>
      ) : (
        <div className="border-y border-border">
          {projects.map((project) => <ProjectCard key={project.id} project={project} onToggleStar={onToggleStar} />)}
        </div>
      )}
    </section>
  );
}
