import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "@tauri-apps/api/core";
import type { Collection, Publication, PublicationDraft } from "./types";

type LocalData = { collections: Collection[]; publications: Publication[]; links: Record<string, string[]> };
const STORAGE_KEY = "magazine-rack-data-v1";
let database: Promise<Database> | undefined;

const initialData = (): LocalData => ({ collections: [], publications: [], links: {} });
const readLocal = (): LocalData => {
  try { return JSON.parse(localStorage.getItem(STORAGE_KEY) || "null") || initialData(); }
  catch { return initialData(); }
};
const saveLocal = (data: LocalData) => localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

async function db() {
  database ||= Database.load("sqlite:magazinerack.db").then(async (conn) => {
    await conn.execute(`CREATE TABLE IF NOT EXISTS collections (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', thumbnail_data TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL
    )`);
    await conn.execute(`CREATE TABLE IF NOT EXISTS publications (
      id TEXT PRIMARY KEY, archive_identifier TEXT NOT NULL, pdf_filename TEXT NOT NULL, source_url TEXT NOT NULL,
      title TEXT NOT NULL, date TEXT NOT NULL DEFAULT '', publisher TEXT NOT NULL DEFAULT '', creator TEXT NOT NULL DEFAULT '',
      description TEXT NOT NULL DEFAULT '', language TEXT NOT NULL DEFAULT '', rights TEXT NOT NULL DEFAULT '',
      subjects_json TEXT NOT NULL DEFAULT '[]', metadata_json TEXT NOT NULL DEFAULT '{}', overrides_json TEXT NOT NULL DEFAULT '{}',
      thumbnail_data TEXT, local_pdf_path TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
      UNIQUE(archive_identifier, pdf_filename)
    )`);
    const publicationColumns = await conn.select<Array<{ name: string }>>("PRAGMA table_info(publications)");
    if (!publicationColumns.some((column) => column.name === "local_pdf_path")) {
      await conn.execute("ALTER TABLE publications ADD COLUMN local_pdf_path TEXT");
    }
    await conn.execute(`CREATE TABLE IF NOT EXISTS collection_publications (
      collection_id TEXT NOT NULL REFERENCES collections(id) ON DELETE CASCADE,
      publication_id TEXT NOT NULL REFERENCES publications(id) ON DELETE CASCADE,
      position INTEGER NOT NULL DEFAULT 0, added_at TEXT NOT NULL,
      PRIMARY KEY(collection_id, publication_id)
    )`);
    await conn.execute("PRAGMA foreign_keys = ON");
    return conn;
  });
  return database;
}

export async function getCollections(): Promise<Collection[]> {
  if (!isTauri()) return readLocal().collections.map((item) => ({
    ...item,
    publication_count: readLocal().links[item.id]?.length || 0,
  })).sort((a, b) => a.name.localeCompare(b.name));
  const conn = await db();
  return conn.select<Collection[]>(`SELECT c.*, COUNT(cp.publication_id) AS publication_count
    FROM collections c LEFT JOIN collection_publications cp ON cp.collection_id = c.id
    GROUP BY c.id ORDER BY c.name COLLATE NOCASE`);
}

export async function getPublications(collectionId?: string | null): Promise<Publication[]> {
  if (!isTauri()) {
    const data = readLocal();
    const ids = collectionId ? data.links[collectionId] || [] : data.publications.map((item) => item.id);
    return ids.map((id) => data.publications.find((item) => item.id === id)).filter((item): item is Publication => !!item)
      .map((item) => ({ ...item, local_pdf_path: item.local_pdf_path || null }));
  }
  const conn = await db();
  const rows = collectionId
    ? await conn.select<Array<Omit<Publication, "subjects"> & { subjects_json: string }>>(
        `SELECT p.*, p.subjects_json FROM publications p JOIN collection_publications cp ON cp.publication_id = p.id
         WHERE cp.collection_id = $1 ORDER BY cp.position, p.date DESC, p.title COLLATE NOCASE`, [collectionId])
    : await conn.select<Array<Omit<Publication, "subjects"> & { subjects_json: string }>>(
        "SELECT * FROM publications ORDER BY date DESC, title COLLATE NOCASE");
  return rows.map((row) => ({ ...row, subjects: parseSubjects(row.subjects_json) }));
}

function parseSubjects(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]") as string[]; } catch { return []; }
}

export async function saveCollection(input: { id?: string; name: string; description: string; thumbnail_data: string | null }): Promise<void> {
  const timestamp = now();
  if (!isTauri()) {
    const data = readLocal();
    const existing = data.collections.find((item) => item.id === input.id);
    if (existing) Object.assign(existing, input, { updated_at: timestamp });
    else data.collections.push({ ...input, id: makeId(), created_at: timestamp, updated_at: timestamp });
    saveLocal(data); return;
  }
  const conn = await db();
  if (input.id) await conn.execute("UPDATE collections SET name=$1, description=$2, thumbnail_data=$3, updated_at=$4 WHERE id=$5",
    [input.name, input.description, input.thumbnail_data, timestamp, input.id]);
  else await conn.execute("INSERT INTO collections (id,name,description,thumbnail_data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
    [makeId(), input.name, input.description, input.thumbnail_data, timestamp]);
}

