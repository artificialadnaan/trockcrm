import { describe, expect, it } from "vitest";
import {
  DEAL_FIELD_OWNERSHIP,
  planDealFieldWrite,
} from "../../../src/modules/deals/lineage-resolver.js";

describe("deal lineage resolver field ownership", () => {
  it("routes lineage lead fields to the source lead with deal snapshot write-through", () => {
    expect(planDealFieldWrite({ field: "projectTypeId", hasSourceLead: true })).toEqual({
      field: "projectTypeId",
      ownership: "lead",
      target: "source_lead",
      compatibilityWriteThrough: true,
    });

    expect(planDealFieldWrite({ field: "propertyAddress", hasSourceLead: true })).toEqual({
      field: "propertyAddress",
      ownership: "lead",
      target: "source_lead",
      compatibilityWriteThrough: true,
    });
  });

  it("routes lead questionnaire fields to the source lead answer tables", () => {
    expect(planDealFieldWrite({ field: "bidDueDate", hasSourceLead: true })).toEqual({
      field: "bidDueDate",
      ownership: "lead_questionnaire",
      target: "source_lead_questionnaire",
      compatibilityWriteThrough: false,
    });
  });

  it("routes opportunity-owned fields to deal scoping", () => {
    expect(planDealFieldWrite({ field: "preBidMeetingCompleted", hasSourceLead: true })).toEqual({
      field: "preBidMeetingCompleted",
      ownership: "deal_scoping",
      target: "deal_scoping",
      compatibilityWriteThrough: false,
    });
  });

  it("falls back to deal columns for legacy deals without sourceLeadId", () => {
    expect(planDealFieldWrite({ field: "projectTypeId", hasSourceLead: false })).toEqual({
      field: "projectTypeId",
      ownership: "lead",
      target: "deal",
      compatibilityWriteThrough: false,
    });

    expect(planDealFieldWrite({ field: "bidDueDate", hasSourceLead: false })).toEqual({
      field: "bidDueDate",
      ownership: "lead_questionnaire",
      target: "deal",
      compatibilityWriteThrough: false,
    });
  });

  it("keeps the field ownership map explicit for every resolver-supported field", () => {
    expect(DEAL_FIELD_OWNERSHIP).toMatchObject({
      projectTypeId: "lead",
      sourceCategory: "lead",
      sourceDetail: "lead",
      propertyId: "lead",
      propertyName: "lead",
      propertyAddress: "lead",
      propertyCity: "lead",
      propertyState: "lead",
      propertyZip: "lead",
      primaryContactId: "lead",
      assignedRepId: "lead",
      workflowRoute: "lead",
      description: "lead",
      bidDueDate: "lead_questionnaire",
      preBidMeetingCompleted: "deal_scoping",
      siteVisitDecision: "deal_scoping",
      siteVisitCompleted: "deal_scoping",
      estimatorConsultationNotes: "deal_scoping",
    });
  });
});
