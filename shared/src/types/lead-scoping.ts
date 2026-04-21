export const LEAD_SCOPING_SECTION_KEYS = [
  "projectOverview",
  "budgetAndBidInfo",
  "propertyDetails",
  "projectScopeSummary",
  "interiorUnitRenovationScope",
  "exteriorScope",
  "amenitiesSiteImprovements",
  "quantities",
  "siteLogistics",
  "siteConditionsObserved",
  "materialsSpecifications",
  "attachmentsProvided",
] as const;

export type LeadScopingSectionKey = (typeof LEAD_SCOPING_SECTION_KEYS)[number];

export const LEAD_SCOPING_TRI_STATE_VALUES = ["yes", "no", "na"] as const;
export type TriStateValue = (typeof LEAD_SCOPING_TRI_STATE_VALUES)[number];

export const LEAD_SCOPING_ATTACHMENT_VALUES = ["provided", "not_provided", "na"] as const;
export type AttachmentAnswerValue = (typeof LEAD_SCOPING_ATTACHMENT_VALUES)[number];

export type LeadScopingFieldType =
  | "text"
  | "textarea"
  | "date"
  | "tri_state"
  | "select"
  | "attachment";

export interface LeadScopingFieldDefinition {
  key: string;
  label: string;
  type: LeadScopingFieldType;
  options?: readonly string[];
  required?: boolean;
}

export type LeadScopingSectionDefinition = Record<LeadScopingSectionKey, readonly LeadScopingFieldDefinition[]>;

export interface LeadScopingSectionData {
  projectOverview?: Record<string, unknown>;
  budgetAndBidInfo?: Record<string, unknown>;
  propertyDetails?: Record<string, unknown>;
  projectScopeSummary?: Record<string, unknown>;
  interiorUnitRenovationScope?: Record<string, unknown>;
  exteriorScope?: Record<string, unknown>;
  amenitiesSiteImprovements?: Record<string, unknown>;
  quantities?: Record<string, unknown>;
  siteLogistics?: Record<string, unknown>;
  siteConditionsObserved?: Record<string, unknown>;
  materialsSpecifications?: Record<string, unknown>;
  attachmentsProvided?: Record<string, unknown>;
}

export interface LeadScopingCompletionStateEntry {
  isComplete: boolean;
  missingFields: string[];
  missingAttachments: string[];
}

export interface LeadScopingReadiness {
  status: "draft" | "ready" | "completed";
  isReadyForGoNoGo: boolean;
  completionState: Record<string, LeadScopingCompletionStateEntry>;
  errors: {
    sections: Record<string, string[]>;
    attachments: Record<string, string[]>;
  };
}

const PROJECT_TYPE_OPTIONS = [
  "interior_unit_renovation",
  "exterior_renovation",
  "amenity_clubhouse_renovation",
  "dd",
  "other",
  "na",
] as const;

const PRICING_MODE_OPTIONS = ["budget_pricing", "detailed_bid", "alternate_pricing", "na"] as const;
const RENOVATION_TYPE_OPTIONS = ["full_renovations", "partial_renovations", "move_in_ready", "na"] as const;
const DRYWALL_FINISH_OPTIONS = ["textured", "smooth", "popcorn", "na"] as const;
const ACCESSIBILITY_METHOD_OPTIONS = ["lift", "scaffolding", "swing_stage", "ladder", "na"] as const;
const FINISH_LEVEL_OPTIONS = ["budget", "mid_level", "premium", "na"] as const;

function triStateField(key: string, label: string): LeadScopingFieldDefinition {
  return { key, label, type: "tri_state" };
}

function textField(key: string, label: string, type: "text" | "textarea" | "date" = "text"): LeadScopingFieldDefinition {
  return { key, label, type, required: true };
}

function selectField(
  key: string,
  label: string,
  options: readonly string[]
): LeadScopingFieldDefinition {
  return { key, label, type: "select", options, required: true };
}

function attachmentField(key: string, label: string): LeadScopingFieldDefinition {
  return { key, label, type: "attachment", options: LEAD_SCOPING_ATTACHMENT_VALUES, required: true };
}

