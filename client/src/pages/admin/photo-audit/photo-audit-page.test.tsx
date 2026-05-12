/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PhotoAuditPage } from "./photo-audit-page";

const apiMock = vi.hoisted(() => vi.fn());

vi.mock("@/lib/api", () => ({
  api: apiMock,
}));

let root: Root | null = null;
let container: HTMLDivElement | null = null;

afterEach(() => {
  root?.unmount();
  root = null;
  container?.remove();
  container = null;
  apiMock.mockReset();
});

function renderPage(initialEntry = "/admin/photo-audit") {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  root.render(
    <MemoryRouter initialEntries={[initialEntry]}>
      <PhotoAuditPage />
    </MemoryRouter>
  );
  return container;
}

describe("PhotoAuditPage", () => {
  it("renders audit events, serializes filters, and opens a photo viewer from the table", async () => {
    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/users")) {
        return { users: [{ id: "user-1", displayName: "Kaleb Martin", avatarUrl: null }] };
      }
      if (path.startsWith("/admin/photo-audit")) {
        return {
          events: [{
            id: "audit-1",
            eventType: "uploaded",
            userId: "user-1",
            userName: "Kaleb Martin",
            userAvatarUrl: null,
            createdAt: "2026-05-04T18:00:00.000Z",
            ipAddress: "127.0.0.1",
            userAgent: "vitest",
            metadata: {},
            photo: {
              id: "photo-1",
              displayName: "HS-319925219003 Photo 2026-05-10 001 dad87234",
              fileExtension: ".jpg",
              r2Key: "photo.jpg",
              externalUrl: "https://example.test/photo.jpg",
              externalThumbnailUrl: "https://example.test/photo-thumb.jpg",
            },
            deal: { id: "deal-1", name: "Test Deal", dealNumber: "TR-1" },
          }],
          total: 1,
          page: 1,
          perPage: 50,
        };
      }
      if (path === "/files/photo-1") {
        return {
          file: {
            id: "photo-1",
            category: "photo",
            photoCategory: "damage",
            subcategory: null,
            displayName: "Roof damage",
            mimeType: "image/jpeg",
            fileSizeBytes: 2048,
            fileExtension: ".jpg",
            r2Key: "photo.jpg",
            externalUrl: "https://example.test/photo.jpg",
            externalThumbnailUrl: "https://example.test/photo-thumb.jpg",
            description: "Roof damage",
            takenAt: null,
            createdAt: "2026-05-04T18:00:00.000Z",
            uploadedBy: "user-1",
            uploaderName: "Kaleb Martin",
            uploaderAvatarUrl: null,
            latitude: null,
            longitude: null,
            address: null,
            addressSource: null,
            geocodedAt: null,
            procoreSyncStatus: null,
            deletedAt: null,
            deletedByUserId: null,
          },
        };
      }
      if (path.includes("/download")) return { url: "https://example.test/photo.jpg" };
      if (path.includes("/audit-log")) return { events: [] };
      return { file: {} };
    });

    const node = renderPage("/admin/photo-audit?eventType=uploaded");
    await vi.waitFor(() => expect(node.textContent).toContain("Photo Audit"));
    await vi.waitFor(() => expect(node.textContent).toContain("Imported deal Photo 2026-05-10 001 dad87234"));
    expect(node.textContent).not.toContain("HS-319925219003");
    expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("eventType=uploaded"));

    node.querySelector<HTMLButtonElement>('[aria-label="User filter"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Kaleb Martin"));
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Kaleb Martin"))?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("userId=user-1")));

    node.querySelector<HTMLButtonElement>('[aria-label="Event type filter"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Procore retry requested"));
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Procore retry requested"))?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("eventType=uploaded%2Cprocore_sync_retry_requested")));

    node.querySelector<HTMLButtonElement>('[aria-label="Procore sync status filter"]')?.click();
    await vi.waitFor(() => expect(document.body.textContent).toContain("Failed"));
    Array.from(document.body.querySelectorAll<HTMLButtonElement>("button")).find((button) => button.textContent?.includes("Failed"))?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith(expect.stringContaining("procoreSyncStatus=failed")));

    await vi.waitFor(() => expect(node.querySelector<HTMLButtonElement>('[aria-label="Open photo Imported deal Photo 2026-05-10 001 dad87234"]')).toBeTruthy());
    node.querySelector<HTMLButtonElement>('[aria-label="Open photo Imported deal Photo 2026-05-10 001 dad87234"]')?.click();
    await vi.waitFor(() => expect(apiMock).toHaveBeenCalledWith("/files/photo-1", expect.objectContaining({ signal: expect.any(AbortSignal) })));
    await vi.waitFor(() => expect(document.body.textContent).toContain("Uploaded by"));
  }, 10_000);

  it("keeps the modal on the latest clicked photo when earlier requests resolve later", async () => {
    let resolvePhotoA!: (value: unknown) => void;
    const photoAResponse = new Promise((resolve) => {
      resolvePhotoA = resolve;
    });

    apiMock.mockImplementation(async (path: string) => {
      if (path.startsWith("/admin/users")) return { users: [] };
      if (path.startsWith("/admin/photo-audit")) {
        return {
          events: [
            {
              id: "audit-a",
              eventType: "uploaded",
              userId: "user-1",
              userName: "Kaleb Martin",
              userAvatarUrl: null,
              createdAt: "2026-05-04T18:00:00.000Z",
              ipAddress: "127.0.0.1",
              userAgent: "vitest",
              metadata: {},
              photo: {
                id: "photo-a",
                displayName: "Photo A",
                fileExtension: ".jpg",
                r2Key: "photo-a.jpg",
                externalUrl: null,
                externalThumbnailUrl: "https://example.test/photo-a-thumb.jpg",
              },
              deal: { id: "deal-1", name: "Test Deal", dealNumber: "TR-1" },
            },
            {
              id: "audit-b",
              eventType: "uploaded",
              userId: "user-1",
              userName: "Kaleb Martin",
              userAvatarUrl: null,
              createdAt: "2026-05-04T18:01:00.000Z",
              ipAddress: "127.0.0.1",
              userAgent: "vitest",
              metadata: {},
              photo: {
                id: "photo-b",
                displayName: "Photo B",
                fileExtension: ".jpg",
                r2Key: "photo-b.jpg",
                externalUrl: null,
                externalThumbnailUrl: "https://example.test/photo-b-thumb.jpg",
              },
              deal: { id: "deal-1", name: "Test Deal", dealNumber: "TR-1" },
            },
          ],
          total: 2,
          page: 1,
          perPage: 50,
        };
      }
      if (path === "/files/photo-a") return photoAResponse;
      if (path === "/files/photo-b") {
        return {
          file: {
            id: "photo-b",
            category: "photo",
            photoCategory: "damage",
            subcategory: null,
            displayName: "Photo B",
            mimeType: "image/jpeg",
            fileSizeBytes: 2048,
            fileExtension: ".jpg",
            r2Key: "photo-b.jpg",
            externalUrl: null,
            externalThumbnailUrl: "https://example.test/photo-b-thumb.jpg",
            description: null,
            takenAt: null,
            createdAt: "2026-05-04T18:01:00.000Z",
            uploadedBy: "user-1",
            uploaderName: "Kaleb Martin",
            uploaderAvatarUrl: null,
            latitude: null,
            longitude: null,
            address: null,
            addressSource: null,
            geocodedAt: null,
            procoreSyncStatus: null,
            deletedAt: null,
            deletedByUserId: null,
          },
        };
      }
      if (path.includes("/download")) return { url: "https://example.test/photo.jpg" };
      if (path.includes("/audit-log")) return { events: [] };
      return { file: {} };
    });

    const node = renderPage();
    await vi.waitFor(() => expect(node.querySelector<HTMLButtonElement>('[aria-label="Open photo Photo A"]')).toBeTruthy());

    node.querySelector<HTMLButtonElement>('[aria-label="Open photo Photo A"]')?.click();
    node.querySelector<HTMLButtonElement>('[aria-label="Open photo Photo B"]')?.click();
    const modalText = () => document.body.querySelector('[role="dialog"]')?.textContent ?? "";
    await vi.waitFor(() => expect(modalText()).toContain("Photo B"));

    resolvePhotoA({
      file: {
        id: "photo-a",
        category: "photo",
        photoCategory: "damage",
        subcategory: null,
        displayName: "Photo A",
        mimeType: "image/jpeg",
        fileSizeBytes: 2048,
        fileExtension: ".jpg",
        r2Key: "photo-a.jpg",
        externalUrl: null,
        externalThumbnailUrl: "https://example.test/photo-a-thumb.jpg",
        description: null,
        takenAt: null,
        createdAt: "2026-05-04T18:00:00.000Z",
        uploadedBy: "user-1",
        uploaderName: "Kaleb Martin",
        uploaderAvatarUrl: null,
        latitude: null,
        longitude: null,
        address: null,
        addressSource: null,
        geocodedAt: null,
        procoreSyncStatus: null,
        deletedAt: null,
        deletedByUserId: null,
      },
    });

    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(modalText()).toContain("Photo B");
    expect(modalText()).not.toContain("Photo A");
  });
});
