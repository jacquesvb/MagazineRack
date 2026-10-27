import type { Collection, Publication, PublicationDraft } from "./types";

export const COLLECTION_FILE_FORMAT = "magazine-rack-collection";
export const COLLECTION_FILE_VERSION = 1;

export interface SharedCollection {
  format: typeof COLLECTION_FILE_FORMAT;
  version: typeof COLLECTION_FILE_VERSION;
  exported_at: string;
  collection: {
    name: string;
    description: string;
    thumbnail_data: string | null;
  };
  publications: PublicationDraft[];
}

export function createSharedCollection(collection: Collection, publications: Publication[]): SharedCollection {
  return {
    format: COLLECTION_FILE_FORMAT,
    version: COLLECTION_FILE_VERSION,
    exported_at: new Date().toISOString(),
    collection: {
      name: collection.name,
      description: collection.description,
      thumbnail_data: collection.thumbnail_data,
    },
    publications: publications.map(({ archive_identifier, pdf_filename, source_url, title, date, publisher, creator,
      description, language, rights, subjects, metadata_json, thumbnail_data }) => ({
      archive_identifier,
      pdf_filename,
      source_url,
      title,
      date,
      publisher,
      creator,
      description,
      language,
      rights,
      subjects: [...(subjects || [])],
      metadata_json,
      thumbnail_data,
    })),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") throw new Error(`Invalid collection file: “${field}” must be text.`);
  return value;
}

function optionalImage(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string" || (!value.startsWith("data:image/") && value.length > 0)) {
    throw new Error(`Invalid collection file: “${field}” must be an embedded image or empty.`);
  }
  return value || null;
}

function archiveDownloadSource(value: unknown, field: string): string {
  const source = requiredString(value, field);
  let url: URL;
  try { url = new URL(source); }
  catch { throw new Error(`Invalid collection file: “${field}” must be an Archive.org download link.`); }
  if (url.protocol !== "https:" || !["archive.org", "www.archive.org"].includes(url.hostname.toLowerCase()) ||
      url.username || url.password || !url.pathname.startsWith("/download/")) {
    throw new Error(`Invalid collection file: “${field}” must be an Archive.org download link.`);
  }
  return url.toString();
}

export function parseSharedCollection(text: string): SharedCollection {
  let parsed: unknown;
  try { parsed = JSON.parse(text); }
  catch { throw new Error("This file is not valid JSON."); }
  if (!isRecord(parsed) || parsed.format !== COLLECTION_FILE_FORMAT) {
    throw new Error("This is not a Magazine Rack collection file.");
  }
  if (parsed.version !== COLLECTION_FILE_VERSION) {
    throw new Error(`This collection file uses an unsupported version (${String(parsed.version)}).`);
  }
  if (!isRecord(parsed.collection) || !Array.isArray(parsed.publications)) {
    throw new Error("This collection file is missing its collection or publication data.");
  }

  const collection = {
    name: requiredString(parsed.collection.name, "collection.name").trim(),
    description: requiredString(parsed.collection.description, "collection.description"),
    thumbnail_data: optionalImage(parsed.collection.thumbnail_data, "collection.thumbnail_data"),
  };
  if (!collection.name) throw new Error("This collection file does not have a collection name.");

  const publications = parsed.publications.map((value, index): PublicationDraft => {
    if (!isRecord(value)) throw new Error(`Invalid publication at position ${index + 1}.`);
    if (!Array.isArray(value.subjects) || !value.subjects.every((subject) => typeof subject === "string")) {
      throw new Error(`Invalid subjects for publication ${index + 1}.`);
    }
    const archiveIdentifier = requiredString(value.archive_identifier, "archive_identifier");
    const pdfFilename = requiredString(value.pdf_filename, "pdf_filename");
    if (!archiveIdentifier.trim() || !pdfFilename.trim()) throw new Error(`Publication ${index + 1} is missing its Archive.org item or PDF filename.`);
    const thumbnail = optionalImage(value.thumbnail_data, `publications[${index}].thumbnail_data`);
    return {
      archive_identifier: archiveIdentifier,
      pdf_filename: pdfFilename,
      source_url: archiveDownloadSource(value.source_url, `publications[${index}].source_url`),
      title: requiredString(value.title, "title"),
      date: requiredString(value.date, "date"),
      publisher: requiredString(value.publisher, "publisher"),
      creator: requiredString(value.creator, "creator"),
      description: requiredString(value.description, "description"),
      language: requiredString(value.language, "language"),
      rights: requiredString(value.rights, "rights"),
      subjects: value.subjects as string[],
      metadata_json: requiredString(value.metadata_json, "metadata_json"),
      thumbnail_data: thumbnail,
    };
  });

  return {
    format: COLLECTION_FILE_FORMAT,
    version: COLLECTION_FILE_VERSION,
    exported_at: typeof parsed.exported_at === "string" ? parsed.exported_at : "",
    collection,
    publications,
  };
}

export function sharedCollectionFilename(shared: SharedCollection): string {
  return `${shared.collection.name.trim().replace(/[^a-z0-9-_]+/gi, "-").replace(/^-+|-+$/g, "") || "collection"}.magazinerack.json`;
}

export function downloadSharedCollection(shared: SharedCollection) {
  const filename = sharedCollectionFilename(shared);
  const blob = new Blob([JSON.stringify(shared, null, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.append(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
