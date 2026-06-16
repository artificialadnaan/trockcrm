import { api } from "@/lib/api";

/** The current user's stored signature HTML ("" when unset). */
export async function getSignature(): Promise<string> {
  const res = await api<{ emailSignature: string }>("/users/me/signature");
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
 * Upload a signature logo: ask the server for a presigned R2 PUT (matching the field-photo upload
 * convention), PUT the bytes straight to R2, and return the permanent public URL to drop into the
 * signature as <img src>. Mirrors the field-photo presigned flow — bytes never pass through our API.
 */
export async function uploadSignatureLogo(file: File): Promise<string> {
  const { uploadUrl, publicUrl } = await api<{ uploadUrl: string; publicUrl: string; maxBytes: number }>(
    "/users/me/signature-logo/upload-url",
    { method: "POST", json: { contentType: file.type } },
  );
  const put = await fetch(uploadUrl, {
    method: "PUT",
    body: file,
    headers: { "Content-Type": file.type },
  });
  if (!put.ok) throw new Error(`Logo upload failed (storage returned ${put.status}).`);
  return publicUrl;
}
