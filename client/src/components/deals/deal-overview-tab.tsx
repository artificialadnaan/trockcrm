import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { DealCopilotPanel } from "@/components/ai/deal-copilot-panel";
import { DealEstimatesCard } from "./deal-estimates-card";
import { DealStageBadge } from "./deal-stage-badge";
import { formatDate, daysInStage, winProbabilityColor, formatCurrency } from "@/lib/deal-utils";
import { useProjectTypes, useRegions } from "@/hooks/use-pipeline-config";
import type { DealDetail } from "@/hooks/use-deals";
import {
  MapPin,
  Calendar,
  Clock,
  FileText,
  TrendingUp,
} from "lucide-react";

interface DealOverviewTabProps {
  deal: DealDetail;
}

export function DealOverviewTab({ deal }: DealOverviewTabProps) {
  const { projectTypes } = useProjectTypes();
  const { regions } = useRegions();

  const projectType = projectTypes.find((t) => t.id === deal.projectTypeId);
  const region = regions.find((r) => r.id === deal.regionId);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
      {/* Left Column: Details */}
      <div className="lg:col-span-2 space-y-4">
        {/* Stage & Status */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">
              Stage & Status
            </CardTitle>
          </CardHeader>
          <CardContent>
            <div className="flex items-center gap-3 mb-4">
              <DealStageBadge stageId={deal.stageId} className="text-sm px-3 py-1" />
              <span className="text-sm text-muted-foreground flex items-center gap-1">
                <Clock className="h-3.5 w-3.5" />
                {daysInStage(deal.stageEnteredAt)} days in stage
              </span>
              {deal.winProbability != null && (
                <Badge
                  variant="outline"
                  className={winProbabilityColor(deal.winProbability)}
                >
                  <TrendingUp className="h-3 w-3 mr-1" />
                  {deal.winProbability}%
                </Badge>
              )}
            </div>

            {deal.description && (
              <p className="text-sm text-muted-foreground">{deal.description}</p>
            )}
          </CardContent>
        </Card>

        {/* Property Info */}
        {(deal.propertyAddress || deal.propertyCity) && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <MapPin className="h-4 w-4" />
                Property
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-1">
              {deal.propertyAddress && <p>{deal.propertyAddress}</p>}
              {deal.propertyCity && (
                <p>
                  {deal.propertyCity}, {deal.propertyState} {deal.propertyZip}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {/* Metadata */}
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-sm font-medium text-muted-foreground">Details</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid grid-cols-2 gap-4 text-sm">
              <div>
                <span className="text-muted-foreground">Deal Number</span>
                <p className="font-mono font-medium">{deal.dealNumber}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Source</span>
                <p>{deal.source ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Project Type</span>
                <p>{projectType?.name ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Region</span>
                <p>{region?.name ?? "--"}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Expected Close</span>
                <p className="flex items-center gap-1">
                  <Calendar className="h-3.5 w-3.5 text-muted-foreground" />
                  {formatDate(deal.expectedCloseDate)}
                </p>
              </div>
              <div>
                <span className="text-muted-foreground">Actual Close</span>
                <p>{formatDate(deal.actualCloseDate)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Created</span>
                <p>{formatDate(deal.createdAt)}</p>
              </div>
              <div>
                <span className="text-muted-foreground">Last Activity</span>
                <p>{formatDate(deal.lastActivityAt)}</p>
              </div>
            </div>
          </CardContent>
        </Card>

        {/* Change Orders */}
        {deal.changeOrders.length > 0 && (
          <Card>
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-muted-foreground flex items-center gap-2">
                <FileText className="h-4 w-4" />
                Change Orders ({deal.changeOrders.length})
              </CardTitle>
            </CardHeader>
            <CardContent>
              <div className="space-y-2">
                {deal.changeOrders.map((co) => (
                  <div
                    key={co.id}
                    className="flex items-center justify-between py-2 border-b last:border-0"
                  >
                    <div>
                      <span className="text-sm font-medium">CO #{co.coNumber}</span>
                      <span className="text-sm text-muted-foreground ml-2">
                        {co.title}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium">
                        {parseFloat(co.amount) >= 0 ? "+" : ""}
                        {formatCurrency(co.amount)}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          co.status === "approved"
                            ? "bg-green-100 text-green-700"
                            : co.status === "rejected"
                            ? "bg-red-100 text-red-700"
                            : "bg-yellow-100 text-yellow-700"
                        }
                      >
                        {co.status}
                      </Badge>
                    </div>
                  </div>
                ))}
              </div>
            </CardContent>
          </Card>
        )}

        {/* Lost Deal Info */}
        {deal.lostReasonId && (
          <Card className="border-red-200 bg-red-50/50">
            <CardHeader className="pb-3">
              <CardTitle className="text-sm font-medium text-red-700">
                Lost Deal Details
              </CardTitle>
            </CardHeader>
            <CardContent className="text-sm space-y-2">
              <p><span className="text-muted-foreground">Lost Date:</span> {formatDate(deal.lostAt)}</p>
              {deal.lostCompetitor && (
                <p><span className="text-muted-foreground">Competitor:</span> {deal.lostCompetitor}</p>
              )}
              {deal.lostNotes && (
                <p><span className="text-muted-foreground">Notes:</span> {deal.lostNotes}</p>
              )}
            </CardContent>
          </Card>
        )}
      </div>

      {/* Right Column: Estimates + Quick Info */}
      <div className="space-y-4">
        <DealCopilotPanel dealId={deal.id} panelId="deal-ai-copilot" />

        <DealEstimatesCard deal={deal} />

        {/* Procore Link */}
        {deal.procoreProjectId && (
          <Card>
            <CardContent className="pt-4">
              <div className="flex items-center gap-2 text-sm">
                <span className="text-muted-foreground">Procore Project:</span>
                <a
                  href={`https://app.procore.com/projects/${deal.procoreProjectId}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-mono text-blue-600 hover:underline inline-flex items-center gap-1"
                >
                  #{deal.procoreProjectId}
                </a>
              </div>
              {deal.procoreLastSyncedAt && (
                <p className="text-xs text-muted-foreground mt-1">
                  Last synced: {formatDate(deal.procoreLastSyncedAt)}
                </p>
              )}
            </CardContent>
          </Card>
        )}
      </div>
    </div>
  );
}
