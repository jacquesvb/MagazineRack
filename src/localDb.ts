import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "@tauri-apps/api/core";
import { removeOfflinePdf } from "./offline";
import type { Collection, Publication, PublicationDraft } from "./types";
import type { SharedCollection } from "./collectionTransfer";

type LocalData = { collections: Collection[]; publications: Publication[]; links: Record<string, string[]> };
type LegacyIds = { collections: string[]; publications: string[] };

const STORAGE_KEY = "magazine-rack-data-v1";
const LEGACY_IDS_KEY = "magazine-rack-legacy-catalog-ids-v1";
const LEGACY_GUEST_CLEARED_KEY = "magazine-rack-legacy-guest-cleared-v1";
const ACCOUNT_CACHE_MIGRATED_KEY = "magazine-rack-account-cache-migrated-to-local-v1";
const databases = new Map<string, Promise<Database>>();
const initialData = (): LocalData => ({ collections: [], publications: [], links: {} });
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();
const storageKey = (userId?: string | null) => userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;

function readLocal(userId?: string | null): LocalData {
  try { return JSON.parse(localStorage.getItem(storageKey(userId)) || "null") || initialData(); }
  catch { return initialData(); }
}

function saveLocal(data: LocalData, userId?: string | null) {
  localStorage.setItem(storageKey(userId), JSON.stringify(data));
}

