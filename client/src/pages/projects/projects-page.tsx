import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import { Building2, ExternalLink, RefreshCw, Search } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { api } from "@/lib/api";
import { formatCurrency } from "@/lib/deal-utils";

interface ProcoreProject {
  id: string;
  deal_number: string;
  name: string;
  procore_project_id: number;
  procore_last_synced_at: string | null;
  change_order_total: string | null;
  stage_name: string;
  stage_color: string;
}

export function ProjectsPage() {
  const [projects, setProjects] = useState<ProcoreProject[]>([]);
  const [loading, setLoading] = useState(true);
  const [search, setSearch] = useState("");

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api<{ deals: ProcoreProject[] }>("/procore/my-projects");
      setProjects(data.deals);
    } catch (err) {
      console.error("Failed to load projects:", err);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = search
    ? projects.filter(
        (p) =>
          p.name.toLowerCase().includes(search.toLowerCase()) ||
          p.deal_number.toLowerCase().includes(search.toLowerCase())
      )
    : projects;

  const procoreBaseUrl = "https://app.procore.com/projects";

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-gray-900 flex items-center gap-2">
            <Building2 className="h-6 w-6 text-blue-600" />
            Procore Projects
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Deals linked to Procore projects
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={load} disabled={loading}>
          <RefreshCw className={`h-4 w-4 mr-1 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      <div className="flex items-center gap-2">
        <div className="relative flex-1 max-w-sm">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-gray-400" />
          <Input
            placeholder="Search projects..."
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="pl-9"
          />
        </div>
        <span className="text-sm text-muted-foreground">
          {filtered.length} project{filtered.length !== 1 ? "s" : ""}
        </span>
      </div>

      {loading ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            Loading projects...
          </CardContent>
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <CardContent className="py-12 text-center text-muted-foreground">
            {search ? "No projects match your search" : "No Procore-linked projects found"}
          </CardContent>
        </Card>
      ) : (
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Deal #</TableHead>
              <TableHead>Project Name</TableHead>
              <TableHead>Stage</TableHead>
              <TableHead>Change Orders</TableHead>
              <TableHead>Last Synced</TableHead>
              <TableHead>Procore</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {filtered.map((project) => (
              <TableRow key={project.id}>
                <TableCell>
                  <Link
                    to={`/projects/${project.id}`}
                    className="font-mono text-sm text-blue-600 hover:underline"
                  >
                    {project.deal_number}
                  </Link>
                </TableCell>
                <TableCell className="font-medium max-w-[250px] truncate">
                  {project.name}
                </TableCell>
                <TableCell>
                  <Badge
                    className="text-xs"
                    style={{
                      backgroundColor: `${project.stage_color}20`,
                      color: project.stage_color,
                      borderColor: project.stage_color,
                    }}
                  >
                    {project.stage_name}
                  </Badge>
                </TableCell>
                <TableCell className="text-sm">
                  {project.change_order_total != null
                    ? formatCurrency(project.change_order_total)
                    : "--"}
                </TableCell>
                <TableCell className="text-sm text-muted-foreground">
                  {project.procore_last_synced_at
                    ? new Date(project.procore_last_synced_at).toLocaleDateString()
                    : "Never"}
                </TableCell>
                <TableCell>
                  <a
                    href={`${procoreBaseUrl}/${project.procore_project_id}`}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="inline-flex items-center gap-1 text-sm text-blue-600 hover:underline"
                  >
                    Open
                    <ExternalLink className="h-3 w-3" />
                  </a>
                </TableCell>
              </TableRow>
            ))}
          </TableBody>
        </Table>
      )}
    </div>
  );
}