export const LEAD_SCOPING_FIELD_DEFINITIONS: LeadScopingSectionDefinition = {
  projectOverview: [
    textField("propertyName", "Property Name"),
    textField("propertyAddress", "Property Address"),
    textField("cityState", "City / State"),
    textField("client", "Client"),
    textField("accountRep", "Account Rep"),
    textField("dateOfWalk", "Date of Walk", "date"),
    textField("bidDueDate", "Bid Due Date", "date"),
    selectField("projectType", "Project Type", PROJECT_TYPE_OPTIONS),
    { ...textField("projectTypeOtherText", "Project Type Other"), required: false },
  ],
  budgetAndBidInfo: [
    textField("ownerBudgetRange", "Owner Budget Range"),
    textField("numberOfBidders", "Number of Bidders"),
    textField("decisionMaker", "Decision Maker"),
    textField("decisionTimeline", "Decision Timeline"),
    triStateField("clientBidPortalRequired", "Client Bid Portal Required"),
    { ...textField("clientBidPortalLoginFormatNotes", "Client Bid Portal Login / Format Notes", "textarea"), required: false },
    { ...textField("importantContextNotes", "Important Context / Expectations / Notes", "textarea"), required: false },
    selectField("pricingMode", "Pricing Mode", PRICING_MODE_OPTIONS),
  ],
  propertyDetails: [
    textField("yearBuilt", "Year Built"),
    textField("totalUnits", "Total Units"),
    textField("totalBuildings", "Total Buildings"),
    textField("floorsPerBuilding", "Floors Per Building"),
    { ...textField("unitMixSummary", "Unit Mix Summary", "textarea"), required: false },
    textField("averageUnitSize", "Average Unit Size"),
  ],
  projectScopeSummary: [textField("highLevelScopeSummaryNarrative", "High-Level Scope Summary", "textarea")],
  interiorUnitRenovationScope: [
    textField("unitsRenovatedMonthly", "Units Renovated Monthly"),
    selectField("renovationType", "Renovation Type", RENOVATION_TYPE_OPTIONS),
    triStateField("livingRoomLighting", "Living Room / Dining: Lighting"),
    triStateField("livingRoomElectricalDevices", "Living Room / Dining: Electrical Devices"),
    triStateField("livingRoomWindowTreatment", "Living Room / Dining: Window Treatment"),
    triStateField("livingRoomDoorHardware", "Living Room / Dining: Door Hardware"),
    triStateField("livingRoomDrywallRepairs", "Living Room / Dining: Drywall Repairs"),
    triStateField("kitchenBarCutDown", "Kitchen: Bar Cut Down"),
    triStateField("kitchenCabinetReplacement", "Kitchen: Cabinet Replacement"),
    triStateField("kitchenCabinetRefinish", "Kitchen: Cabinet Refinish"),
    triStateField("kitchenNewCountertops", "Kitchen: New Countertops"),
    triStateField("kitchenBacksplash", "Kitchen: Backsplash"),
    triStateField("kitchenSinkFaucet", "Kitchen: Sink / Faucet"),
    triStateField("kitchenAppliancePackage", "Kitchen: Appliance Package"),
    triStateField("kitchenCabinetHardware", "Kitchen: Cabinet Hardware"),
    triStateField("kitchenDoorHardware", "Kitchen: Door Hardware"),
    triStateField("kitchenDrywallRepairs", "Kitchen: Drywall Repairs"),
    { ...textField("kitchenNotes", "Kitchen Notes", "textarea"), required: false },
    triStateField("bedroomsLighting", "Bedrooms: Lighting"),
    triStateField("bedroomsElectricalDevices", "Bedrooms: Electrical Devices"),
    triStateField("bedroomsWindowTreatment", "Bedrooms: Window Treatment"),
    triStateField("bedroomsDoorHardware", "Bedrooms: Door Hardware"),
    triStateField("bedroomsDrywallRepairs", "Bedrooms: Drywall Repairs"),
    { ...textField("bedroomsNotes", "Bedrooms Notes", "textarea"), required: false },
    triStateField("bathroomsTubShowerReplacement", "Bathrooms: Tub / Shower Replacement"),
    triStateField("bathroomsTileSurroundReplacement", "Bathrooms: Tile / Surround Replacement"),
    triStateField("bathroomsTubShowerResurface", "Bathrooms: Tub / Shower Resurface"),
    triStateField("bathroomsVanityReplacement", "Bathrooms: Vanity Replacement"),
    triStateField("bathroomsPlumbingFixtures", "Bathrooms: Plumbing Fixtures"),
    triStateField("bathroomsLighting", "Bathrooms: Lighting"),
    triStateField("bathroomsBathAccessoriesMirrors", "Bathrooms: Bath Accessories / Mirrors"),
    triStateField("bathroomsDrywallRepairs", "Bathrooms: Drywall Repairs"),
    { ...textField("bathroomsNotes", "Bathrooms Notes", "textarea"), required: false },
    textField("flooringExistingFlooring", "Flooring: Existing Flooring"),
    textField("flooringNewFlooring", "Flooring: New Flooring"),
    textField("flooringApproxSquareFootagePerUnit", "Flooring: Approximate SF Per Unit"),
    triStateField("paintFullUnitPaint", "Paint: Full Unit Paint"),
    triStateField("paintWallsOnly", "Paint: Walls Only"),
    triStateField("paintTrimAndDoors", "Paint: Trim and Doors"),
    triStateField("paintColorSelectionsKnown", "Paint: Color Selections Known"),
    selectField("paintDrywallFinish", "Paint: Drywall Finish", DRYWALL_FINISH_OPTIONS),
  ],
  exteriorScope: [
    triStateField("exteriorPaint", "Exterior Paint"),
    triStateField("sidingRepairReplacement", "Siding Repair / Replacement"),
    triStateField("stuccoRepair", "Stucco Repair"),
    triStateField("balconyRepairs", "Balcony Repairs"),
    triStateField("railingReplacement", "Railing Replacement"),
    triStateField("windowReplacement", "Window Replacement"),
    triStateField("breezewayImprovements", "Breezeway Improvements"),
    triStateField("stairRepairs", "Stair Repairs"),
    triStateField("roofRepairs", "Roof Repairs"),
    selectField("accessibilityMethod", "Accessibility Method", ACCESSIBILITY_METHOD_OPTIONS),
    { ...textField("notes", "Exterior Scope Notes", "textarea"), required: false },
  ],
  amenitiesSiteImprovements: [
    triStateField("clubhouseRenovation", "Clubhouse Renovation"),
    triStateField("leasingOfficeUpgrades", "Leasing Office Upgrades"),
    triStateField("poolAreaImprovements", "Pool Area Improvements"),
    triStateField("fitnessCenter", "Fitness Center"),
    triStateField("dogPark", "Dog Park"),
    triStateField("outdoorKitchens", "Outdoor Kitchens"),
    triStateField("landscaping", "Landscaping"),
    triStateField("parkingLotRepairs", "Parking Lot Repairs"),
    triStateField("siteLighting", "Site Lighting"),
    { ...textField("notes", "Amenities / Site Improvements Notes", "textarea"), required: false },
  ],
  quantities: [
    textField("unitsRenovated", "Units Renovated"),
    textField("buildingsImpacted", "Buildings Impacted"),
    textField("balconies", "Balconies"),
    textField("staircases", "Staircases"),
    textField("windowsIfReplacing", "Windows if Replacing"),
    textField("doors", "Doors"),
    textField("exteriorPaintableAreaEstimate", "Exterior Paintable Area Estimate"),
  ],
  siteLogistics: [
    textField("stagingDumpsterAccessibility", "Staging and Dumpster Accessibility"),
    textField("elevatorAccess", "Elevator Access"),
  ],
  siteConditionsObserved: [
    triStateField("asbestos", "Asbestos"),
    triStateField("waterDamage", "Water Damage"),
    triStateField("woodRot", "Wood Rot"),
    triStateField("structuralConcerns", "Structural Concerns"),
    triStateField("moldMildew", "Mold / Mildew"),
    triStateField("electricalIssues", "Electrical Issues"),
    triStateField("plumbingIssues", "Plumbing Issues"),
    triStateField("codeConcerns", "Code Concerns"),
    { ...textField("notes", "Site Conditions Notes", "textarea"), required: false },
  ],
  materialsSpecifications: [
    triStateField("specPackageProvided", "Spec Package Provided"),
    selectField("finishLevel", "Finish Level", FINISH_LEVEL_OPTIONS),
    triStateField("ownerSuppliedMaterials", "Owner Supplied Materials"),
    { ...textField("preferredBrands", "Preferred Brands"), required: false },
  ],
  attachmentsProvided: [
    attachmentField("companyCamPhotos", "Company Cam Photos"),
    attachmentField("typicalUnitPhotos", "Typical Unit Photos"),
    attachmentField("exteriorBuildingPhotos", "Exterior Building Photos"),
    attachmentField("amenityPhotos", "Amenity Photos"),
    attachmentField("plansDrawings", "Plans / Drawings"),
    attachmentField("finishSchedules", "Finish Schedules"),
    attachmentField("scopeDocuments", "Scope Documents"),
    textField("fileLocationNote", "File Location Note"),
  ],
};

export const LEAD_SCOPING_ATTACHMENT_KEYS = LEAD_SCOPING_FIELD_DEFINITIONS.attachmentsProvided
  .filter((field) => field.type === "attachment")
  .map((field) => field.key);
