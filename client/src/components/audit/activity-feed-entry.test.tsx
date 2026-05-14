// @vitest-environment jsdom
import ReactDOMServer from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ActivityFeedEntry } from "./activity-feed-entry";

describe("ActivityFeedEntry", () => {
  it("renders a field change entry in plain English", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 1,
          actorLabel: "Adnaan Iqbal",
          actorType: "user",
          action: "update",
          entityType: "deal",
          entityName: "Tides at Timberglen",
          entitySecondaryId: "DFW-4-11426-AF",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "budget",
              label: "Budget",
              fromDisplay: "$20,000",
              toDisplay: "$35,000",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("Adnaan Iqbal changed Budget from $20,000 to $35,000 on Tides at Timberglen (DFW-4-11426-AF)");
  });

  it("renders a stage move entry", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 2,
          actorLabel: "Takashi Yamashita",
          actorType: "user",
          action: "stage_transition",
          entityType: "deal",
          entityName: "Hidden Ridge Apartments",
          entitySecondaryId: "DFW-1-09726-AA",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "stageId",
              label: "Stage",
              fromDisplay: "Estimating",
              toDisplay: "Internal Review",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("Takashi Yamashita moved Hidden Ridge Apartments (DFW-1-09726-AA) from Estimating to Internal Review");
  });

  it("renders a system-process entry without the bare system label", () => {
    const html = ReactDOMServer.renderToStaticMarkup(
      <ActivityFeedEntry
        entry={{
          id: 3,
          actorLabel: "HubSpot Sync",
          actorType: "system",
          action: "update",
          entityType: "deal",
          entityName: "Cottages at Bedford",
          entitySecondaryId: "DFW-1-12626-AA",
          occurredAt: "2026-05-14T19:42:08.000Z",
          summary: null,
          fieldChanges: [
            {
              key: "awardedAmount",
              label: "Amount",
              fromDisplay: "$1,250,000",
              toDisplay: "$1,275,000",
              transition: "changed",
              masked: false,
            },
          ],
          visibilityScope: "internal",
        }}
      />
    );

    expect(html).toContain("HubSpot Sync updated Amount from $1,250,000 to $1,275,000 on Cottages at Bedford (DFW-1-12626-AA)");
    expect(html).not.toContain(">System<");
  });
});
