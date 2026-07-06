// @vitest-environment node
import { describe, it, expect } from "vitest";
import { resolveFolderUploadTarget } from "./file-utils";

// Fixtures mirror the FolderNode[] the folders API returns. getDealFolderTree derives each
// FolderNode.category from DEAL_FOLDER_TEMPLATE (verified: `category: config.category`, and locked by
// server/tests/modules/files/deal-folder-tree-category.runtime.test.ts), so the two lossy folders arrive
// already pinned to "permit" / "correspondence".
const folders = [
  { name: "Photos",    path: "Photos",    category: "photo" as const,    subfolders: [{ name: "Progress", path: "Photos/Progress" }] },
  { name: "Estimates", path: "Estimates", category: "estimate" as const, subfolders: [{ name: "Bid Estimate", path: "Estimates/Bid Estimate" }] },
  { name: "Contracts", path: "Contracts", category: "contract" as const, subfolders: [] },
  { name: "Permits & Inspections", path: "Permits & Inspections", category: "permit" as const, subfolders: [] },
  { name: "Correspondence", path: "Correspondence", category: "correspondence" as const, subfolders: [] },
];

describe("resolveFolderUploadTarget", () => {
  it("returns null for the All Files root (not a valid upload target)", () => {
    expect(resolveFolderUploadTarget(folders, null)).toBeNull();
    expect(resolveFolderUploadTarget(folders, "all")).toBeNull();
    expect(resolveFolderUploadTarget(folders, "")).toBeNull();
  });
  it("pins the lossy folders to their canonical category", () => {
    expect(resolveFolderUploadTarget(folders, "Permits & Inspections")).toEqual({ category: "permit" });
    expect(resolveFolderUploadTarget(folders, "Correspondence")).toEqual({ category: "correspondence" });
  });
  it("resolves a top folder to its category", () => {
    expect(resolveFolderUploadTarget(folders, "Contracts")).toEqual({ category: "contract" });
  });
  it("resolves a subfolder pick to category + subcategory", () => {
    expect(resolveFolderUploadTarget(folders, "Estimates/Bid Estimate")).toEqual({ category: "estimate", subcategory: "Bid Estimate" });
    expect(resolveFolderUploadTarget(folders, "Photos/Progress")).toEqual({ category: "photo", subcategory: "Progress" });
  });
  it("returns null for an unknown value", () => {
    expect(resolveFolderUploadTarget(folders, "Nope")).toBeNull();
  });
});
