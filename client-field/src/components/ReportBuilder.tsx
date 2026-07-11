import React, { useEffect, useMemo, useState } from "react";
import { ArrowLeft, CheckSquare, Download, FileText, Plus, Square, X } from "lucide-react";
import type { FieldPhoto } from "../lib/field-projects";
import { api } from "../lib/api";
import { BrandLogo } from "./BrandLogo";
import { LazyThumb } from "./LazyThumb";
import { Button, TextInput } from "./ui";

type ReportBuilderProps = {
  isOpen: boolean;
  projectId: string;
  projectName: string;
  creatorName: string;
  photos: FieldPhoto[];
  onClose: () => void;
  onGenerated: () => void;
};

type PreviewPhoto = {
  id: string;
  displayName: string;
  description: string | null;
  takenAt: string | null;
  createdAt: string;
  uploaderName: string;
  imageUrl: string | null;
  tags: string[];
  projectName: string;
};

type PreviewSection = {
  id: string;
  title: string;
  photos: PreviewPhoto[];
};

type PreviewResponse = {
  cover: {
    reportTitle: string;
    creatorName: string;
    companyName: string;
    reportDateLabel: string;
    projectName: string;
    photoCount: number;
  };
  sections: PreviewSection[];
};

type EditableSection = {
  id: string;
  title: string;
  photos: Array<PreviewPhoto & { descriptionOverride: string }>;
};

function normalizeDate(value: string | null, fallback: string): string {
  return new Date(value ?? fallback).toISOString().slice(0, 10);
}