async function db(userId?: string | null) {
  const key = userId || "local";
  let database = databases.get(key);
  if (!database) {
    const filename = userId ? `sqlite:magazinerack-${userId}.db` : "sqlite:magazinerack.db";
    database = Database.load(filename).then(async (conn) => {
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
      const columns = await conn.select<Array<{ name: string }>>("PRAGMA table_info(publications)");
      if (!columns.some((column) => column.name === "local_pdf_path")) {
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
    databases.set(key, database);
  }
  return database;
}

function parseSubjects(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]") as string[]; } catch { return []; }
}

export async function getCollections(userId?: string | null): Promise<Collection[]> {
  if (!isTauri()) {
    const data = readLocal(userId);
    return data.collections.map((collection) => ({
      ...collection,
      publication_count: data.links[collection.id]?.length || 0,
    })).sort((a, b) => a.name.localeCompare(b.name));
  }
  const conn = await db(userId);
  return conn.select<Collection[]>(`SELECT c.*, COUNT(cp.publication_id) AS publication_count
    FROM collections c LEFT JOIN collection_publications cp ON cp.collection_id = c.id
    GROUP BY c.id ORDER BY c.name COLLATE NOCASE`);
}

export async function getPublications(collectionId?: string | null, userId?: string | null): Promise<Publication[]> {
  if (!isTauri()) {
    const data = readLocal(userId);
    const ids = collectionId ? data.links[collectionId] || [] : data.publications.map((item) => item.id);
    return ids.map((id) => data.publications.find((item) => item.id === id)).filter((item): item is Publication => !!item)
      .map((item) => ({ ...item, local_pdf_path: item.local_pdf_path || null }));
  }
  const conn = await db(userId);
  const rows = collectionId
    ? await conn.select<Array<Omit<Publication, "subjects"> & { subjects_json: string }>>(
        `SELECT p.*, p.subjects_json FROM publications p JOIN collection_publications cp ON cp.publication_id = p.id
         WHERE cp.collection_id = $1 ORDER BY cp.position, p.date DESC, p.title COLLATE NOCASE`, [collectionId])
    : await conn.select<Array<Omit<Publication, "subjects"> & { subjects_json: string }>>(
        "SELECT * FROM publications ORDER BY date DESC, title COLLATE NOCASE");
  return rows.map((row) => ({ ...row, subjects: parseSubjects(row.subjects_json) }));
}

export async function saveCollection(input: { id?: string; name: string; description: string; thumbnail_data: string | null }, userId?: string | null): Promise<string> {
  const timestamp = now();
  const id = input.id || makeId();
  if (!isTauri()) {
    const data = readLocal(userId);
    const current = data.collections.find((item) => item.id === id);
    if (current) Object.assign(current, input, { updated_at: timestamp });
    else data.collections.push({ ...input, id, created_at: timestamp, updated_at: timestamp });
    saveLocal(data, userId);
    return id;
  }
  const conn = await db(userId);
  const current = await conn.select<Array<{ id: string }>>("SELECT id FROM collections WHERE id=$1", [id]);
  if (current.length) {
    await conn.execute("UPDATE collections SET name=$1,description=$2,thumbnail_data=$3,updated_at=$4 WHERE id=$5",
      [input.name, input.description, input.thumbnail_data, timestamp, id]);
  } else {
    await conn.execute("INSERT INTO collections (id,name,description,thumbnail_data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
      [id, input.name, input.description, input.thumbnail_data, timestamp]);
  }
  return id;
}

export async function importSharedCollection(shared: SharedCollection): Promise<{ collectionId: string; imported: number; alreadyHad: number; skipped: number; merged: boolean }> {
  const existingCollection = (await getCollections()).find((collection) =>
    collection.name.trim().toLocaleLowerCase() === shared.collection.name.trim().toLocaleLowerCase());
  const collectionId = existingCollection?.id || await saveCollection(shared.collection);
  const existingPublications = await getPublications();
  const knownPublications = new Map<string, Pick<Publication, "id">>(existingPublications.map((publication) =>
    [`${publication.archive_identifier}\u0000${publication.pdf_filename}`, publication]));
  const memberKeys = new Set((await getPublications(collectionId)).map((publication) =>
    `${publication.archive_identifier}\u0000${publication.pdf_filename}`));
  let imported = 0;
  let alreadyHad = 0;
  let skipped = 0;
  for (const draft of shared.publications) {
    const key = `${draft.archive_identifier}\u0000${draft.pdf_filename}`;
    if (memberKeys.has(key)) {
      skipped += 1;
      continue;
    }
    const existing = knownPublications.get(key);
    if (existing) {
      await addPublicationToCollection(existing.id, collectionId);
      alreadyHad += 1;
    } else {
      const id = await savePublication(draft, collectionId);
      knownPublications.set(key, { id });
      imported += 1;
    }
    memberKeys.add(key);
  }
  return { collectionId, imported, alreadyHad, skipped, merged: !!existingCollection };
}

async function addPublicationToCollection(publicationId: string, collectionId: string): Promise<void> {
  const timestamp = now();
  if (!isTauri()) {
    const data = readLocal();
    const links = data.links[collectionId] || (data.links[collectionId] = []);
    if (!links.includes(publicationId)) links.push(publicationId);
    saveLocal(data);
    return;
  }
  const conn = await db();
  const linked = await conn.select<Array<{ publication_id: string }>>(
    "SELECT publication_id FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, publicationId]);
  if (!linked.length) {
    await conn.execute("INSERT INTO collection_publications (collection_id,publication_id,position,added_at) VALUES ($1,$2,COALESCE((SELECT MAX(position)+1 FROM collection_publications WHERE collection_id=$1),0),$3)", [collectionId, publicationId, timestamp]);
  }
}

export async function deleteCollection(id: string, userId?: string | null): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    data.collections = data.collections.filter((item) => item.id !== id);
    delete data.links[id];
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1", [id]);
  await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
}

export async function savePublication(draft: PublicationDraft, collectionId: string | null, editId?: string, userId?: string | null): Promise<string> {
  const timestamp = now();
  const subjectsJson = JSON.stringify(draft.subjects);
  let data: LocalData | undefined;
  let conn: Database | undefined;
  let current: Publication | undefined;
  let sqlCurrent: { id: string; created_at: string; overrides_json: string } | undefined;

  if (!isTauri()) {
    data = readLocal(userId);
    current = editId
      ? data.publications.find((item) => item.id === editId)
      : data.publications.find((item) => item.archive_identifier === draft.archive_identifier && item.pdf_filename === draft.pdf_filename);
  } else {
    conn = await db(userId);
    const rows = editId
      ? await conn.select<Array<{ id: string; created_at: string; overrides_json: string }>>("SELECT id,created_at,overrides_json FROM publications WHERE id=$1", [editId])
      : await conn.select<Array<{ id: string; created_at: string; overrides_json: string }>>(
          "SELECT id,created_at,overrides_json FROM publications WHERE archive_identifier=$1 AND pdf_filename=$2", [draft.archive_identifier, draft.pdf_filename]);
    sqlCurrent = rows[0];
  }

  const id = editId || current?.id || sqlCurrent?.id || makeId();
  const createdAt = current?.created_at || sqlCurrent?.created_at || timestamp;
  const overridesJson = current?.overrides_json || sqlCurrent?.overrides_json || "{}";

  if (!isTauri()) {
    const records = data!;
    let publication = records.publications.find((item) => item.id === id);
    if (publication) Object.assign(publication, draft, { subjects: draft.subjects, updated_at: timestamp });
    else {
      publication = { ...draft, id, subjects: draft.subjects, overrides_json: overridesJson, local_pdf_path: null, created_at: createdAt, updated_at: timestamp };
      records.publications.push(publication);
    }
    if (collectionId) {
      const links = records.links[collectionId] || (records.links[collectionId] = []);
      if (!links.includes(id)) links.push(id);
    }
    saveLocal(records, userId);
    return id;
  }

  const dbConn = conn!;
  const exists = sqlCurrent || (editId ? (await dbConn.select<Array<{ id: string }>>("SELECT id FROM publications WHERE id=$1", [id]))[0] : undefined);
  if (exists) {
    await dbConn.execute(`UPDATE publications SET archive_identifier=$1,pdf_filename=$2,source_url=$3,title=$4,date=$5,publisher=$6,
      creator=$7,description=$8,language=$9,rights=$10,subjects_json=$11,metadata_json=$12,overrides_json=$13,thumbnail_data=$14,updated_at=$15 WHERE id=$16`,
      [draft.archive_identifier, draft.pdf_filename, draft.source_url, draft.title, draft.date, draft.publisher, draft.creator,
        draft.description, draft.language, draft.rights, subjectsJson, draft.metadata_json, overridesJson, draft.thumbnail_data, timestamp, id]);
  } else {
    await dbConn.execute(`INSERT INTO publications (id,archive_identifier,pdf_filename,source_url,title,date,publisher,creator,description,
      language,rights,subjects_json,metadata_json,overrides_json,thumbnail_data,created_at,updated_at)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$16)`,
      [id, draft.archive_identifier, draft.pdf_filename, draft.source_url, draft.title, draft.date, draft.publisher, draft.creator,
        draft.description, draft.language, draft.rights, subjectsJson, draft.metadata_json, overridesJson, draft.thumbnail_data, createdAt]);
  }
  if (collectionId) {
    const linked = await dbConn.select<Array<{ publication_id: string }>>("SELECT publication_id FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, id]);
    if (!linked.length) await dbConn.execute("INSERT INTO collection_publications (collection_id,publication_id,position,added_at) VALUES ($1,$2,COALESCE((SELECT MAX(position)+1 FROM collection_publications WHERE collection_id=$1),0),$3)", [collectionId, id, timestamp]);
  }
  return id;
}

export async function setLocalPdfPath(publicationId: string, path: string | null, userId?: string | null): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    const publication = data.publications.find((item) => item.id === publicationId);
    if (!publication) throw new Error("Publication not found.");
    publication.local_pdf_path = path;
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  await conn.execute("UPDATE publications SET local_pdf_path=$1 WHERE id=$2", [path, publicationId]);
}

export async function removePublicationFromCollection(publicationId: string, collectionId: string, userId?: string | null): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    data.links[collectionId] = (data.links[collectionId] || []).filter((id) => id !== publicationId);
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, publicationId]);
}

