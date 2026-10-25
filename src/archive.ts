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

function sniffImageType(bytes: Uint8Array): string | null {
  if (bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38) return "image/gif";
  if (bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47) return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) return "image/webp";
  if (bytes[4] === 0x66 && bytes[5] === 0x74 && bytes[6] === 0x79 && bytes[7] === 0x70 &&
    (new TextDecoder().decode(bytes.subarray(8, 12)) === "avif" || new TextDecoder().decode(bytes.subarray(8, 12)) === "avis")) return "image/avif";
  return null;
}

export async function imageUrlToDataUrl(rawUrl: string): Promise<string> {
  let url: URL;
  try { url = new URL(rawUrl.trim()); }
  catch { throw new Error("The dropped image does not contain a valid URL."); }
  const hostname = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  const isIpAddress = /^\d{1,3}(\.\d{1,3}){3}$/.test(hostname) || hostname.includes(":");
  if (url.protocol !== "https:" || url.username || url.password || isIpAddress || !hostname.includes(".") || hostname === "localhost" || hostname.endsWith(".localhost") || hostname.endsWith(".local") || hostname.endsWith(".lan") || hostname.endsWith(".internal") || hostname.endsWith(".home.arpa")) {
    throw new Error("Only public HTTPS image links can be imported. Use the file picker for this image.");
  }

  const response = isTauri()
    ? await tauriFetch(url.toString(), { connectTimeout: 20_000, maxRedirections: 4 })
    : await fetch(url.toString());
  if (!response.ok) throw new Error(`The image site returned ${response.status}.`);
  let mimeType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase() || "";
  const contentLength = Number(response.headers.get("content-length") || 0);
  if (contentLength > 4 * 1024 * 1024) throw new Error("Image must be smaller than 4 MB.");
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (!bytes.length || bytes.length > 4 * 1024 * 1024) throw new Error("Image must be between 1 byte and 4 MB.");
  if (!mimeType.startsWith("image/")) mimeType = sniffImageType(bytes) || "";
  if (!mimeType.startsWith("image/")) throw new Error("The dropped link did not return a supported image.");

  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, Math.min(index + 0x8000, bytes.length)));
  }
  return `data:${mimeType};base64,${btoa(binary)}`;
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
