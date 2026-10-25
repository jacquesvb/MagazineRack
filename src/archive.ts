import { isTauri } from "@tauri-apps/api/core";
import { fetch as tauriFetch } from "@tauri-apps/plugin-http";
import type { PublicationDraft } from "./types";

export type ArchiveFile = { name: string; format?: string; size?: string };
type ArchiveRecord = { metadata?: Record<string, unknown>; files?: ArchiveFile[]; error?: string };

export function archiveDownloadUrl(identifier: string, filename: string): string {
  return `https://archive.org/download/${encodeURIComponent(identifier)}/${filename.split("/").map(encodeURIComponent).join("/")}`;
}

async function request(url: string, init?: RequestInit): Promise<Response> {
  return isTauri() ? tauriFetch(url, init) : fetch(url, init);
}

function firstValue(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).join(", ");
  return value == null ? "" : String(value);
}

function values(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  return value == null || value === "" ? [] : [String(value)];
}

function parseArchiveUrl(rawUrl: string): { identifier: string; filename?: string } {
  let url: URL;
  try { url = new URL(rawUrl.trim()); }
  catch { throw new Error("Enter a valid Archive.org URL."); }
  const host = url.hostname.toLowerCase();
  if (!(host === "archive.org" || host === "www.archive.org" || host.endsWith(".archive.org"))) {
    throw new Error("For now, publications must be hosted on Archive.org.");
  }
  const segments = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
  const detailsIndex = segments.indexOf("details");
  const downloadIndex = segments.indexOf("download");
  if (detailsIndex >= 0 && segments[detailsIndex + 1]) return { identifier: segments[detailsIndex + 1] };
  if (downloadIndex >= 0 && segments[downloadIndex + 1]) {
    return { identifier: segments[downloadIndex + 1], filename: segments.slice(downloadIndex + 2).join("/") || undefined };
  }
  throw new Error("Use an Archive.org item page or direct /download/ PDF link.");
}

export async function importArchivePdf(rawUrl: string): Promise<{ draft: PublicationDraft; pdfFiles: ArchiveFile[] }> {
  const { identifier, filename } = parseArchiveUrl(rawUrl);
  const response = await request(`https://archive.org/metadata/${encodeURIComponent(identifier)}`);
  if (!response.ok) throw new Error(`Archive.org returned ${response.status} while looking up this item.`);
  const record = await response.json() as ArchiveRecord;
  if (record.error || !record.metadata) throw new Error(record.error || "No Archive.org metadata was found for this item.");
  const files = (record.files || []).filter((file) => file.name.toLowerCase().endsWith(".pdf") || file.format?.toLowerCase().includes("pdf"));
  const selected = filename ? files.find((file) => file.name === filename) : files[0];
  if (!selected) throw new Error(filename ? "That PDF was not listed in the Archive.org item." : "No PDF file was found in this Archive.org item.");
  const metadata = record.metadata;
  const draft: PublicationDraft = {
    archive_identifier: identifier,
    pdf_filename: selected.name,
    source_url: archiveDownloadUrl(identifier, selected.name),
    title: firstValue(metadata.title) || selected.name.replace(/\.pdf$/i, ""),
    date: firstValue(metadata.date),
    publisher: firstValue(metadata.publisher),
    creator: firstValue(metadata.creator),
    description: firstValue(metadata.description || metadata.summary),
    language: firstValue(metadata.language),
    rights: firstValue(metadata.rights),
    subjects: values(metadata.subject),
    metadata_json: JSON.stringify(metadata),
    thumbnail_data: null,
  };
  return { draft, pdfFiles: files };
}

export async function downloadArchivePdf(url: string): Promise<ArrayBuffer> {
  const response = await request(url);
  if (!response.ok) throw new Error(`Could not load PDF (${response.status}). Check that the Archive.org item is available.`);
  return response.arrayBuffer();
}

export function imageFileToDataUrl(file: File): Promise<string> {
  const isGif = file.type === "image/gif" || file.name.toLowerCase().endsWith(".gif");
  if (!file.type.startsWith("image/") && !isGif) return Promise.reject(new Error("Choose an image file."));
  if (file.size > 4 * 1024 * 1024) return Promise.reject(new Error("Image must be smaller than 4 MB."));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Could not read image."));
    reader.onerror = () => reject(new Error("Could not read image."));
    reader.readAsDataURL(isGif && file.type !== "image/gif" ? new File([file], file.name, { type: "image/gif" }) : file);
  });
}