export async function deletePublication(publicationId: string, userId?: string | null): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    data.publications = data.publications.filter((item) => item.id !== publicationId);
    for (const id of Object.keys(data.links)) data.links[id] = data.links[id].filter((linked) => linked !== publicationId);
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  await conn.execute("DELETE FROM collection_publications WHERE publication_id=$1", [publicationId]);
  await conn.execute("DELETE FROM publications WHERE id=$1", [publicationId]);
}

export async function getPublicationCollectionIds(publicationId: string, userId?: string | null): Promise<string[]> {
  if (!isTauri()) {
    const data = readLocal(userId);
    return Object.entries(data.links).filter(([, ids]) => ids.includes(publicationId)).map(([collectionId]) => collectionId);
  }
  const conn = await db(userId);
  const rows = await conn.select<Array<{ collection_id: string }>>("SELECT collection_id FROM collection_publications WHERE publication_id=$1", [publicationId]);
  return rows.map((row) => row.collection_id);
}

async function getLegacyIds(): Promise<LegacyIds> {
  const stored = localStorage.getItem(LEGACY_IDS_KEY);
  if (stored) {
    try {
      const parsed = JSON.parse(stored) as Partial<LegacyIds>;
      return {
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        publications: Array.isArray(parsed.publications) ? parsed.publications : [],
      };
    } catch { /* Rebuild the migration marker from the old local catalog. */ }
  }
  const [collections, publications] = await Promise.all([getCollections(null), getPublications(null, null)]);
  const ids = { collections: collections.map((item) => item.id), publications: publications.map((item) => item.id) };
  localStorage.setItem(LEGACY_IDS_KEY, JSON.stringify(ids));
  return ids;
}

async function purgeLocalRecords(userId: string | null, ids: LegacyIds, removePdfs: boolean): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    const collectionIds = new Set(ids.collections);
    const publicationIds = new Set(ids.publications);
    data.collections = data.collections.filter((item) => !collectionIds.has(item.id));
    data.publications = data.publications.filter((item) => !publicationIds.has(item.id));
    for (const id of collectionIds) delete data.links[id];
    for (const id of Object.keys(data.links)) data.links[id] = data.links[id].filter((id) => !publicationIds.has(id));
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  for (const id of ids.publications) {
    if (removePdfs) {
      const rows = await conn.select<Array<{ local_pdf_path: string | null }>>("SELECT local_pdf_path FROM publications WHERE id=$1", [id]);
      if (rows[0]?.local_pdf_path) await removeOfflinePdf(rows[0].local_pdf_path).catch(() => undefined);
    }
    await conn.execute("DELETE FROM collection_publications WHERE publication_id=$1", [id]);
    await conn.execute("DELETE FROM publications WHERE id=$1", [id]);
  }
  for (const id of ids.collections) {
    await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1", [id]);
    await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
  }
}

