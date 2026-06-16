import { useEffect, useRef, useState, type ChangeEvent } from "react";
import { Bold, ImagePlus, Italic, Loader2 } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { getSignature, saveSignature, uploadSignatureLogo } from "@/hooks/use-signature";

const LOGO_TYPES = ["image/png", "image/jpeg", "image/gif", "image/webp"];
const LOGO_MAX_BYTES = 1_000_000;

/**
 * Lightweight contentEditable signature editor (no WYSIWYG dependency). The server sanitizes on save
 * and returns the canonical stored HTML, which we re-render — so what you see after Save is exactly
 * what will be appended to outbound mail. The logo uploads to R2 and is inserted as an <img> URL.
 */
export function SignatureSettings() {
  const editorRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [status, setStatus] = useState<{ tone: "ok" | "err"; text: string } | null>(null);

  useEffect(() => {
    let active = true;
    getSignature()
      .then((html) => {
        if (!active) return;
        if (editorRef.current) editorRef.current.innerHTML = html;
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, []);

  function exec(command: "bold" | "italic") {
    editorRef.current?.focus();
    document.execCommand(command, false);
  }

  async function onPickLogo(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) return;
    if (!LOGO_TYPES.includes(file.type)) {
      setStatus({ tone: "err", text: "Logo must be a PNG, JPEG, GIF, or WebP image." });
      return;
    }
    if (file.size > LOGO_MAX_BYTES) {
      setStatus({ tone: "err", text: "Logo must be under 1 MB." });
      return;
    }
    setUploading(true);
    setStatus(null);
    try {
      const url = await uploadSignatureLogo(file);
      editorRef.current?.focus();
      document.execCommand(
        "insertHTML",
        false,
        `<img src="${url}" alt="logo" style="max-width:200px;height:auto" />`,
      );
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : "Logo upload failed." });
    } finally {
      setUploading(false);
    }
  }

  async function onSave() {
    setSaving(true);
    setStatus(null);
    try {
      const saved = await saveSignature(editorRef.current?.innerHTML ?? "");
      if (editorRef.current) editorRef.current.innerHTML = saved; // reflect the sanitized result
      setStatus({ tone: "ok", text: saved ? "Signature saved." : "Signature cleared." });
    } catch (err) {
      setStatus({ tone: "err", text: err instanceof Error ? err.message : "Could not save the signature." });
    } finally {
      setSaving(false);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email signature</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-slate-500">
          Added below your message on emails you send from the CRM. Add a logo and basic formatting; leave it empty
          for no signature.
        </p>
        <div className="flex flex-wrap gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => exec("bold")} aria-label="Bold" disabled={loading}>
            <Bold className="h-4 w-4" />
          </Button>
          <Button type="button" variant="outline" size="sm" onClick={() => exec("italic")} aria-label="Italic" disabled={loading}>
            <Italic className="h-4 w-4" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => fileRef.current?.click()}
            disabled={loading || uploading}
          >
            {uploading ? <Loader2 className="h-4 w-4 animate-spin" /> : <ImagePlus className="h-4 w-4" />}
            <span className="ml-1">Logo</span>
          </Button>
          <input ref={fileRef} type="file" accept={LOGO_TYPES.join(",")} className="hidden" onChange={onPickLogo} />
        </div>
        <div
          ref={editorRef}
          contentEditable={!loading}
          role="textbox"
          aria-multiline="true"
          aria-label="Email signature editor"
          suppressContentEditableWarning
          className="min-h-[120px] rounded-md border border-slate-200 bg-white p-3 text-sm focus:outline-none focus:ring-2 focus:ring-slate-300"
        />
        <div className="flex items-center gap-3">
          <Button type="button" onClick={onSave} disabled={saving || loading}>
            {saving ? "Saving…" : "Save signature"}
          </Button>
          {status ? (
            <span className={status.tone === "ok" ? "text-sm font-medium text-emerald-600" : "text-sm font-medium text-red-600"}>
              {status.text}
            </span>
          ) : null}
        </div>
      </CardContent>
    </Card>
  );
}
