import { useState, useEffect, useCallback } from "react";
import { api } from "@/lib/api";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import {
  Camera,
  Link,
  Unlink,
  RefreshCw,
  Loader2,
  CheckCircle,
  AlertCircle,
  Zap,
  Image,
} from "lucide-react";

interface ProjectMapping {
  ccProjectId: string;
  ccProjectName: string;
  ccPhotoCount: number;
  ccCity: string | null;
  dealId: string | null;
  dealNumber: string | null;
  dealName: string | null;
  matchType: "linked" | "auto" | "unmatched";
}

interface SyncStatus {
  running: boolean;
  startedAt: string | null;
  progress: string;
  results: Array<{
    projectName: string;
    photosImported: number;
    photosSkipped: number;
    errors: string[];
  }> | null;
  error: string | null;
}

const MATCH_COLORS: Record<string, string> = {
  linked: "bg-green-100 text-green-800",
  auto: "bg-blue-100 text-blue-800",
  unmatched: "bg-gray-100 text-gray-600",
};

const MATCH_LABELS: Record<string, string> = {
  linked: "Linked",
  auto: "Auto-Match",
  unmatched: "Unmatched",
};

export function CompanyCamPage() {
  const [mappings, setMappings] = useState<ProjectMapping[]>([]);
  const [syncStatus, setSyncStatus] = useState<SyncStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [actionLoading, setActionLoading] = useState<string | null>(null);

  const fetchMappings = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await api<{ mappings: ProjectMapping[] }>("/companycam/mappings");
      setMappings(data.mappings);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load mappings");
    } finally {
      setLoading(false);
    }
  }, []);

  const fetchSyncStatus = useCallback(async () => {
    try {
      const data = await api<SyncStatus>("/companycam/sync-status");
      setSyncStatus(data);
      return data.running;
    } catch {
      return false;
    }
  }, []);

  useEffect(() => {
    fetchMappings();
    fetchSyncStatus();
  }, [fetchMappings, fetchSyncStatus]);

  // Poll sync status while running
  useEffect(() => {
    if (!syncStatus?.running) return;
    const interval = setInterval(async () => {
      const stillRunning = await fetchSyncStatus();
      if (!stillRunning) {
        clearInterval(interval);
        fetchMappings(); // Refresh mappings after sync completes
      }
    }, 3000);
    return () => clearInterval(interval);
  }, [syncStatus?.running, fetchSyncStatus, fetchMappings]);

  const handleAutoImport = async () => {
    setActionLoading("auto-import");
    try {
      await api("/companycam/auto-import", { method: "POST" });
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start import");
    } finally {
      setActionLoading(null);
    }
  };

  const handleSyncAll = async () => {
    setActionLoading("sync-all");
    try {
      await api("/companycam/sync-all", { method: "POST" });
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sync");
    } finally {
      setActionLoading(null);
    }
  };

  const handleSyncProject = async (projectId: string) => {
    setActionLoading(projectId);
    try {
      await api(`/companycam/sync/${projectId}`, { method: "POST" });
      await fetchSyncStatus();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start sync");
    } finally {
      setActionLoading(null);
    }
  };

  const handleLink = async (ccProjectId: string, dealId: string) => {
    setActionLoading(`link-${ccProjectId}`);
    try {
      await api("/companycam/link", { method: "POST", json: { ccProjectId, dealId } });
      await fetchMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to link");
    } finally {
      setActionLoading(null);
    }
  };

  const handleUnlink = async (ccProjectId: string) => {
    setActionLoading(`unlink-${ccProjectId}`);
    try {
      await api("/companycam/unlink", { method: "POST", json: { ccProjectId } });
      await fetchMappings();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to unlink");
    } finally {
      setActionLoading(null);
    }
  };

  // Stats
  const linked = mappings.filter((m) => m.matchType === "linked").length;
  const autoMatched = mappings.filter((m) => m.matchType === "auto").length;
  const unmatched = mappings.filter((m) => m.matchType === "unmatched").length;
  const totalPhotos = mappings.reduce((sum, m) => sum + m.ccPhotoCount, 0);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold flex items-center gap-2">
            <Camera className="h-6 w-6" />
            CompanyCam Integration
          </h1>
          <p className="text-sm text-muted-foreground mt-1">
            Import and sync project photos from CompanyCam into your deals.
          </p>
        </div>
        <div className="flex gap-2">
          <Button
            variant="outline"
            size="sm"
            onClick={handleSyncAll}
            disabled={syncStatus?.running || !!actionLoading}
          >
            <RefreshCw className={`h-4 w-4 mr-2 ${syncStatus?.running ? "animate-spin" : ""}`} />
            Sync Linked
          </Button>
          <Button
            size="sm"
            onClick={handleAutoImport}
            disabled={syncStatus?.running || !!actionLoading}
          >
            {actionLoading === "auto-import" ? (
              <Loader2 className="h-4 w-4 mr-2 animate-spin" />
            ) : (
              <Zap className="h-4 w-4 mr-2" />
            )}
            Auto-Import All
          </Button>
        </div>
      </div>

      {error && (
        <div className="p-3 bg-red-50 text-red-700 rounded-lg text-sm flex items-center gap-2">
          <AlertCircle className="h-4 w-4 flex-shrink-0" />
          {error}
          <button onClick={() => setError(null)} className="ml-auto text-red-500 hover:text-red-700 text-xs">dismiss</button>
        </div>
      )}

      {/* Sync Status Banner */}
      {syncStatus?.running && (
        <Card className="border-blue-200 bg-blue-50">
          <CardContent className="py-3 flex items-center gap-3">
            <Loader2 className="h-5 w-5 animate-spin text-blue-600" />
            <div>
              <p className="text-sm font-medium text-blue-800">{syncStatus.progress}</p>
              <p className="text-xs text-blue-600">
                Photos are being downloaded to R2 storage. This page will update automatically.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {/* Last Sync Results */}
      {syncStatus && !syncStatus.running && syncStatus.results && (
        <Card className="border-green-200 bg-green-50">
          <CardContent className="py-3">
            <div className="flex items-center gap-2 mb-2">
              <CheckCircle className="h-4 w-4 text-green-600" />
              <p className="text-sm font-medium text-green-800">{syncStatus.progress}</p>
            </div>
            <div className="space-y-1">
              {syncStatus.results.map((r, i) => (
                <p key={i} className="text-xs text-green-700">
                  {r.projectName}: {r.photosImported} imported, {r.photosSkipped} skipped
                  {r.errors.length > 0 && `, ${r.errors.length} errors`}
                </p>
              ))}
            </div>
          </CardContent>
        </Card>
      )}

      {syncStatus?.error && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="py-3 flex items-center gap-2">
            <AlertCircle className="h-4 w-4 text-red-600" />
            <p className="text-sm text-red-800">{syncStatus.error}</p>
          </CardContent>
        </Card>
      )}

      {/* Stats */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold">{mappings.length}</p>
            <p className="text-xs text-muted-foreground">CC Projects</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-green-600">{linked}</p>
            <p className="text-xs text-muted-foreground">Linked</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold text-blue-600">{autoMatched}</p>
            <p className="text-xs text-muted-foreground">Auto-Matched</p>
          </CardContent>
        </Card>
        <Card>
          <CardContent className="py-3 text-center">
            <p className="text-2xl font-bold">{totalPhotos.toLocaleString()}</p>
            <p className="text-xs text-muted-foreground">Total Photos</p>
          </CardContent>
        </Card>
      </div>

      {/* Project Mappings List */}
      {loading ? (
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <div key={i} className="h-16 bg-muted animate-pulse rounded-lg" />
          ))}
        </div>
      ) : (
        <div className="space-y-2">
          {mappings.map((mapping) => (
            <Card key={mapping.ccProjectId} className="hover:bg-muted/30 transition-colors">
              <CardContent className="py-3 flex items-center justify-between gap-4">
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 mb-1">
                    <p className="font-medium text-sm truncate">{mapping.ccProjectName}</p>
                    <Badge variant="outline" className={`${MATCH_COLORS[mapping.matchType]} border-0 text-[10px] flex-shrink-0`}>
                      {MATCH_LABELS[mapping.matchType]}
                    </Badge>
                  </div>
                  <div className="flex items-center gap-3 text-xs text-muted-foreground">
                    <span className="flex items-center gap-1">
                      <Image className="h-3 w-3" />
                      {mapping.ccPhotoCount} photos
                    </span>
                    {mapping.ccCity && <span>{mapping.ccCity}</span>}
                    {mapping.dealName && (
                      <span className="truncate">
                        → <span className="font-medium text-foreground">{mapping.dealNumber}</span> {mapping.dealName}
                      </span>
                    )}
                  </div>
                </div>

                <div className="flex items-center gap-2 flex-shrink-0">
                  {/* Auto-match: confirm link */}
                  {mapping.matchType === "auto" && mapping.dealId && (
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => handleLink(mapping.ccProjectId, mapping.dealId!)}
                      disabled={!!actionLoading}
                    >
                      {actionLoading === `link-${mapping.ccProjectId}` ? (
                        <Loader2 className="h-3 w-3 animate-spin" />
                      ) : (
                        <Link className="h-3 w-3 mr-1" />
                      )}
                      Confirm
                    </Button>
                  )}

                  {/* Linked: sync or unlink */}
                  {mapping.matchType === "linked" && (
                    <>
                      <Button
                        variant="outline"
                        size="sm"
                        onClick={() => handleSyncProject(mapping.ccProjectId)}
                        disabled={syncStatus?.running || !!actionLoading}
                      >
                        {actionLoading === mapping.ccProjectId ? (
                          <Loader2 className="h-3 w-3 animate-spin" />
                        ) : (
                          <RefreshCw className="h-3 w-3 mr-1" />
                        )}
                        Sync
                      </Button>
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => handleUnlink(mapping.ccProjectId)}
                        disabled={!!actionLoading}
                        className="text-muted-foreground hover:text-red-600"
                      >
                        <Unlink className="h-3 w-3" />
                      </Button>
                    </>
                  )}
                </div>
              </CardContent>
            </Card>
          ))}

          {mappings.length === 0 && !loading && (
            <div className="text-center py-12 text-muted-foreground">
              <Camera className="h-10 w-10 mx-auto mb-3 opacity-30" />
              <p className="text-sm">No CompanyCam projects with photos found.</p>
              <p className="text-xs mt-1">Make sure COMPANYCAM_API_KEY is configured.</p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
