import { useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogFooter,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { updateFileMetadata, type FileRecord } from "@/hooks/use-files";
import {
  FILE_CATEGORIES,
  getCategoryLabel,
  getSubcategoryOptions,
  type FileCategory,
} from "@/lib/file-utils";

interface FileEditModalProps {
  file: FileRecord | null;
  onClose: () => void;
  onSaved: () => void;
}

export function FileEditModal({ file, onClose, onSaved }: FileEditModalProps) {
  const [displayName, setDisplayName] = useState("");
  const [description, setDescription] = useState("");
  const [category, setCategory] = useState<FileCategory>("other");
  const [subcategory, setSubcategory] = useState<string>("");
  const [tagsText, setTagsText] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!file) return;
    setDisplayName(file.displayName ?? "");
    setDescription(file.description ?? "");
    setCategory((file.category as FileCategory) ?? "other");
    setSubcategory(file.subcategory ?? "");
    setTagsText((file.tags ?? []).join(", "));
    setError(null);
  }, [file]);

  const subOptions = getSubcategoryOptions(category);

  const handleSave = async () => {
    if (!file) return;
    const name = displayName.trim();
    if (!name) {
      setError("Name is required.");
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateFileMetadata(file.id, {
        displayName: name.slice(0, 500),
        description: description.trim() ? description.trim() : null,
        category,
        // Send subcategory only when the category offers options; the server re-derives folderPath.
        subcategory: subOptions.length > 0 ? (subcategory || null) : null,
        tags: tagsText
          .split(",")
          .map((t) => t.trim())
          .filter(Boolean),
      });
      onSaved();
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save changes.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open={!!file} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Edit file details</DialogTitle>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="file-edit-name">Name</Label>
            <Input
              id="file-edit-name"
              value={displayName}
              onChange={(e) => setDisplayName(e.target.value)}
              maxLength={500}
            />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="file-edit-desc">Description</Label>
            <Textarea
              id="file-edit-desc"
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
            />
          </div>
          <div className="space-y-1.5">
            <Label>Folder / Category</Label>
            <Select
              value={category}
              onValueChange={(v) => {
                setCategory(v as FileCategory);
                setSubcategory(""); // stale subcategory would produce a phantom subfolder
              }}
            >
              <SelectTrigger>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {FILE_CATEGORIES.map((c) => (
                  <SelectItem key={c} value={c}>
                    {getCategoryLabel(c as FileCategory)}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          {subOptions.length > 0 && (
            <div className="space-y-1.5">
              <Label>Subfolder</Label>
              <Select
                value={subcategory || "__none__"}
                onValueChange={(v) => setSubcategory(!v || v === "__none__" ? "" : v)}
              >
                <SelectTrigger>
                  <SelectValue placeholder="None" />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__none__">None</SelectItem>
                  {subOptions.map((s) => (
                    <SelectItem key={s} value={s}>
                      {s}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="file-edit-tags">Tags (comma-separated)</Label>
            <Input
              id="file-edit-tags"
              value={tagsText}
              onChange={(e) => setTagsText(e.target.value)}
              placeholder="e.g. warranty, signed"
            />
          </div>
          {error && <p className="text-sm text-red-600">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={handleSave} disabled={saving}>
            {saving ? "Saving…" : "Save"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
