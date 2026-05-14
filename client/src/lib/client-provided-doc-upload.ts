import { uploadFile } from "@/hooks/use-files";
import { CLIENT_PROVIDED_DOCS_TAG, inferClientProvidedDocsCategory } from "@/lib/lead-attachment-routing";

export function removeUploadedFileFromQueue(currentFiles: File[], uploadedFile: File) {
  let removed = false;
  return currentFiles.filter((file) => {
    if (!removed && file === uploadedFile) {
      removed = true;
      return false;
    }
    return true;
  });
}

export async function uploadClientProvidedDocsWithQueueRemoval(
  files: File[],
  leadId: string,
  onUploaded: (file: File) => void
) {
  for (const file of files) {
    await uploadFile({
      file,
      leadId,
      category: inferClientProvidedDocsCategory(file),
      tags: [CLIENT_PROVIDED_DOCS_TAG],
    });
    onUploaded(file);
  }
}
