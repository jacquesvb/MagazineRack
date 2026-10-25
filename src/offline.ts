import { isTauri } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readFile, remove, writeFile } from "@tauri-apps/plugin-fs";
import { downloadArchivePdf } from "./archive";
import type { Publication } from "./types";

const PDF_DIRECTORY = "pdfs";
const appLocalData = { baseDir: BaseDirectory.AppLocalData } as const;

export async function downloadPublicationPdf(publication: Publication): Promise<string> {
  if (!isTauri()) throw new Error("Saving offline PDFs is available in the desktop app.");
  const bytes = new Uint8Array(await downloadArchivePdf(publication.source_url));
  const signature = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!signature.includes("%PDF-")) throw new Error("Archive.org did not return a valid PDF file.");

  if (!(await exists(PDF_DIRECTORY, appLocalData))) {
    await mkdir(PDF_DIRECTORY, { ...appLocalData, recursive: true });
  }
  const path = `${PDF_DIRECTORY}/${publication.id}.pdf`;
  await writeFile(path, bytes, appLocalData);
  return path;
}

export async function readOfflinePdf(path: string): Promise<Uint8Array> {
  return readFile(path, appLocalData);
}

export async function removeOfflinePdf(path: string): Promise<void> {
  if (await exists(path, appLocalData)) await remove(path, appLocalData);
}
