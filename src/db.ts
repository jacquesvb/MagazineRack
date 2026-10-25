import Database from "@tauri-apps/plugin-sql";
import { isTauri } from "@tauri-apps/api/core";
import { supabase } from "./supabase";
import { removeOfflinePdf } from "./offline";
import type { Collection, Publication, PublicationDraft } from "./types";

type LocalData = { collections: Collection[]; publications: Publication[]; links: Record<string, string[]> };
const STORAGE_KEY = "magazine-rack-data-v1";
const databases = new Map<string, Promise<Database>>();

const initialData = (): LocalData => ({ collections: [], publications: [], links: {} });
const storageKey = (userId?: string | null) => userId ? `${STORAGE_KEY}:${userId}` : STORAGE_KEY;
const readLocal = (userId?: string | null): LocalData => {
  try { return JSON.parse(localStorage.getItem(storageKey(userId)) || "null") || initialData(); }
  catch { return initialData(); }
};
const saveLocal = (data: LocalData, userId?: string | null) => localStorage.setItem(storageKey(userId), JSON.stringify(data));
const now = () => new Date().toISOString();
const makeId = () => crypto.randomUUID();

function databaseKey(userId?: string | null) { return userId || "local"; }

async function db(userId?: string | null) {
  const key = databaseKey(userId);
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
    databases.set(key, database);
  }
  return database;
}

function parseJson(value: string | Record<string, unknown> | unknown[] | null | undefined, fallback: unknown = {}) {
  if (typeof value !== "string") return value ?? fallback;
  try { return JSON.parse(value) as unknown; } catch { return fallback; }
}

function cloud() {
  if (!supabase) throw new Error("Cloud accounts are not configured.");
  return supabase;
}

