import { isTauri } from "@tauri-apps/api/core";
import { BaseDirectory, exists, mkdir, readFile, remove, stat, writeFile } from "@tauri-apps/plugin-fs";
import { downloadArchivePdf } from "./archive";
import type { Publication } from "./types";

const appLocalData = { baseDir: BaseDirectory.AppLocalData } as const;

function safePathSegment(value: string, fallback: string): string {
  const safe = value.replace(/[<>:"/\\|?*\u0000-\u001f]/g, "-").trim().replace(/[. ]+$/g, "");
  return safe && safe !== "." && safe !== ".." ? safe : fallback;
}

function isAbsolutePath(path: string): boolean {
  return path.startsWith("/") || path.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(path);
}

function isWindowsPath(path: string): boolean {
  return path.startsWith("\\\\") || /^[a-z]:[\\/]/i.test(path);
}

function joinPath(directory: string, leaf: string): string {
  const separator = isWindowsPath(directory) ? "\\" : "/";
  return `${directory.replace(/[\\/]+$/g, "")}${separator}${leaf}`;
}

export function collectionPdfFolderPath(downloadRoot: string, collectionName: string): string {
  return joinPath(downloadRoot, safePathSegment(collectionName, "Collection"));
}

export async function downloadPublicationPdf(publication: Publication, collectionName: string, downloadRoot: string): Promise<string> {
  if (!isTauri()) throw new Error("Saving offline PDFs is available in the desktop app.");
  if (!downloadRoot) throw new Error("Choose a folder for saved publications first.");
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await downloadArchivePdf(publication.source_url));
  } catch (error) {
    throw new Error(`Could not download the PDF from Archive.org: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (!bytes.length) throw new Error("Archive.org returned an empty file.");
  const signature = new TextDecoder().decode(bytes.subarray(0, Math.min(bytes.length, 1024)));
  if (!signature.includes("%PDF-")) throw new Error("Archive.org did not return a valid PDF file.");

  const directory = collectionPdfFolderPath(downloadRoot, collectionName);
  try {
    await mkdir(directory, { recursive: true });
  } catch (error) {
    throw new Error(`Could not create the collection folder “${directory}”: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    if (!(await stat(directory)).isDirectory) throw new Error("The selected collection path is not a folder.");
  } catch (error) {
    throw new Error(`Could not access the collection folder “${directory}”: ${error instanceof Error ? error.message : String(error)}`);
  }

  const leaf = publication.pdf_filename.split(/[\\/]/).pop() || "publication.pdf";
  let filename = safePathSegment(leaf, "publication.pdf");
  if (!/\.pdf$/i.test(filename)) filename += ".pdf";
  let path = joinPath(directory, filename);
  try {
    if (await exists(path) && publication.local_pdf_path !== path) {
      const extensionIndex = filename.toLowerCase().lastIndexOf(".pdf");
      filename = `${filename.slice(0, extensionIndex)} (${publication.id.slice(0, 8)}).pdf`;
      path = joinPath(directory, filename);
      if (await exists(path) && publication.local_pdf_path !== path) {
        throw new Error(`A different publication already uses “${filename}” in this collection folder.`);
      }
    }
  } catch (error) {
    throw new Error(`Could not check the save location “${path}”: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    await writeFile(path, bytes);
    const savedFile = await stat(path);
    if (!savedFile.isFile || savedFile.size !== bytes.byteLength) {
      throw new Error(`The saved file size did not match the downloaded PDF (${savedFile.size} of ${bytes.byteLength} bytes).`);
    }
  } catch (error) {
    throw new Error(`Could not save the PDF to “${path}”: ${error instanceof Error ? error.message : String(error)}`);
  }
  return path;
}

export async function readOfflinePdf(path: string): Promise<Uint8Array> {
  return isAbsolutePath(path) ? readFile(path) : readFile(path, appLocalData);
}

export async function removeOfflinePdf(path: string): Promise<void> {
  const options = isAbsolutePath(path) ? undefined : appLocalData;
  if (await exists(path, options)) await remove(path, options);
}
