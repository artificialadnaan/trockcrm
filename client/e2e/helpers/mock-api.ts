import type { Page, Route } from "@playwright/test";

export const adminUser = {
  id: "admin-1",
  email: "admin@example.test",
  displayName: "Admin User",
  role: "admin",
  officeId: "office-1",
  activeOfficeId: "office-1",
  mustChangePassword: false,
};

export const canonicalProjectTypes = [
  { id: "type-1", name: "Exterior Renovation", slug: "exterior-renovation", code: "1", parentId: null, displayOrder: 1, isActive: true },
  { id: "type-2", name: "Interior Renovation", slug: "interior-renovation", code: "2", parentId: null, displayOrder: 2, isActive: true },
  { id: "type-3", name: "Roofing", slug: "roofing", code: "3", parentId: null, displayOrder: 3, isActive: true },
  { id: "type-4", name: "Service", slug: "service", code: "4", parentId: null, displayOrder: 4, isActive: true },
  { id: "type-5", name: "Commercial", slug: "commercial", code: "5", parentId: null, displayOrder: 5, isActive: true },
  { id: "type-6", name: "Hospitality", slug: "hospitality", code: "6", parentId: null, displayOrder: 6, isActive: true },
  { id: "type-7", name: "Emergency", slug: "emergency", code: "7", parentId: null, displayOrder: 7, isActive: true },
  { id: "type-8", name: "Development", slug: "development", code: "8", parentId: null, displayOrder: 8, isActive: true },
  { id: "type-9", name: "Residential", slug: "residential", code: "9", parentId: null, displayOrder: 9, isActive: true },
];

export const pipelineStages = [
  { id: "stage-opportunity", name: "Opportunity", slug: "opportunity", displayOrder: 1, workflowFamily: "standard_deal", isActivePipeline: true, isTerminal: false },
  { id: "stage-estimating", name: "Estimate in Progress", slug: "estimate_in_progress", displayOrder: 3, workflowFamily: "standard_deal", isActivePipeline: true, isTerminal: false },
  { id: "stage-lead", name: "Sales Validation Stage", slug: "sales_validation_stage", displayOrder: 3, workflowFamily: "lead", isActivePipeline: true, isTerminal: false },
];

export async function installCommonApiMocks(page: Page) {
  await page.route("**/api/auth/me", (route) => route.fulfill({ json: { user: adminUser } }));
  await page.route("**/api/notifications**", (route) => route.fulfill({ json: { notifications: [] } }));
  await page.route("**/api/pipeline/stages**", (route) => route.fulfill({ json: { stages: pipelineStages } }));
  await page.route("**/api/pipeline/regions", (route) => route.fulfill({ json: { regions: [] } }));
  await page.route("**/api/pipeline/project-types", (route) => route.fulfill({ json: { projectTypes: canonicalProjectTypes } }));
  await page.route("**/api/tasks/assignees", (route) =>
    route.fulfill({ json: { users: [{ id: "admin-1", displayName: "Admin User" }] } })
  );
  await page.route("**/api/users/sales-reps", (route) =>
    route.fulfill({
      json: {
        users: [
          { id: "admin-1", displayName: "Admin User" },
          { id: "rep-hidden", displayName: "Hidden Sales Rep" },
        ],
      },
    })
  );
}

export function fulfillNotFound(route: Route) {
  return route.fulfill({ status: 404, json: { error: { message: "Unhandled mock route" } } });
}