export async function getCollections(userId?: string | null): Promise<Collection[]> {
  if (!isTauri()) {
    const data = readLocal(userId);
    return data.collections.map((item) => ({
    ...item,
    publication_count: data.links[item.id]?.length || 0,
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

function parseSubjects(value: string | string[] | undefined): string[] {
  if (Array.isArray(value)) return value;
  try { return JSON.parse(value || "[]") as string[]; } catch { return []; }
}

export async function saveCollection(input: { id?: string; name: string; description: string; thumbnail_data: string | null }, userId?: string | null): Promise<string> {
  const timestamp = now();
  const id = input.id || makeId();
  if (userId) {
    const { error } = await cloud().from("collections").upsert({
      id, user_id: userId, name: input.name, description: input.description,
      thumbnail_data: input.thumbnail_data, updated_at: timestamp,
    });
    if (error) throw new Error(error.message);
  }
  if (!isTauri()) {
    const data = readLocal(userId);
    const existing = data.collections.find((item) => item.id === id);
    if (existing) Object.assign(existing, input, { updated_at: timestamp });
    else data.collections.push({ ...input, id, created_at: timestamp, updated_at: timestamp });
    saveLocal(data, userId); return id;
  }
  const conn = await db(userId);
  const existing = await conn.select<Array<{ id: string }>>("SELECT id FROM collections WHERE id=$1", [id]);
  if (existing.length) await conn.execute("UPDATE collections SET name=$1, description=$2, thumbnail_data=$3, updated_at=$4 WHERE id=$5",
    [input.name, input.description, input.thumbnail_data, timestamp, id]);
  else await conn.execute("INSERT INTO collections (id,name,description,thumbnail_data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$5)",
    [id, input.name, input.description, input.thumbnail_data, timestamp]);
  return id;
}

export async function deleteCollection(id: string, userId?: string | null): Promise<void> {
  if (userId) {
    const { error } = await cloud().from("collections").delete().eq("id", id).eq("user_id", userId);
    if (error) throw new Error(error.message);
  }
  if (!isTauri()) {
    const data = readLocal(userId); data.collections = data.collections.filter((item) => item.id !== id); delete data.links[id]; saveLocal(data, userId); return;
  }
  const conn = await db(userId); await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1", [id]); await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
}

export async function savePublication(draft: PublicationDraft, collectionId: string | null, editId?: string, userId?: string | null): Promise<string> {
  const timestamp = now();
  const subjectsJson = JSON.stringify(draft.subjects);
  let localData: LocalData | undefined;
  let conn: Database | undefined;
  let localRecord: Publication | undefined;
  let sqlRecord: { id: string; created_at: string; overrides_json: string } | undefined;

  if (!isTauri()) {
    localData = readLocal(userId);
    localRecord = editId
      ? localData.publications.find((item) => item.id === editId)
      : localData.publications.find((item) => item.archive_identifier === draft.archive_identifier && item.pdf_filename === draft.pdf_filename);
  } else {
    conn = await db(userId);
    const rows = editId
      ? await conn.select<Array<{ id: string; created_at: string; overrides_json: string }>>("SELECT id,created_at,overrides_json FROM publications WHERE id=$1", [editId])
      : await conn.select<Array<{ id: string; created_at: string; overrides_json: string }>>(
          "SELECT id,created_at,overrides_json FROM publications WHERE archive_identifier=$1 AND pdf_filename=$2", [draft.archive_identifier, draft.pdf_filename]);
    sqlRecord = rows[0];
  }

  const id = editId || localRecord?.id || sqlRecord?.id || makeId();
  const createdAt = localRecord?.created_at || sqlRecord?.created_at || timestamp;
  const overridesJson = localRecord?.overrides_json || sqlRecord?.overrides_json || "{}";

  if (userId) {
    const { error } = await cloud().from("publications").upsert({
      id,
      user_id: userId,
      archive_identifier: draft.archive_identifier,
      pdf_filename: draft.pdf_filename,
      source_url: draft.source_url,
      title: draft.title,
      date: draft.date,
      publisher: draft.publisher,
      creator: draft.creator,
      description: draft.description,
      language: draft.language,
      rights: draft.rights,
      subjects: draft.subjects,
      metadata_json: parseJson(draft.metadata_json),
      overrides_json: parseJson(overridesJson),
      thumbnail_data: draft.thumbnail_data,
      created_at: createdAt,
      updated_at: timestamp,
    });
    if (error) throw new Error(error.message);
    if (collectionId) {
      const { error: linkError } = await cloud().from("collection_publications").upsert({
        user_id: userId, collection_id: collectionId, publication_id: id, added_at: timestamp,
      }, { onConflict: "user_id,collection_id,publication_id" });
      if (linkError) throw new Error(linkError.message);
    }
  }

  if (!isTauri()) {
    const data = localData!;
    let publication = data.publications.find((item) => item.id === id);
    if (publication) Object.assign(publication, draft, { subjects: draft.subjects, updated_at: timestamp });
    else {
      publication = { ...draft, id, subjects: draft.subjects, overrides_json: overridesJson, local_pdf_path: null, created_at: createdAt, updated_at: timestamp };
      data.publications.push(publication);
    }
    if (collectionId) {
      const links = data.links[collectionId] || (data.links[collectionId] = []);
      if (!links.includes(id)) links.push(id);
    }
    saveLocal(data, userId);
    return id;
  }

  const dbConn = conn!;
  const exists = sqlRecord || (editId ? (await dbConn.select<Array<{ id: string }>>("SELECT id FROM publications WHERE id=$1", [id]))[0] : undefined);
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
  if (userId) {
    const { error } = await cloud().from("collection_publications").delete().eq("user_id", userId).eq("collection_id", collectionId).eq("publication_id", publicationId);
    if (error) throw new Error(error.message);
  }
  if (!isTauri()) {
    const data = readLocal(userId); data.links[collectionId] = (data.links[collectionId] || []).filter((id) => id !== publicationId); saveLocal(data, userId); return;
  }
  const conn = await db(userId); await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1 AND publication_id=$2", [collectionId, publicationId]);
}

export async function deletePublication(publicationId: string, userId?: string | null): Promise<void> {
  if (userId) {
    const { error } = await cloud().from("publications").delete().eq("id", publicationId).eq("user_id", userId);
    if (error) throw new Error(error.message);
  }
  if (!isTauri()) {
    const data = readLocal(userId); data.publications = data.publications.filter((item) => item.id !== publicationId);
    Object.keys(data.links).forEach((id) => { data.links[id] = data.links[id].filter((linked) => linked !== publicationId); }); saveLocal(data, userId); return;
  }
  const conn = await db(userId); await conn.execute("DELETE FROM collection_publications WHERE publication_id=$1", [publicationId]); await conn.execute("DELETE FROM publications WHERE id=$1", [publicationId]);
}

export async function getPublicationCollectionIds(publicationId: string, userId?: string | null): Promise<string[]> {
  if (!isTauri()) {
    const data = readLocal(userId);
    return Object.entries(data.links).filter(([, publicationIds]) => publicationIds.includes(publicationId)).map(([collectionId]) => collectionId);
  }
  const conn = await db(userId);
  const rows = await conn.select<Array<{ collection_id: string }>>("SELECT collection_id FROM collection_publications WHERE publication_id=$1", [publicationId]);
  return rows.map((row) => row.collection_id);
}

const LEGACY_IDS_KEY = "magazine-rack-legacy-catalog-ids-v1";
const LEGACY_GUEST_CLEARED_KEY = "magazine-rack-legacy-guest-cleared-v1";
const LOCAL_CATALOG_LINKED_KEY = "magazine-rack-local-catalog-linked-to";
type LegacyIds = { collections: string[]; publications: string[] };
const chunks = <T,>(items: T[], size = 100): T[][] => Array.from({ length: Math.ceil(items.length / size) }, (_, index) => items.slice(index * size, (index + 1) * size));
type LocalCatalogLinkState = {
  userId: string;
  collectionIds: string[];
  publicationIds: string[];
  linkKeys: string[];
  collectionUpdatedAt: Record<string, string>;
  publicationUpdatedAt: Record<string, string>;
};

function readLocalCatalogLinkState(): LocalCatalogLinkState | null {
  const stored = localStorage.getItem(LOCAL_CATALOG_LINKED_KEY);
  if (!stored) return null;
  try {
    const parsed = JSON.parse(stored) as Partial<LocalCatalogLinkState>;
    if (parsed.userId) return {
      userId: parsed.userId,
      collectionIds: parsed.collectionIds || [],
      publicationIds: parsed.publicationIds || [],
      linkKeys: parsed.linkKeys || [],
      collectionUpdatedAt: parsed.collectionUpdatedAt || {},
      publicationUpdatedAt: parsed.publicationUpdatedAt || {},
    };
  } catch { /* Older releases stored only the linked account ID. */ }
  return {
    userId: stored,
    collectionIds: [],
    publicationIds: [],
    linkKeys: [],
    collectionUpdatedAt: {},
    publicationUpdatedAt: {},
  };
}

function linkKey(collectionId: string, publicationId: string) { return `${collectionId}|${publicationId}`; }
function timestampAfter(left: string, right: string | undefined) {
  return !right || Date.parse(left) > Date.parse(right);
}

async function purgeLocalRecords(userId: string | null, legacyIds: LegacyIds, removePdfs: boolean): Promise<void> {
  if (!isTauri()) {
    const data = readLocal(userId);
    const collectionIds = new Set(legacyIds.collections);
    const publicationIds = new Set(legacyIds.publications);
    data.collections = data.collections.filter((item) => !collectionIds.has(item.id));
    data.publications = data.publications.filter((item) => !publicationIds.has(item.id));
    for (const id of collectionIds) delete data.links[id];
    for (const id of Object.keys(data.links)) data.links[id] = data.links[id].filter((id) => !publicationIds.has(id));
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  for (const id of legacyIds.publications) {
    if (removePdfs) {
      const rows = await conn.select<Array<{ local_pdf_path: string | null }>>("SELECT local_pdf_path FROM publications WHERE id=$1", [id]);
      if (rows[0]?.local_pdf_path) await removeOfflinePdf(rows[0].local_pdf_path).catch(() => undefined);
    }
    await conn.execute("DELETE FROM collection_publications WHERE publication_id=$1", [id]);
    await conn.execute("DELETE FROM publications WHERE id=$1", [id]);
  }
  for (const id of legacyIds.collections) {
    await conn.execute("DELETE FROM collection_publications WHERE collection_id=$1", [id]);
    await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
  }
}

export async function initializeLocalCatalog(): Promise<boolean> {
  if (localStorage.getItem(LEGACY_GUEST_CLEARED_KEY) === "true") return true;
  if (!localStorage.getItem(LEGACY_IDS_KEY)) {
    const [collections, publications] = await Promise.all([getCollections(null), getPublications(null, null)]);
    localStorage.setItem(LEGACY_IDS_KEY, JSON.stringify({
      collections: collections.map((item) => item.id),
      publications: publications.map((item) => item.id),
    } satisfies LegacyIds));
  }
  const rawIds = localStorage.getItem(LEGACY_IDS_KEY) || "{}";
  const parsed = JSON.parse(rawIds) as Partial<LegacyIds>;
  const legacyIds: LegacyIds = {
    collections: Array.isArray(parsed.collections) ? parsed.collections : [],
    publications: Array.isArray(parsed.publications) ? parsed.publications : [],
  };
  const priorAccount = localStorage.getItem("magazine-rack-local-imported-to");
  await purgeLocalRecords(null, legacyIds, !priorAccount);
  localStorage.setItem(LEGACY_GUEST_CLEARED_KEY, "true");
  return true;
}

async function clearLegacyCatalogForAccount(userId: string): Promise<void> {
  let legacyIds: LegacyIds;
  const savedIds = localStorage.getItem(LEGACY_IDS_KEY);
  if (savedIds) {
    try {
      const parsed = JSON.parse(savedIds) as Partial<LegacyIds>;
      legacyIds = {
        collections: Array.isArray(parsed.collections) ? parsed.collections : [],
        publications: Array.isArray(parsed.publications) ? parsed.publications : [],
      };
    }
    catch { legacyIds = { collections: [], publications: [] }; }
  } else {
    const [collections, publications] = await Promise.all([getCollections(null), getPublications(null, null)]);
    legacyIds = { collections: collections.map((item) => item.id), publications: publications.map((item) => item.id) };
    localStorage.setItem(LEGACY_IDS_KEY, JSON.stringify(legacyIds));
  }

  // Earlier account builds copied the guest catalog into the first signed-in account
  // without changing its IDs. Remove only those legacy rows, never account-created rows.
  const legacyOwnerId = localStorage.getItem("magazine-rack-local-imported-to");
  if (legacyOwnerId === userId) {
    const client = cloud();
    for (const ids of chunks(legacyIds.publications)) {
      const { error } = await client.from("publications").delete().eq("user_id", userId).in("id", ids);
      if (error) throw new Error(error.message);
    }
    for (const ids of chunks(legacyIds.collections)) {
      const { error } = await client.from("collections").delete().eq("user_id", userId).in("id", ids);
      if (error) throw new Error(error.message);
    }
    await purgeLocalRecords(userId, legacyIds, true);
    localStorage.removeItem("magazine-rack-local-imported-to");
  }

  if (localStorage.getItem(LEGACY_GUEST_CLEARED_KEY) !== "true") {
    await purgeLocalRecords(null, legacyIds, !legacyOwnerId || legacyOwnerId === userId);
    localStorage.setItem(LEGACY_GUEST_CLEARED_KEY, "true");
  }

  // If no earlier account received the guest catalog, there is no cloud copy to clean later.
  if (!legacyOwnerId || legacyOwnerId === userId) localStorage.removeItem(LEGACY_IDS_KEY);
}

async function syncLocalChangesToAccount(userId: string, state: LocalCatalogLinkState | null): Promise<void> {
  if (state && state.userId !== userId) return;
  const client = cloud();
  const [collections, publications, remoteCollectionsResult, remotePublicationsResult] = await Promise.all([
    getCollections(null),
    getPublications(null, null),
    client.from("collections").select("id,updated_at").eq("user_id", userId),
    client.from("publications").select("id,updated_at").eq("user_id", userId),
  ]);
  if (remoteCollectionsResult.error) throw new Error(remoteCollectionsResult.error.message);
  if (remotePublicationsResult.error) throw new Error(remotePublicationsResult.error.message);

  const collectionUpdatedAt = new Map<string, string>((remoteCollectionsResult.data || []).map((item) => [item.id, item.updated_at]));
  const publicationUpdatedAt = new Map<string, string>((remotePublicationsResult.data || []).map((item) => [item.id, item.updated_at]));
  const collectionIds = new Set(collectionUpdatedAt.keys());
  const publicationIds = new Set(publicationUpdatedAt.keys());
  const knownCollectionIds = new Set(state?.collectionIds || []);
  const knownPublicationIds = new Set(state?.publicationIds || []);

  for (const collection of collections) {
    const remoteUpdatedAt = collectionUpdatedAt.get(collection.id);
    const baseline = state?.collectionUpdatedAt[collection.id];
    const isNewLocalRecord = !knownCollectionIds.has(collection.id);
    const changedLocally = Boolean(baseline && timestampAfter(collection.updated_at, baseline));
    const shouldUpload = remoteUpdatedAt
      ? (isNewLocalRecord || changedLocally) && timestampAfter(collection.updated_at, remoteUpdatedAt)
      : isNewLocalRecord || changedLocally || !state;
    if (shouldUpload) {
      await saveCollection({ id: collection.id, name: collection.name, description: collection.description, thumbnail_data: collection.thumbnail_data }, userId);
      collectionIds.add(collection.id);
      collectionUpdatedAt.set(collection.id, collection.updated_at);
    }
  }
  for (const id of state?.collectionIds || []) {
    if (collections.some((collection) => collection.id === id) || !collectionIds.has(id)) continue;
    const { error } = await client.from("collections").delete().eq("user_id", userId).eq("id", id);
    if (error) throw new Error(error.message);
    collectionIds.delete(id);
    collectionUpdatedAt.delete(id);
  }

  for (const publication of publications) {
    const remoteUpdatedAt = publicationUpdatedAt.get(publication.id);
    const baseline = state?.publicationUpdatedAt[publication.id];
    const isNewLocalRecord = !knownPublicationIds.has(publication.id);
    const changedLocally = Boolean(baseline && timestampAfter(publication.updated_at, baseline));
    const shouldUpload = remoteUpdatedAt
      ? (isNewLocalRecord || changedLocally) && timestampAfter(publication.updated_at, remoteUpdatedAt)
      : isNewLocalRecord || changedLocally || !state;
    if (shouldUpload) {
      const draft: PublicationDraft = { ...publication, subjects: publication.subjects || [] };
      const importedId = await savePublication(draft, null, publication.id, userId);
      if (publication.local_pdf_path) await setLocalPdfPath(importedId, publication.local_pdf_path, userId);
      publicationIds.add(publication.id);
      publicationUpdatedAt.set(publication.id, publication.updated_at);
    }
  }
  for (const id of state?.publicationIds || []) {
    if (publications.some((publication) => publication.id === id) || !publicationIds.has(id)) continue;
    const { error } = await client.from("publications").delete().eq("user_id", userId).eq("id", id);
    if (error) throw new Error(error.message);
    publicationIds.delete(id);
    publicationUpdatedAt.delete(id);
  }

  const localLinks = new Set<string>();
  for (const publication of publications) {
    const collectionIds = await getPublicationCollectionIds(publication.id, null);
    for (const collectionId of collectionIds) localLinks.add(linkKey(collectionId, publication.id));
  }
  const knownLinks = new Set(state?.linkKeys || []);
  for (const key of localLinks) {
    if (knownLinks.has(key)) continue;
    const [collectionId, publicationId] = key.split("|");
    if (!collectionIds.has(collectionId) || !publicationIds.has(publicationId)) continue;
    const { error } = await client.from("collection_publications").upsert({
      user_id: userId, collection_id: collectionId, publication_id: publicationId,
    }, { onConflict: "user_id,collection_id,publication_id" });
    if (error) throw new Error(error.message);
  }
  for (const key of knownLinks) {
    if (localLinks.has(key)) continue;
    const [collectionId, publicationId] = key.split("|");
    const { error } = await client.from("collection_publications").delete().eq("user_id", userId).eq("collection_id", collectionId).eq("publication_id", publicationId);
    if (error) throw new Error(error.message);
  }
}

async function saveLocalCatalogLinkState(userId: string): Promise<void> {
  const [collections, publications] = await Promise.all([getCollections(null), getPublications(null, null)]);
  const linkKeys: string[] = [];
  for (const publication of publications) {
    for (const collectionId of await getPublicationCollectionIds(publication.id, null)) linkKeys.push(linkKey(collectionId, publication.id));
  }
  const state: LocalCatalogLinkState = {
    userId,
    collectionIds: collections.map((collection) => collection.id),
    publicationIds: publications.map((publication) => publication.id),
    linkKeys,
    collectionUpdatedAt: Object.fromEntries(collections.map((collection) => [collection.id, collection.updated_at])),
    publicationUpdatedAt: Object.fromEntries(publications.map((publication) => [publication.id, publication.updated_at])),
  };
  localStorage.setItem(LOCAL_CATALOG_LINKED_KEY, JSON.stringify(state));
}

type CloudCollection = Collection & { user_id: string };
type CloudPublication = Omit<Publication, "local_pdf_path" | "subjects" | "metadata_json" | "overrides_json"> & {
  user_id: string; subjects: string[]; metadata_json: unknown; overrides_json: unknown;
};
type CloudLink = { collection_id: string; publication_id: string; position: number; added_at: string };

export async function syncUserCatalog(userId: string): Promise<boolean> {
  const client = cloud();
  await clearLegacyCatalogForAccount(userId);
  await syncLocalChangesToAccount(userId, readLocalCatalogLinkState());

  const [collectionResult, publicationResult, linkResult] = await Promise.all([
    client.from("collections").select("*").eq("user_id", userId),
    client.from("publications").select("*").eq("user_id", userId),
    client.from("collection_publications").select("*").eq("user_id", userId),
  ]);
  if (collectionResult.error) throw new Error(collectionResult.error.message);
  if (publicationResult.error) throw new Error(publicationResult.error.message);
  if (linkResult.error) throw new Error(linkResult.error.message);
  await applyCloudSnapshot(userId, collectionResult.data as CloudCollection[], publicationResult.data as CloudPublication[], linkResult.data as CloudLink[]);
  const localLink = readLocalCatalogLinkState();
  if (!localLink || localLink.userId === userId) {
    const accountPdfs = new Map((await getPublications(null, userId))
      .filter((publication) => publication.local_pdf_path)
      .map((publication) => [publication.id, publication.local_pdf_path!]));
    await applyCloudSnapshot(null, collectionResult.data as CloudCollection[], publicationResult.data as CloudPublication[], linkResult.data as CloudLink[]);
    for (const [publicationId, path] of accountPdfs) await setLocalPdfPath(publicationId, path, null);
    await saveLocalCatalogLinkState(userId);
  }
  return true;
}

async function applyCloudSnapshot(userId: string | null, collections: CloudCollection[], publications: CloudPublication[], links: CloudLink[]): Promise<void> {
  const publicationIds = new Set(publications.map((item) => item.id));
  const collectionIds = new Set(collections.map((item) => item.id));
  if (!isTauri()) {
    const data = readLocal(userId);
    const localPdfs = new Map(data.publications.map((item) => [item.id, item.local_pdf_path || null]));
    data.collections = collections.map(({ user_id: _owner, ...item }) => ({ ...item, publication_count: undefined }));
    data.publications = publications.map(({ user_id: _owner, subjects, metadata_json, overrides_json, ...item }) => ({
      ...item, subjects: subjects || [], metadata_json: JSON.stringify(metadata_json ?? {}), overrides_json: JSON.stringify(overrides_json ?? {}),
      local_pdf_path: localPdfs.get(item.id) || null,
    }));
    data.links = {};
    for (const link of links) (data.links[link.collection_id] ||= []).push(link.publication_id);
    saveLocal(data, userId);
    return;
  }
  const conn = await db(userId);
  const localCollections = await conn.select<Array<{ id: string }>>("SELECT id FROM collections");
  const localPublications = await conn.select<Array<{ id: string }>>("SELECT id FROM publications");
  await conn.execute("DELETE FROM collection_publications");
  for (const { id } of localCollections) if (!collectionIds.has(id)) await conn.execute("DELETE FROM collections WHERE id=$1", [id]);
  for (const { id } of localPublications) if (!publicationIds.has(id)) await conn.execute("DELETE FROM publications WHERE id=$1", [id]);

  for (const { user_id: _owner, publication_count: _count, ...item } of collections) {
    await conn.execute(`INSERT INTO collections (id,name,description,thumbnail_data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6)
      ON CONFLICT(id) DO UPDATE SET name=$2,description=$3,thumbnail_data=$4,updated_at=$6`,
      [item.id, item.name, item.description, item.thumbnail_data, item.created_at, item.updated_at]);
  }
  for (const { user_id: _owner, subjects, metadata_json, overrides_json, local_pdf_path: _local, ...item } of publications as Array<CloudPublication & { local_pdf_path?: string | null }>) {
    await conn.execute(`INSERT INTO publications (id,archive_identifier,pdf_filename,source_url,title,date,publisher,creator,description,language,rights,
      subjects_json,metadata_json,overrides_json,thumbnail_data,created_at,updated_at) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17)
      ON CONFLICT(id) DO UPDATE SET archive_identifier=$2,pdf_filename=$3,source_url=$4,title=$5,date=$6,publisher=$7,creator=$8,description=$9,
      language=$10,rights=$11,subjects_json=$12,metadata_json=$13,overrides_json=$14,thumbnail_data=$15,updated_at=$17`,
      [item.id, item.archive_identifier, item.pdf_filename, item.source_url, item.title, item.date, item.publisher, item.creator, item.description,
        item.language, item.rights, JSON.stringify(subjects || []), JSON.stringify(metadata_json ?? {}), JSON.stringify(overrides_json ?? {}), item.thumbnail_data, item.created_at, item.updated_at]);
  }
  for (const link of links) {
    await conn.execute("INSERT INTO collection_publications (collection_id,publication_id,position,added_at) VALUES ($1,$2,$3,$4)",
      [link.collection_id, link.publication_id, link.position || 0, link.added_at || now()]);
  }
}
