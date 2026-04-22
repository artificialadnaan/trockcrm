import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { RecordAssignmentCard } from "./record-assignment-card";

describe("RecordAssignmentCard", () => {
  it("shows an editable rep selector and save button for director/admin", () => {
    const html = renderToStaticMarkup(
      <RecordAssignmentCard
        label="Assigned Rep"
        assignedRepId="rep-1"
        assignedRepName="Rep One"
        reps={[
          { id: "rep-1", displayName: "Rep One" },
          { id: "rep-2", displayName: "Rep Two" },
        ]}
        canEdit
        onSave={() => undefined}
      />
    );

    expect(html).toContain("Assigned Rep");
    expect(html).toContain("Save Assignment");
    expect(html).toContain("Rep One");
  });

  it("shows read-only assignment state for reps", () => {
    const html = renderToStaticMarkup(
      <RecordAssignmentCard
        label="Assigned Rep"
        assignedRepId="rep-1"
        assignedRepName="Rep One"
        reps={[]}
        canEdit={false}
        onSave={() => undefined}
      />
    );

    expect(html).toContain("Assigned Rep");
    expect(html).toContain("Rep One");
    expect(html).not.toContain("Save Assignment");
  });
});
