import { api } from "@/lib/api";

/** The current user's stored signature HTML ("" when unset). Accepts an AbortSignal for cancellation. */
export async function getSignature(signal?: AbortSignal): Promise<string> {
  const res = await api<{ emailSignature: string }>("/users/me/signature", { signal });
  return res.emailSignature ?? "";
}

/** Save the signature. Server sanitizes authoritatively + returns the stored (sanitized) HTML. */
export async function saveSignature(emailSignature: string): Promise<string> {
  const res = await api<{ emailSignature: string }>("/users/me/signature", {
    method: "PATCH",
    json: { emailSignature },
  });
  return res.emailSignature ?? "";
}

/**
 * Upload a signature logo: ask for a presigned R2 PUT, upload the bytes straight to R2, then CONFIRM
 * — the server reads the object's real size and rejects/deletes it if oversized, and only then issues
 * the public URL. The client size check below is fail-fast UX only; the confirm step is the real,
 * non-bypassable size guard.
 */
export async function uploadSignatureLogo(file: File): Promise<string> {
  const { uploadUrl, r2Key, maxBytes } = await api<{ uploadUrl: string; r2Key: string; maxBytes: number }>(
    "/users/me/signature-logo/upload-url",
    { method: "POST", json: { contentType: file.type } },
  );
  if (file.size > maxBytes) {
    throw new Error("Logo must be under 1 MB.");
  }
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
  if (!put.ok) throw new Error(`Logo upload failed (storage returned ${put.status}).`);
  const { publicUrl } = await api<{ publicUrl: string }>("/users/me/signature-logo/confirm", {
    method: "POST",
    json: { r2Key },
  });
  return publicUrl;
}
