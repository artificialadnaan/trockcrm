import { CheckCircle2, XCircle, AlertTriangle, FileText, User } from "lucide-react";
import {
  formatScopingAttachmentLabel,
  formatScopingFieldLabel,
} from "@/lib/scoping-intake";

interface StageGateChecklistProps {
  missingRequirements: {
    fields: string[];
    documents: string[];
    approvals: string[];
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

export function StageGateChecklist({ missingRequirements }: StageGateChecklistProps) {
  const { fields, documents, approvals } = missingRequirements;
  const hasAny = fields.length > 0 || documents.length > 0 || approvals.length > 0;

  if (!hasAny) {
    return (
      <div className="flex items-center gap-2 text-green-600 text-sm">
        <CheckCircle2 className="h-4 w-4" />
        All requirements met
      </div>
    );
  }

  return (
    <div className="space-y-3">
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
            Required Documents
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
    </div>
  );
}
