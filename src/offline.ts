import { isTauri } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { downloadArchivePdf } from "./archive";
import type { Publication } from "./types";

const appLocalData = { baseDir: BaseDirectory.AppLocalData } as const;

function safePathSegment(value: string, fallback: string): string {
  const safe = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().replace(/[. ]+$/g, "");
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || /^[a-z]:[\\/]/i.test(path);
}

export function collectionPdfFolderPath(downloadRoot: string, collectionName: string): string {
  return `${downloadRoot.replace(/[\\/]+$/g, "")}/${safePathSegment(collectionName, "Collection")}`;
}

export async function downloadPublicationPdf(publication: Publication, collectionName: string, downloadRoot: string): Promise<string> {
  if (!isTauri()) throw new Error("Saving offline PDFs is available in the desktop app.");
  if (!downloadRoot) throw new Error("Choose a folder for saved publications first.");
  const bytes = new Uint8Array(await downloadArchivePdf(publication.source_url));
  const signature = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!signature.includes("%PDF-")) throw new Error("Archive.org did not return a valid PDF file.");

  const directory = collectionPdfFolderPath(downloadRoot, collectionName);
  await mkdir(directory, { recursive: true });

  const leaf = publication.pdf_filename.split(/[\\/]/).pop() || "publication.pdf";
  let filename = safePathSegment(leaf, "publication.pdf");
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  let path = `${directory}/${filename}`;
  if (await exists(path) && publication.local_pdf_path !== path) {
    const extensionIndex = filename.toLowerCase().lastIndexOf(".pdf");
    filename = `${filename.slice(0, extensionIndex)} (${publication.id.slice(0, 8)}).pdf`;
    path = `${directory}/${filename}`;
    if (await exists(path) && publication.local_pdf_path !== path) {
      throw new Error(`A different publication already uses “${filename}” in this collection folder.`);
    }
  }
  await writeFile(path, bytes);
  return path;
}

export async function readOfflinePdf(path: string): Promise<Uint8Array> {
  return isAbsolutePath(path) ? readFile(path) : readFile(path, appLocalData);
}

export async function removeOfflinePdf(path: string): Promise<void> {
  const options = isAbsolutePath(path) ? undefined : appLocalData;
  if (await exists(path, options)) await remove(path, options);
}
