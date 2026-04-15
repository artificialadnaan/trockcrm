import { CheckCircle2, XCircle, AlertTriangle, FileText, User } from "lucide-react";
import {
  formatScopingAttachmentLabel,
  formatScopingFieldLabel,
} from "@/lib/scoping-intake";

type ChecklistSource = "stage" | "scoping" | "combined";

export interface StageGateChecklistItemView {
  key: string;
  label: string;
  satisfied: boolean;
  source: ChecklistSource;
}

interface StageGateChecklistProps {
  missingRequirements: {
    fields: string[];
    documents: string[];
    approvals: string[];
  };
  effectiveChecklist?: {
    fields: StageGateChecklistItemView[];
    attachments: StageGateChecklistItemView[];
    approvals: StageGateChecklistItemView[];
  };
}

const FIELD_LABELS: Record<string, string> = {
  ddEstimate: "DD Estimate",
  bidEstimate: "Bid Estimate",
  awardedAmount: "Awarded Amount",
  expectedCloseDate: "Expected Close Date",
  propertyAddress: "Property Address",
  projectTypeId: "Project Type",
  regionId: "Region",
  primaryContactId: "Primary Contact",
  winProbability: "Win Probability",
  description: "Description",
};

const DOC_LABELS: Record<string, string> = {
  estimate: "Estimate Document",
  contract: "Contract",
  rfp: "RFP",
  proposal: "Proposal",
  permit: "Permit",
  insurance: "Insurance Certificate",
  closeout: "Closeout Package",
  change_order: "Change Order",
  inspection: "Inspection",
  correspondence: "Correspondence",
  warranty: "Warranty",
  photo: "Photo",
  other: "Other",
};

function getFieldLabel(field: string) {
  if (field.includes(".")) {
    return formatScopingFieldLabel(field);
  }

  return FIELD_LABELS[field] ?? field;
}

function getDocumentLabel(doc: string) {
  if (doc.includes("_")) {
    return formatScopingAttachmentLabel(doc);
  }

  return DOC_LABELS[doc] ?? doc;
}

function RequirementGroup({
  title,
  items,
  icon: Icon,
}: {
  title: string;
  items: StageGateChecklistItemView[];
  icon: typeof FileText;
}) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div className="space-y-1">
      <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
        {title}
      </p>
      {items.map((item) => (
        <div
          key={`${title}-${item.key}`}
          className={`flex items-center gap-2 text-sm ${
            item.satisfied ? "text-green-600" : "text-red-600"
          }`}
        >
          {item.satisfied ? (
            <CheckCircle2 className="h-3.5 w-3.5" />
          ) : (
            <Icon className="h-3.5 w-3.5" />
          )}
          <span>{item.label}</span>
        </div>
      ))}
    </div>
  );
}

export function StageGateChecklist({
  missingRequirements,
  effectiveChecklist,
}: StageGateChecklistProps) {
  const { fields, documents, approvals } = missingRequirements;
  const hasAny = fields.length > 0 || documents.length > 0 || approvals.length > 0;
  const hasChecklist =
    (effectiveChecklist?.fields.length ?? 0) > 0 ||
    (effectiveChecklist?.attachments.length ?? 0) > 0 ||
    (effectiveChecklist?.approvals.length ?? 0) > 0;

  if (!hasAny && !hasChecklist) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <CheckCircle2 className="h-4 w-4" />
        All requirements met
      </div>
    );
  }

  return (
    <div className="space-y-3">
      {hasChecklist && effectiveChecklist && (
        <div className="space-y-3 rounded-lg border bg-muted/30 p-3">
          <div className="text-sm font-medium">Effective Checklist</div>
          <RequirementGroup
            title="Fields"
            items={effectiveChecklist.fields}
            icon={XCircle}
          />
          <RequirementGroup
            title="Attachment Categories"
            items={effectiveChecklist.attachments}
            icon={FileText}
          />
          <RequirementGroup
            title="Approvals"
            items={effectiveChecklist.approvals}
            icon={User}
          />
        </div>
      )}

      {!hasAny && (
        <div className="flex items-center gap-2 text-green-600 text-sm">
          <CheckCircle2 className="h-4 w-4" />
          All requirements met
        </div>
      )}

      {hasAny && (
        <>
          <div className="flex items-center gap-2 text-amber-600 text-sm font-medium">
            <AlertTriangle className="h-4 w-4" />
            Missing Requirements
          </div>

          {fields.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Required Fields
              </p>
              {fields.map((field) => (
                <div key={field} className="flex items-center gap-2 text-sm text-red-600">
                  <XCircle className="h-3.5 w-3.5" />
                  {getFieldLabel(field)}
                </div>
              ))}
            </div>
          )}

          {documents.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Missing Attachment Categories
              </p>
              {documents.map((doc) => (
                <div key={doc} className="flex items-center gap-2 text-sm text-red-600">
                  <FileText className="h-3.5 w-3.5" />
                  {getDocumentLabel(doc)}
                </div>
              ))}
            </div>
          )}

          {approvals.length > 0 && (
            <div className="space-y-1">
              <p className="text-xs font-medium text-muted-foreground uppercase tracking-wider">
                Required Approvals
              </p>
              {approvals.map((role) => (
                <div key={role} className="flex items-center gap-2 text-sm text-red-600">
                  <User className="h-3.5 w-3.5" />
                  {role.charAt(0).toUpperCase() + role.slice(1)} approval
                </div>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
