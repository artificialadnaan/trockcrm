import { useEffect, useState } from "react";
import type { ComponentType } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ArrowLeft, Building2, CalendarDays, FileText, History, Link2, Users } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency } from "@/lib/deal-utils";
import { useProjectDetail } from "@/hooks/use-projects";
import type { ProjectDetail } from "@/hooks/use-projects";

type ProjectTab = "overview" | "team" | "documents" | "phase-history" | "source-deal";

function formatDate(value: string | null | undefined) {
  if (!value) return "Not set";
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric", year: "numeric" }).format(new Date(value));
}

function formatDateTime(value: string | null | undefined) {
  if (!value) return "Not synced";
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(new Date(value));
}

function formatMoney(value: string | null | undefined) {
  if (value == null) return "--";
  return formatCurrency(value);
}

function addressLines(project: ProjectDetail) {
  const line = [project.address.line1, project.address.line2].filter(Boolean).join(" ");
  const cityLine = [project.address.city, project.address.state, project.address.postalCode].filter(Boolean).join(", ");
  return [line, cityLine, project.address.country].filter(Boolean);
}

function DetailItem({ label, value }: { label: string; value: string | null | undefined }) {
  return (
    <div>
      <dt className="text-xs uppercase text-muted-foreground">{label}</dt>
      <dd className="mt-1 text-sm font-medium text-foreground">{value || "--"}</dd>
    </div>
  );
}