export async function deleteCollection(id: string): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(); data.collections = data.collections.filter((item) => item.id !== id); delete data.links[id]; saveLocal(data); return;
  }
  const conn = await db(); await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1", [id]); await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
}

export async function savePublication(draft: PublicationDraft, collectionId: string | null, editId?: string): Promise<void> {
  const timestamp = now();
  const subjectsJson = JSON.stringify(draft.subjects);
  if (!isTauri()) {
    const data = readLocal();
    let publication = editId ? data.publications.find((item) => item.id === editId) : data.publications.find((item) => item.archive_identifier === draft.archive_identifier && item.pdf_filename === draft.pdf_filename);
    if (publication) Object.assign(publication, draft, { subjects: draft.subjects, updated_at: timestamp });
    else {
      publication = { ...draft, id: makeId(), subjects: draft.subjects, overrides_json: "{}", local_pdf_path: null, created_at: timestamp, updated_at: timestamp };
      data.publications.push(publication);
    }
    if (collectionId) {
      const links = data.links[collectionId] || (data.links[collectionId] = []);
      if (!links.includes(publication.id)) links.push(publication.id);
    }
    saveLocal(data); return;
  }
  const conn = await db();
  let id = editId;
  if (id) {
    await conn.execute(`UPDATE publications SET archive_identifier=$1,pdf_filename=$2,source_url=$3,title=$4,date=$5,publisher=$6,
      creator=$7,description=$8,language=$9,rights=$10,subjects_json=$11,metadata_json=$12,thumbnail_data=$13,updated_at=$14 WHERE id=$15`,
      [draft.archive_identifier, draft.pdf_filename, draft.source_url, draft.title, draft.date, draft.publisher, draft.creator,
        draft.description, draft.language, draft.rights, subjectsJson, draft.metadata_json, draft.thumbnail_data, timestamp, id]);
  } else {
    const matches = await conn.select<Array<{ id: string }>>("SELECT id FROM publications WHERE archive_identifier=$1 AND pdf_filename=$2", [draft.archive_identifier, draft.pdf_filename]);
    id = matches[0]?.id || makeId();
    if (matches.length) {
      await conn.execute(`UPDATE publications SET source_url=$1,title=$2,date=$3,publisher=$4,creator=$5,description=$6,language=$7,
        rights=$8,subjects_json=$9,metadata_json=$10,thumbnail_data=$11,updated_at=$12 WHERE id=$13`,
        [draft.source_url, draft.title, draft.date, draft.publisher, draft.creator, draft.description, draft.language, draft.rights,
          subjectsJson, draft.metadata_json, draft.thumbnail_data, timestamp, id]);
    } else {
      await conn.execute(`INSERT INTO publications (id,archive_identifier,pdf_filename,source_url,title,date,publisher,creator,description,
        language,rights,subjects_json,metadata_json,overrides_json,thumbnail_data,created_at,updated_at)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,'{}',$14,$15,$15)`,
        [id, draft.archive_identifier, draft.pdf_filename, draft.source_url, draft.title, draft.date, draft.publisher, draft.creator,
          draft.description, draft.language, draft.rights, subjectsJson, draft.metadata_json, draft.thumbnail_data, timestamp]);
    }
  }
  if (collectionId) {
    const linked = await conn.select<Array<{ publication_id: string }>>("SELECT publication_id FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, id]);
    if (!linked.length) await conn.execute("INSERT INTO collection_publications (collection_id,publication_id,position,added_at) VALUES ($1,$2,COALESCE((SELECT MAX(position)+1 FROM collection_publications WHERE collection_id=$1),0),$3)", [collectionId, id, timestamp]);
  }
}

export async function setLocalPdfPath(publicationId: string, path: string | null): Promise<void> {
  if (!isTauri()) {
    const data = readLocal();
    const publication = data.publications.find((item) => item.id === publicationId);
    if (!publication) throw new Error("Publication not found.");
    publication.local_pdf_path = path;
    saveLocal(data);
    return;
  }
  const conn = await db();
  await conn.execute("UPDATE publications SET local_pdf_path=$1 WHERE id=$2", [path, publicationId]);
}

export async function removePublicationFromCollection(publicationId: string, collectionId: string): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(); data.links[collectionId] = (data.links[collectionId] || []).filter((id) => id !== publicationId); saveLocal(data); return;
  }
  const conn = await db(); await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, publicationId]);
}

export async function deletePublication(publicationId: string): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(); data.publications = data.publications.filter((item) => item.id !== publicationId);
    Object.keys(data.links).forEach((id) => { data.links[id] = data.links[id].filter((linked) => linked !== publicationId); }); saveLocal(data); return;
  }
  const conn = await db(); await conn.execute("DELETE FROM collection_publications WHERE publication_id=$1", [publicationId]); await conn.execute("DELETE FROM publications WHERE id=$1", [publicationId]);
}