export async function initializeLocalCatalog(): Promise<boolean> {
  if (localStorage.getItem(LEGACY_GUEST_CLEARED_KEY) === "true") return true;
  const ids = await getLegacyIds();
  const previousAccount = localStorage.getItem("magazine-rack-local-imported-to");
  await purgeLocalRecords(null, ids, !previousAccount);
  localStorage.setItem(LEGACY_GUEST_CLEARED_KEY, "true");
  return true;
}

function findCachedAccountId(): string | null {
  for (let index = 0; index < localStorage.length; index += 1) {
    const key = localStorage.key(index);
    if (!key?.startsWith("sb-") || !key.endsWith("-auth-token")) continue;
    try {
      const value = JSON.parse(localStorage.getItem(key) || "null") as { user?: { id?: string }; currentSession?: { user?: { id?: string } }; session?: { user?: { id?: string } } } | null;
      const id = value?.user?.id || value?.currentSession?.user?.id || value?.session?.user?.id;
      if (id) return id;
    } catch { /* Ignore invalid or obsolete auth storage entries. */ }
  }
  const link = localStorage.getItem("magazine-rack-local-catalog-linked-to");
  if (link) {
    try { return (JSON.parse(link) as { userId?: string }).userId || link; }
    catch { return link; }
  }
  return localStorage.getItem("magazine-rack-local-imported-to");
}

async function migrateAccountCacheToLocal(accountId: string): Promise<void> {
  const migrationKey = `${ACCOUNT_CACHE_MIGRATED_KEY}:${accountId}`;
  if (localStorage.getItem(migrationKey) === "true") return;
  const importedTo = localStorage.getItem("magazine-rack-local-imported-to");
  if (importedTo === accountId) await purgeLocalRecords(accountId, await getLegacyIds(), true);

  const [accountCollections, accountPublications, localCollections, localPublications] = await Promise.all([
    getCollections(accountId), getPublications(null, accountId), getCollections(null), getPublications(null, null),
  ]);
  const collectionIdMap = new Map<string, string>();
  for (const collection of accountCollections) {
    const local = localCollections.find((item) => item.id === collection.id);
    const targetId = local?.id || collection.id;
    await saveCollection({ id: targetId, name: collection.name, description: collection.description, thumbnail_data: collection.thumbnail_data });
    collectionIdMap.set(collection.id, targetId);
  }

  for (const publication of accountPublications) {
    const local = localPublications.find((item) => item.id === publication.id) || localPublications.find((item) =>
      item.archive_identifier === publication.archive_identifier && item.pdf_filename === publication.pdf_filename);
    const targetId = local?.id || publication.id;
    const draft: PublicationDraft = {
      archive_identifier: publication.archive_identifier,
      pdf_filename: publication.pdf_filename,
      source_url: publication.source_url,
      title: publication.title,
      date: publication.date,
      publisher: publication.publisher,
      creator: publication.creator,
      description: publication.description,
      language: publication.language,
      rights: publication.rights,
      subjects: publication.subjects || [],
      metadata_json: publication.metadata_json,
      thumbnail_data: publication.thumbnail_data,
    };
    const collectionIds = await getPublicationCollectionIds(publication.id, accountId);
    const targetCollections = collectionIds.map((id) => collectionIdMap.get(id) || id);
    if (targetCollections.length) {
      for (const collectionId of targetCollections) await savePublication(draft, collectionId, targetId);
    } else await savePublication(draft, null, targetId);
    if (publication.local_pdf_path) await setLocalPdfPath(targetId, publication.local_pdf_path);
  }

  await purgeLocalRecords(accountId, {
    collections: accountCollections.map((collection) => collection.id),
    publications: accountPublications.map((publication) => publication.id),
  }, false);
  localStorage.removeItem(storageKey(accountId));
  localStorage.setItem(migrationKey, "true");
}

export async function prepareLocalLibrary(): Promise<boolean> {
  await initializeLocalCatalog();
  const accountId = findCachedAccountId();
  if (accountId) await migrateAccountCacheToLocal(accountId);
  for (let index = localStorage.length - 1; index >= 0; index -= 1) {
    const key = localStorage.key(index);
    if (key?.startsWith("sb-") && key.includes("-auth-token")) localStorage.removeItem(key);
  }
  localStorage.removeItem("magazine-rack-local-imported-to");
  localStorage.removeItem("magazine-rack-local-catalog-linked-to");
  localStorage.removeItem(LEGACY_IDS_KEY);
  return true;
}
