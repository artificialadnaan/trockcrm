import { useRef, useState } from "react";
import { Building2, ImagePlus, Loader2, Trash2, Upload } from "lucide-react";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { deletePropertyImage, uploadPropertyImage, type PropertySurface } from "@/hooks/use-properties";

/**
 * Header-slot avatar for a property's cover photo. Renders the thumbnail (click to view full-size) when one
 * exists, and falls back to the generic building icon otherwise. Purely presentational + self-contained
 * viewer state — it does no data fetching.
 */
export function PropertyImageAvatar({
  imageThumbnailUrl,
  imageUrl,
  name,
}: {
  imageThumbnailUrl?: string | null;
  imageUrl?: string | null;
  name: string;
}) {
  const [open, setOpen] = useState(false);

  if (!imageThumbnailUrl) {
    return <Building2 className="h-9 w-9" />;
  }

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="h-full w-full focus:outline-none focus-visible:ring-2 focus-visible:ring-white"
        aria-label={`View photo of ${name}`}
      >
        <img src={imageThumbnailUrl} alt={name} className="h-full w-full object-cover" />
      </button>
      <Dialog open={open} onOpenChange={setOpen}>
        <DialogContent className="max-w-3xl">
          <DialogTitle className="sr-only">Photo of {name}</DialogTitle>
          <img
            src={imageUrl ?? imageThumbnailUrl}
            alt={name}
            className="max-h-[80vh] w-full rounded-md object-contain"
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

/**
 * Action control for adding/replacing/removing a property's cover photo. Self-contained (owns the hidden
 * file input + busy/error state); calls `onChange` after a successful mutation so the parent can refetch.
 */
export function PropertyPhotoButton({
  property,
  officeId,
  onChange,
}: {
  property: Pick<PropertySurface, "id" | "imageThumbnailUrl">;
  officeId?: string | null;
  onChange: () => void | Promise<void>;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasImage = Boolean(property.imageThumbnailUrl);

  const pickFile = () => inputRef.current?.click();

  const handleFileSelected = async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset so selecting the SAME file again still fires onChange.
    event.target.value = "";
    if (!file) return;
    setBusy(true);
    setError(null);
    try {
      await uploadPropertyImage(property.id, file, { officeId });
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to upload photo");
    } finally {
      setBusy(false);
    }
  };

  const handleRemove = async () => {
    setBusy(true);
    setError(null);
    try {
      await deletePropertyImage(property.id, { officeId });
      await onChange();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to remove photo");
    } finally {
      setBusy(false);
    }
  };

  const icon = busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />;

  return (
    <>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="hidden"
        onChange={handleFileSelected}
        aria-hidden="true"
        data-testid="property-photo-input"
      />
      {hasImage ? (
        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <Button type="button" variant="outline" size="sm" disabled={busy} className="min-h-[44px] md:min-h-0">
                {icon}
                Photo
              </Button>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={pickFile}>
              <Upload className="mr-2 h-4 w-4" />
              Change photo
            </DropdownMenuItem>
            <DropdownMenuItem onClick={handleRemove} className="text-red-600">
              <Trash2 className="mr-2 h-4 w-4" />
              Remove photo
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      ) : (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={pickFile}
          disabled={busy}
          className="min-h-[44px] md:min-h-0"
        >
          {icon}
          Add photo
        </Button>
      )}
      {error ? (
        <span className="text-xs text-red-600" role="alert">
          {error}
        </span>
      ) : null}
    </>
  );
}
