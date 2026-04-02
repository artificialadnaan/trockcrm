import { useState } from "react";
import {
  useSavedReports,
  executeLockedReport,
  executeCustomReport,
  createSavedReport,
  deleteSavedReport,
  type SavedReport,
  type ReportConfig,
} from "@/hooks/use-reports";
import { ReportChart } from "@/components/charts/report-chart";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Lock, Plus, Trash2, Save } from "lucide-react";

export function ReportsPage() {
  const { reports, loading, refetch } = useSavedReports();
  const [activeReport, setActiveReport] = useState<SavedReport | null>(null);
  const [reportData, setReportData] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);
  const [showBuilder, setShowBuilder] = useState(false);

  // Custom report builder state
  const [builderEntity, setBuilderEntity] = useState<string>("deals");
  const [builderName, setBuilderName] = useState("");
  const [builderChartType, setBuilderChartType] = useState<string>("table");

  const lockedReports = reports.filter((r) => r.isLocked);
  const customReports = reports.filter((r) => !r.isLocked);

  async function runReport(report: SavedReport) {
    setActiveReport(report);
    setReportData(null);
    setReportLoading(true);

    try {
      const config = report.config as any;
      if (report.isLocked && config.reportType) {
        const result = await executeLockedReport(config.reportType, {
          includeDd: config.includeDd,
        });
        setReportData(result.data);
      } else {
        const result = await executeCustomReport(config as ReportConfig);
        setReportData(result.rows);
      }
    } catch (err) {
      console.error("Failed to run report:", err);
    } finally {
      setReportLoading(false);
    }
  }

  async function handleSaveReport() {
    if (!builderName.trim()) return;

    const config: ReportConfig = {
      entity: builderEntity as any,
      filters: [],
      columns: [],
      chart_type: builderChartType as any,
    };

    try {
      await createSavedReport({
        name: builderName,
        entity: builderEntity,
        config,
      });
      setShowBuilder(false);
      setBuilderName("");
      refetch();
    } catch (err) {
      console.error("Failed to save report:", err);
    }
  }

  async function handleDeleteReport(reportId: string) {
    try {
      await deleteSavedReport(reportId);
      if (activeReport?.id === reportId) {
        setActiveReport(null);
        setReportData(null);
      }
      refetch();
    } catch (err) {
      console.error("Failed to delete report:", err);
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-2xl font-bold">Reports</h2>
        <Button onClick={() => setShowBuilder(true)} size="sm">
          <Plus className="h-4 w-4 mr-1" /> New Report
        </Button>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Report List Sidebar */}
        <div className="space-y-4">
          {/* Locked Reports */}
          <Card>
            <CardHeader className="py-3">
              <CardTitle className="text-sm flex items-center gap-2">
                <Lock className="h-3.5 w-3.5" />
                Company Reports
              </CardTitle>
            </CardHeader>
            <CardContent className="p-0">
              {lockedReports.map((report) => (
                <button
                  key={report.id}
                  onClick={() => runReport(report)}
                  className={`w-full text-left px-4 py-2.5 text-sm border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                    activeReport?.id === report.id ? "bg-slate-100 font-medium" : ""
                  }`}
                >
                  {report.name}
                </button>
              ))}
              {lockedReports.length === 0 && !loading && (
                <p className="text-xs text-muted-foreground p-4">
                  No locked reports. Ask an admin to seed them.
                </p>
              )}
            </CardContent>
          </Card>

          {/* Custom Reports */}
          {customReports.length > 0 && (
            <Card>
              <CardHeader className="py-3">
                <CardTitle className="text-sm">My Reports</CardTitle>
              </CardHeader>
              <CardContent className="p-0">
                {customReports.map((report) => (
                  <div
                    key={report.id}
                    className={`flex items-center justify-between px-4 py-2.5 border-b last:border-b-0 hover:bg-slate-50 transition-colors ${
                      activeReport?.id === report.id ? "bg-slate-100" : ""
                    }`}
                  >
                    <button
                      onClick={() => runReport(report)}
                      className="text-sm text-left flex-1 truncate"
                    >
                      {report.name}
                    </button>
                    <Button
                      variant="ghost"
                      size="icon"
                      className="h-7 w-7 shrink-0"
                      onClick={(e) => {
                        e.stopPropagation();
                        handleDeleteReport(report.id);
                      }}
                    >
                      <Trash2 className="h-3.5 w-3.5 text-muted-foreground" />
                    </Button>
                  </div>
                ))}
              </CardContent>
            </Card>
          )}
        </div>

        {/* Report Results Area */}
        <div className="lg:col-span-2">
          {!activeReport && !reportLoading && (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                <BarChartIcon className="h-12 w-12 mx-auto mb-3 opacity-30" />
                <p>Select a report from the left to view results.</p>
              </CardContent>
            </Card>
          )}

          {reportLoading && (
            <Card>
              <CardContent className="p-12 text-center text-muted-foreground">
                Loading report...
              </CardContent>
            </Card>
          )}

          {activeReport && reportData && !reportLoading && (
            <Card>
              <CardHeader>
                <div className="flex items-center justify-between">
                  <CardTitle className="flex items-center gap-2">
                    {activeReport.name}
                    {activeReport.isLocked && (
                      <Badge variant="secondary" className="text-xs">
                        <Lock className="h-3 w-3 mr-1" /> Locked
                      </Badge>
                    )}
                  </CardTitle>
                </div>
              </CardHeader>
              <CardContent>
                <ReportChart
                  data={reportData}
                  chartType={(activeReport.config as any)?.chart_type ?? "table"}
                  reportType={(activeReport.config as any)?.reportType}
                />
              </CardContent>
            </Card>
          )}
        </div>
      </div>

      {/* Create Report Dialog */}
      <Dialog open={showBuilder} onOpenChange={setShowBuilder}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Create Custom Report</DialogTitle>
          </DialogHeader>
          <div className="space-y-4">
            <div>
              <label className="text-sm font-medium">Report Name</label>
              <Input
                value={builderName}
                onChange={(e) => setBuilderName(e.target.value)}
                placeholder="Q1 Pipeline Review"
              />
            </div>
            <div>
              <label className="text-sm font-medium">Entity</label>
              <Select value={builderEntity} onValueChange={(v) => { if (v) setBuilderEntity(v); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="deals">Deals</SelectItem>
                  <SelectItem value="contacts">Contacts</SelectItem>
                  <SelectItem value="activities">Activities</SelectItem>
                  <SelectItem value="tasks">Tasks</SelectItem>
                </SelectContent>
              </Select>
            </div>
            <div>
              <label className="text-sm font-medium">Chart Type</label>
              <Select value={builderChartType} onValueChange={(v) => { if (v) setBuilderChartType(v); }}>
                <SelectTrigger>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="table">Table</SelectItem>
                  <SelectItem value="bar">Bar Chart</SelectItem>
                  <SelectItem value="pie">Pie Chart</SelectItem>
                  <SelectItem value="line">Line Chart</SelectItem>
                </SelectContent>
              </Select>
            </div>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setShowBuilder(false)}>
              Cancel
            </Button>
            <Button onClick={handleSaveReport} disabled={!builderName.trim()}>
              <Save className="h-4 w-4 mr-1" /> Save Report
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

function BarChartIcon({ className }: { className?: string }) {
  return (
    <svg className={className} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
      <rect x="3" y="12" width="4" height="9" rx="1" />
      <rect x="10" y="6" width="4" height="15" rx="1" />
      <rect x="17" y="3" width="4" height="18" rx="1" />
    </svg>
  );
}
