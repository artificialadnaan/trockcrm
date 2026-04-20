import { useEffect, useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

interface AssignmentRepOption {
  id: string;
  displayName: string;
}

export function RecordAssignmentCard(props: {
  label: string;
  assignedRepId: string;
  assignedRepName: string | null;
  reps: AssignmentRepOption[];
  canEdit: boolean;
  saving?: boolean;
  onSave: (assignedRepId: string) => Promise<void> | void;
}) {
  const [selectedRepId, setSelectedRepId] = useState(props.assignedRepId);

  useEffect(() => {
    setSelectedRepId(props.assignedRepId);
  }, [props.assignedRepId]);

  const selectedLabel =
    props.reps.find((rep) => rep.id === selectedRepId)?.displayName ??
    props.assignedRepName ??
    "Unassigned";

  return (
    <Card size="sm">
      <CardHeader>
        <CardTitle className="text-sm font-medium">{props.label}</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {props.canEdit ? (
          <>
            <Select value={selectedRepId} onValueChange={(value) => setSelectedRepId(value ?? "")}>
              <SelectTrigger className="w-full">
                <SelectValue placeholder="Select rep">
                  {(value) =>
                    props.reps.find((rep) => rep.id === value)?.displayName ??
                    props.assignedRepName ??
                    "Unassigned"
                  }
                </SelectValue>
              </SelectTrigger>
              <SelectContent>
                {props.reps.map((rep) => (
                  <SelectItem key={rep.id} value={rep.id}>
                    {rep.displayName}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
            <Button
              type="button"
              variant="outline"
              onClick={() => props.onSave(selectedRepId)}
              disabled={props.saving || selectedRepId === props.assignedRepId}
            >
              Save Assignment
            </Button>
          </>
        ) : (
          <p className="text-sm text-muted-foreground">{props.assignedRepName ?? "Unassigned"}</p>
        )}
      </CardContent>
    </Card>
  );
}