export function ReportBuilder({ isOpen, projectId, projectName, creatorName, photos, onClose, onGenerated }: ReportBuilderProps) {
  const [step, setStep] = useState<"select" | "edit">("select");
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [groupBy, setGroupBy] = useState<"tag" | "date" | "none">("tag");
  const [tagFilter, setTagFilter] = useState<string[]>([]);
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [cover, setCover] = useState<PreviewResponse["cover"] | null>(null);
  const [sections, setSections] = useState<EditableSection[]>([]);
  const [generated, setGenerated] = useState<{ title: string; pdfUrl: string } | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    setStep("select");
    setSelectedIds([]);
    setGroupBy("tag");
    setTagFilter([]);
    setFrom("");
    setTo("");
    setLoading(false);
    setError(null);
    setCover(null);
    setSections([]);
    setGenerated(null);
  }, [isOpen]);

  const availableTags = useMemo(() => {
    const map = new Map<string, string>();
    photos.forEach((photo) => {
      for (const tag of photo.tags ?? []) {
        const normalized = tag.trim();
        if (!normalized) continue;
        const key = normalized.toLowerCase();
        if (!map.has(key)) map.set(key, normalized);
      }
    });
    return Array.from(map.values()).sort((left, right) => left.localeCompare(right));
  }, [photos]);

  const filteredPhotos = useMemo(() => {
    return photos.filter((photo) => {
      if (tagFilter.length > 0 && !(photo.tags ?? []).some((tag) => tagFilter.includes(tag))) return false;
      const date = normalizeDate(photo.takenAt, photo.createdAt);
      if (from && date < from) return false;
      if (to && date > to) return false;
      return true;
    });
  }, [from, photos, tagFilter, to]);

  const allVisibleSelected = filteredPhotos.length > 0 && filteredPhotos.every((photo) => selectedIds.includes(photo.id));

  function toggleSelected(photoId: string) {
    setSelectedIds((current) => current.includes(photoId) ? current.filter((id) => id !== photoId) : [...current, photoId]);
  }

  function toggleAllVisible() {
    setSelectedIds((current) => {
      if (allVisibleSelected) {
        return current.filter((id) => !filteredPhotos.some((photo) => photo.id === id));
      }
      const next = new Set(current);
      filteredPhotos.forEach((photo) => next.add(photo.id));
      return Array.from(next);
    });
  }

  async function buildPreview() {
    setLoading(true);
    setError(null);
    try {
      const response = await api<PreviewResponse>("/field/reports/preview", {
        method: "POST",
        json: { projectId, photoIds: selectedIds, groupBy },
      });
      setCover(response.cover);
      setSections(response.sections.map((section) => ({
        id: section.id,
        title: section.title,
        photos: section.photos.map((photo) => ({
          ...photo,
          descriptionOverride: photo.description ?? "",
        })),
      })));
      setStep("edit");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to build report preview");
    } finally {
      setLoading(false);
    }
  }

  function movePhoto(sectionId: string, photoId: string, targetSectionId: string) {
    if (sectionId === targetSectionId) return;
    setSections((current) => {
      const sourceSection = current.find((section) => section.id === sectionId);
      const targetSection = current.find((section) => section.id === targetSectionId);
      if (!sourceSection || !targetSection) return current;
      const photo = sourceSection.photos.find((entry) => entry.id === photoId);
      if (!photo) return current;
      return current.map((section) => {
        if (section.id === sectionId) {
          return { ...section, photos: section.photos.filter((entry) => entry.id !== photoId) };
        }
        if (section.id === targetSectionId) {
          return { ...section, photos: [...section.photos, photo] };
        }
        return section;
      }).filter((section) => section.photos.length > 0 || section.id !== sectionId);
    });
  }

  function reorderPhoto(sectionId: string, photoId: string, direction: -1 | 1) {
    setSections((current) => current.map((section) => {
      if (section.id !== sectionId) return section;
      const index = section.photos.findIndex((photo) => photo.id === photoId);
      if (index < 0) return section;
      const nextIndex = index + direction;
      if (nextIndex < 0 || nextIndex >= section.photos.length) return section;
      const photos = [...section.photos];
      const [photo] = photos.splice(index, 1);
      photos.splice(nextIndex, 0, photo);
      return { ...section, photos };
    }));
  }

  function addSection() {
    setSections((current) => [...current, {
      id: `custom-${crypto.randomUUID?.() ?? Date.now()}`,
      title: `Section ${current.length + 1}`,
      photos: [],
    }]);
  }

  function removeSection(sectionId: string) {
    setSections((current) => {
      if (current.length <= 1) return current;
      const section = current.find((entry) => entry.id === sectionId);
      if (!section) return current;
      const [firstSection] = current.filter((entry) => entry.id !== sectionId);
      return current
        .filter((entry) => entry.id !== sectionId)
        .map((entry, index) => index === 0 ? { ...entry, photos: [...entry.photos, ...section.photos] } : entry);
    });
  }

  async function generateReport() {
    if (!cover) return;
    setLoading(true);
    setError(null);
    try {
      const response = await api<{ report: { id: string; title: string; pdfUrl: string } }>("/field/reports/generate", {
        method: "POST",
        json: {
          projectId,
          reportTitle: cover.reportTitle,
          coverData: cover,
          sections: sections.map((section) => ({
            title: section.title,
            photoIds: section.photos.map((photo) => photo.id),
            photoOverrides: section.photos.map((photo) => ({
              id: photo.id,
              description: photo.descriptionOverride,
            })),
          })),
        },
      });
      setGenerated({ title: response.report.title, pdfUrl: response.report.pdfUrl });
      onGenerated();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to generate report");
    } finally {
      setLoading(false);
    }
  }

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-[80] bg-black/70 px-3 py-4 text-foreground">
      <div className="mx-auto flex h-full w-full max-w-5xl flex-col overflow-hidden rounded-3xl bg-white shadow-2xl">
        <div className="flex items-center justify-between border-b border-border px-4 py-3">
          <div className="flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl border border-border bg-white shadow-sm">
              <BrandLogo className="h-7 w-auto" alt="T Rock Construction logo" surfaceClassName="rounded-lg px-2 py-1.5" />
            </div>
            <div>
              <p className="text-[11px] font-black uppercase tracking-[0.24em] text-primary">Reports</p>
              <h2 className="text-xl font-black">{step === "select" ? "Generate Report" : "Edit Report"}</h2>
              <p className="text-sm text-muted-foreground">{projectName}</p>
            </div>
          </div>
          <button type="button" aria-label="Close report builder" className="rounded-full bg-muted p-2" onClick={onClose}>
            <X className="h-5 w-5" />
          </button>
        </div>

        {error ? <div className="border-b border-red-200 bg-red-50 px-4 py-3 text-sm font-semibold text-red-700">{error}</div> : null}

        {step === "select" ? (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="space-y-3 border-b border-border px-4 py-3">
              <div className="flex flex-wrap gap-2">
                <Button variant="ghost" onClick={toggleAllVisible}>
                  {allVisibleSelected ? <Square className="mr-2 h-4 w-4" /> : <CheckSquare className="mr-2 h-4 w-4" />}
                  {allVisibleSelected ? "Clear visible" : "Select all visible"}
                </Button>
                <div className="flex rounded-md border border-border bg-muted p-1">
                  {(["tag", "date", "none"] as const).map((value) => (
                    <button
                      key={value}
                      type="button"
                      className={`rounded px-3 py-1 text-sm font-bold ${groupBy === value ? "bg-primary text-primary-foreground" : "text-muted-foreground"}`}
                      onClick={() => setGroupBy(value)}
                    >
                      Group by {value}
                    </button>
                  ))}
                </div>
              </div>
              <div className="flex flex-wrap items-center gap-2">
                {availableTags.map((tag) => (
                  <button
                    key={tag}
                    type="button"
                    className={`rounded-full border px-3 py-1.5 text-xs font-bold ${tagFilter.includes(tag) ? "border-primary bg-primary text-primary-foreground" : "border-border bg-background text-foreground"}`}
                    onClick={() => setTagFilter((current) => current.includes(tag) ? current.filter((value) => value !== tag) : [...current, tag])}
                  >
                    #{tag}
                  </button>
                ))}
                <div className="ml-auto flex items-center gap-2">
                  <TextInput type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="min-h-10 w-[9rem]" />
                  <TextInput type="date" value={to} onChange={(event) => setTo(event.target.value)} className="min-h-10 w-[9rem]" />
                </div>
              </div>
            </div>

            {/* auto-rows-max + content-start: this grid is a flex-1 child (definite height), so the default
                grid-auto-rows:auto sized each row to the caption only — an aspect-square box contributes ~0 to
                an auto row in a height-constrained grid — collapsing every thumbnail to a clipped sliver. Sizing
                rows to their content (max-content) and packing from the top restores square cells + scroll. */}
            <div className="grid flex-1 auto-rows-max content-start grid-cols-2 gap-3 overflow-y-auto px-4 py-4 sm:grid-cols-3 lg:grid-cols-4">
              {filteredPhotos.map((photo) => {
                const checked = selectedIds.includes(photo.id);
                return (
                  <button
                    key={photo.id}
                    type="button"
                    className={`overflow-hidden rounded-2xl border text-left transition ${checked ? "border-primary ring-2 ring-primary/20" : "border-border"}`}
                    onClick={() => toggleSelected(photo.id)}
                  >
                    <div className="relative aspect-square bg-muted">
                      {photo.imageUrl ? <LazyThumb src={photo.imageUrl} alt={photo.displayName} /> : <div className="flex h-full items-center justify-center text-muted-foreground"><FileText className="h-8 w-8" /></div>}
                      <span className={`absolute right-2 top-2 rounded-full px-2 py-1 text-xs font-black ${checked ? "bg-primary text-primary-foreground" : "bg-black/70 text-white"}`}>{checked ? "Selected" : "Pick"}</span>
                    </div>
                    <div className="space-y-2 p-3">
                      <p className="truncate text-sm font-bold">{photo.description || photo.displayName}</p>
                      {(photo.tags?.length ?? 0) > 0 ? <div className="flex flex-wrap gap-1">{photo.tags!.slice(0, 2).map((tag) => <span key={tag} className="rounded-full bg-primary/10 px-2 py-0.5 text-[10px] font-bold text-primary">#{tag}</span>)}</div> : null}
                    </div>
                  </button>
                );
              })}
            </div>

            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              <p className="text-sm font-semibold text-muted-foreground">{selectedIds.length} selected</p>
              <Button disabled={selectedIds.length === 0 || loading} onClick={() => void buildPreview()}>
                {loading ? "Building..." : "Continue"}
              </Button>
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col overflow-hidden">
            <div className="grid gap-3 border-b border-border px-4 py-4 md:grid-cols-2">
              <label className="space-y-1">
                <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">Report title</span>
                <TextInput value={cover?.reportTitle ?? ""} onChange={(event) => setCover((current) => current ? { ...current, reportTitle: event.target.value } : current)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">Creator</span>
                <TextInput value={cover?.creatorName ?? creatorName} onChange={(event) => setCover((current) => current ? { ...current, creatorName: event.target.value } : current)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">Report date</span>
                <TextInput value={cover?.reportDateLabel ?? ""} onChange={(event) => setCover((current) => current ? { ...current, reportDateLabel: event.target.value } : current)} />
              </label>
              <label className="space-y-1">
                <span className="text-xs font-black uppercase tracking-wide text-muted-foreground">Company</span>
                <TextInput value={cover?.companyName ?? "TRock Construction"} onChange={(event) => setCover((current) => current ? { ...current, companyName: event.target.value } : current)} />
              </label>
            </div>

            <div className="flex-1 space-y-4 overflow-y-auto px-4 py-4">
              <div className="flex items-center justify-between">
                <Button variant="ghost" onClick={() => setStep("select")}><ArrowLeft className="mr-2 h-4 w-4" />Back to selection</Button>
                <Button variant="ghost" onClick={addSection}><Plus className="mr-2 h-4 w-4" />Add section</Button>
              </div>
              {sections.map((section, sectionIndex) => (
                <section key={section.id} className="rounded-2xl border border-border p-3">
                  <div className="mb-3 flex items-center gap-2">
                    <TextInput value={section.title} onChange={(event) => setSections((current) => current.map((entry) => entry.id === section.id ? { ...entry, title: event.target.value } : entry))} />
                    {sections.length > 1 ? <Button variant="ghost" onClick={() => removeSection(section.id)}>Remove</Button> : null}
                  </div>
                  <div className="space-y-3">
                    {section.photos.map((photo, photoIndex) => (
                      <div key={photo.id} className="grid gap-3 rounded-xl bg-muted/30 p-3 md:grid-cols-[88px_minmax(0,1fr)]">
                        <div className="aspect-square overflow-hidden rounded-xl bg-muted">
                          {photo.imageUrl ? <LazyThumb src={photo.imageUrl} alt={photo.displayName} /> : <div className="flex h-full items-center justify-center text-muted-foreground"><FileText className="h-6 w-6" /></div>}
                        </div>
                        <div className="space-y-2">
                          <div className="flex flex-wrap items-center gap-2">
                            <p className="font-bold">{photo.displayName}</p>
                            <select
                              className="min-h-10 rounded-md border border-border bg-white px-3 text-sm"
                              value={section.id}
                              onChange={(event) => movePhoto(section.id, photo.id, event.target.value)}
                            >
                              {sections.map((target) => <option key={target.id} value={target.id}>{target.title}</option>)}
                            </select>
                            <Button variant="ghost" disabled={photoIndex === 0} onClick={() => reorderPhoto(section.id, photo.id, -1)}>Up</Button>
                            <Button variant="ghost" disabled={photoIndex === section.photos.length - 1} onClick={() => reorderPhoto(section.id, photo.id, 1)}>Down</Button>
                          </div>
                          <textarea
                            value={photo.descriptionOverride}
                            onChange={(event) => setSections((current) => current.map((entry) => entry.id === section.id ? {
                              ...entry,
                              photos: entry.photos.map((item) => item.id === photo.id ? { ...item, descriptionOverride: event.target.value } : item),
                            } : entry))}
                            className="min-h-24 w-full rounded-md border border-border bg-white px-3 py-2 text-sm outline-none ring-primary/25 transition focus:ring-4"
                          />
                        </div>
                      </div>
                    ))}
                    {section.photos.length === 0 ? <p className="text-sm text-muted-foreground">No photos in this section yet.</p> : null}
                  </div>
                </section>
              ))}
            </div>

            <div className="flex items-center justify-between border-t border-border px-4 py-3">
              {generated ? (
                <a href={generated.pdfUrl} target="_blank" rel="noreferrer" className="inline-flex min-h-11 items-center justify-center rounded-md bg-primary px-4 py-2 font-semibold text-primary-foreground">
                  <Download className="mr-2 h-4 w-4" />
                  Open {generated.title}
                </a>
              ) : <span className="text-sm text-muted-foreground">Generate the branded PDF after reviewing sections and descriptions.</span>}
              <Button disabled={loading || !cover || sections.every((section) => section.photos.length === 0)} onClick={() => void generateReport()}>
                {loading ? "Generating..." : "Generate PDF"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