export function ProjectDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { project, team, documents, phaseHistory, loading, error } = useProjectDetail(id);
  const [activeTab, setActiveTab] = useState<ProjectTab>("overview");

  useEffect(() => {
    setActiveTab("overview");
  }, [id]);

  if (loading) {
    return (
      <div className="space-y-6">
        <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => navigate("/projects")}>
          <ArrowLeft className="mr-1 h-4 w-4" />
          Projects
        </Button>
        <div className="h-32 rounded-md border border-slate-200 bg-white p-6 text-sm text-muted-foreground">
          Loading project...
        </div>
      </div>
    );
  }

  if (error || !project) {
    return (
      <div className="py-12 text-center">
        <p className="text-red-600">{error ?? "Project not found"}</p>
        <Button variant="outline" className="mt-4" onClick={() => navigate("/projects")}>
          Back to Projects
        </Button>
      </div>
    );
  }

  const tabs: Array<{ id: ProjectTab; label: string; icon: ComponentType<{ className?: string }> }> = [
    { id: "overview", label: "Overview", icon: Building2 },
    { id: "team", label: "Team", icon: Users },
    { id: "documents", label: "Documents", icon: FileText },
    { id: "phase-history", label: "Phase History", icon: History },
    { id: "source-deal", label: "Source Deal", icon: Link2 },
  ];

  return (
    <div className="space-y-6">
      <Button variant="ghost" size="sm" className="-ml-2 w-fit" onClick={() => navigate("/projects")}>
        <ArrowLeft className="mr-1 h-4 w-4" />
        Projects
      </Button>

      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <h1 className="text-3xl font-semibold tracking-tight text-foreground">{project.name}</h1>
            <Badge variant="outline" className="border-red-200 bg-red-50 text-red-800">
              {project.currentPhaseName ?? "Unassigned"}
            </Badge>
          </div>
          <div className="flex flex-wrap items-center gap-3 text-sm text-muted-foreground">
            <span className="font-mono">{project.procoreProjectNumber ?? "No project number"}</span>
            <span>Last synced {formatDateTime(project.lastSyncedAt)}</span>
            {project.sourceDeal ? (
              <Link to={`/deals/${project.sourceDeal.id}`} className="text-brand-red hover:underline">
                Source deal {project.sourceDeal.dealNumber ?? project.sourceDeal.name}
              </Link>
            ) : (
              <span>No source deal linked</span>
            )}
          </div>
        </div>
      </div>

      <div className="grid gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
        <div className="space-y-6">
          <div
            className="flex flex-wrap gap-2 border-b border-slate-200"
            role="tablist"
            aria-label="Project detail tabs"
          >
            {tabs.map((tab) => {
              const Icon = tab.icon;
              return (
                <button
                  key={tab.id}
                  type="button"
                  role="tab"
                  aria-selected={activeTab === tab.id}
                  aria-controls={`project-${tab.id}-panel`}
                  id={`project-${tab.id}-tab`}
                  className={`inline-flex items-center gap-2 border-b-2 px-3 py-2 text-sm font-medium ${
                    activeTab === tab.id
                      ? "border-brand-red text-brand-red"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                  onClick={() => setActiveTab(tab.id)}
                >
                  <Icon className="h-4 w-4" />
                  {tab.label}
                </button>
              );
            })}
          </div>

          {activeTab === "overview" ? (
            <section
              id="project-overview-panel"
              role="tabpanel"
              aria-labelledby="project-overview-tab"
              className="grid gap-4 md:grid-cols-2"
            >
              <Card>
                <CardHeader>
                  <CardTitle>Project Metadata</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-4">
                    <DetailItem label="Description" value={project.description} />
                    <DetailItem label="Sync source" value={project.syncSource} />
                    <DetailItem label="Procore updated" value={formatDateTime(project.procoreUpdatedAt)} />
                  </dl>
                </CardContent>
              </Card>
              <Card>
                <CardHeader>
                  <CardTitle>Financials</CardTitle>
                </CardHeader>
                <CardContent>
                  <dl className="grid gap-4">
                    <DetailItem label="Contract value" value={formatMoney(project.contractValue)} />
                    <DetailItem label="Estimated value" value={formatMoney(project.estimatedValue)} />
                    <DetailItem label="Actual cost" value={formatMoney(project.actualCost)} />
                  </dl>
                </CardContent>
              </Card>
            </section>
          ) : null}

          {activeTab === "team" ? (
            <section
              id="project-team-panel"
              role="tabpanel"
              aria-labelledby="project-team-tab"
              className="rounded-md border border-slate-200 bg-white"
            >
              {team.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No project team has been mirrored yet.</div>
              ) : (
                <div className="divide-y divide-slate-200">
                  {team.map((member) => (
                    <div key={member.id} className="flex items-center justify-between gap-4 p-4">
                      <div>
                        <p className="font-medium text-foreground">{member.procore_user_name ?? "Unnamed user"}</p>
                        <p className="text-sm text-muted-foreground">{member.procore_user_email ?? "No email"}</p>
                      </div>
                      <Badge variant="outline">{member.role_name ?? "Team"}</Badge>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "documents" ? (
            <section
              id="project-documents-panel"
              role="tabpanel"
              aria-labelledby="project-documents-tab"
              className="rounded-md border border-slate-200 bg-white"
            >
              {documents.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No Procore documents have been mirrored yet.</div>
              ) : (
                <div className="divide-y divide-slate-200">
                  {documents.map((document) => (
                    <div key={document.id} className="flex items-center justify-between gap-4 p-4">
                      <div>
                        <p className="font-medium text-foreground">{document.name}</p>
                        <p className="text-sm text-muted-foreground">{document.folder_path ?? "Root folder"}</p>
                      </div>
                      {document.file_url ? (
                        <a href={document.file_url} target="_blank" rel="noreferrer" className="text-sm text-brand-red hover:underline">
                          Open
                        </a>
                      ) : null}
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "phase-history" ? (
            <section
              id="project-phase-history-panel"
              role="tabpanel"
              aria-labelledby="project-phase-history-tab"
              className="rounded-md border border-slate-200 bg-white"
            >
              {phaseHistory.length === 0 ? (
                <div className="p-6 text-sm text-muted-foreground">No phase history has been mirrored yet.</div>
              ) : (
                <div className="divide-y divide-slate-200">
                  {phaseHistory.map((item) => (
                    <div key={item.id} className="p-4">
                      <p className="font-medium text-foreground">
                        {item.from_phase_name ? `${item.from_phase_name} -> ${item.to_phase_name}` : `Entered ${item.to_phase_name}`}
                      </p>
                      <p className="mt-1 text-sm text-muted-foreground">
                        {formatDateTime(item.changed_at)}
                        {item.changed_by_procore_user_name ? ` by ${item.changed_by_procore_user_name}` : ""}
                      </p>
                    </div>
                  ))}
                </div>
              )}
            </section>
          ) : null}

          {activeTab === "source-deal" ? (
            <section
              id="project-source-deal-panel"
              role="tabpanel"
              aria-labelledby="project-source-deal-tab"
              className="rounded-md border border-slate-200 bg-white p-6"
            >
              {project.sourceDeal ? (
                <div className="space-y-2">
                  <p className="text-sm text-muted-foreground">CRM deal that created or matched this Procore project.</p>
                  <Link to={`/deals/${project.sourceDeal.id}`} className="text-brand-red hover:underline">
                    {project.sourceDeal.dealNumber ?? project.sourceDeal.name ?? "Open source deal"}
                  </Link>
                </div>
              ) : (
                <p className="text-sm text-muted-foreground">This Procore project is not linked to a CRM deal.</p>
              )}
            </section>
          ) : null}
        </div>

        <aside className="space-y-4">
          <Card>
            <CardHeader>
              <CardTitle>Key Dates</CardTitle>
            </CardHeader>
            <CardContent>
              <dl className="grid gap-4">
                <DetailItem label="Start" value={formatDate(project.startDate)} />
                <DetailItem label="Completion" value={formatDate(project.completionDate)} />
                <DetailItem label="Projected finish" value={formatDate(project.projectedFinishDate)} />
                <DetailItem label="Warranty end" value={formatDate(project.warrantyEndDate)} />
              </dl>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Owner</CardTitle>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center gap-3">
                <span className="flex size-10 items-center justify-center rounded-full bg-slate-100 text-sm font-bold text-slate-600">
                  {(project.projectOwnerName ?? "U").slice(0, 1).toUpperCase()}
                </span>
                <div>
                  <p className="font-medium text-foreground">{project.projectOwnerName ?? "No owner"}</p>
                  <p className="text-xs text-muted-foreground">Procore project owner</p>
                </div>
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>Address</CardTitle>
            </CardHeader>
            <CardContent className="space-y-2 text-sm text-muted-foreground">
              {addressLines(project).length > 0 ? (
                addressLines(project).map((line) => <p key={line}>{line}</p>)
              ) : (
                <p>No address mirrored yet.</p>
              )}
            </CardContent>
          </Card>
          <div className="flex items-center gap-2 text-xs text-muted-foreground">
            <CalendarDays className="h-3.5 w-3.5" />
            Display-only mirror. Procore remains the system of record.
          </div>
        </aside>
      </div>
    </div>
  );
}
