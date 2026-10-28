import { lazy, Suspense, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Archive, ArrowDownWideNarrow, BookOpen, Check, ChevronDown, CircleHelp, Clock3, Download, ExternalLink,
  FolderOpen, Grid2X2, LayoutList, LibraryBig, LoaderCircle, Plus,
  Search, Settings2, Sparkles, Trash2, Upload, X,
} from "lucide-react";
import { deleteCollection, deletePublication, getCollections, getPublications, importSharedCollection, prepareLocalLibrary, removePublicationFromCollection, saveCollection, savePublication, setLocalPdfPath } from "./localDb";
import { archiveDownloadUrl, imageFileToDataUrl, imageUrlToDataUrl, importArchivePdf, type ArchiveFile } from "./archive";
import { createSharedCollection, downloadSharedCollection, parseSharedCollection, sharedCollectionFilename } from "./collectionTransfer";
import { invoke, isTauri } from "@tauri-apps/api/core";
import { open as openNativeDialog } from "@tauri-apps/plugin-dialog";
import { mkdir, writeFile } from "@tauri-apps/plugin-fs";
import { collectionPdfFolderPath, downloadPublicationPdf, removeOfflinePdf } from "./offline";
import { useUIStore } from "./store";
import ThemeToggle from "./ThemeToggle";
import type { Collection, Publication, PublicationDraft } from "./types";

const PdfReader = lazy(() => import("./PdfReader"));

type Dialog = "new-collection" | "edit-collection" | "add-publication" | "edit-publication" | null;
const DOWNLOAD_ROOT_KEY = "magazine-rack-download-root-v1";
const DOWNLOAD_ROOTS_KEY = "magazine-rack-download-roots-v1";

export default function App() {
  return <ThemeBridge><AppGate /></ThemeBridge>;
}

function ThemeBridge({ children }: { children: React.ReactNode }) {
  const themeMode = useUIStore((state) => state.themeMode);
  useEffect(() => {
    document.documentElement.dataset.theme = themeMode;
    document.documentElement.style.colorScheme = themeMode;
  }, [themeMode]);
  return children;
}

function AppGate() {
  const localCatalogQuery = useQuery({
    queryKey: ["prepare-local-library"],
    queryFn: prepareLocalLibrary,
    staleTime: Number.POSITIVE_INFINITY,
    retry: 1,
  });
  if (localCatalogQuery.isLoading) return <div className="loading-state"><LoaderCircle className="spin" size={26} /><span>Preparing your local library…</span></div>;
  if (localCatalogQuery.isError) return <div className="error-state"><h3>Couldn’t open your local library</h3><p>{localCatalogQuery.error.message}</p><button className="button button-primary" onClick={() => void localCatalogQuery.refetch()}>Try again</button></div>;
  return <LibraryApp />;
}

function Cover({ image, title, className = "" }: { image?: string | null; title: string; className?: string }) {
  return <div className={`cover ${className}`}>
    {image ? <img src={image} alt={`${title} cover`} /> : <div className="cover-placeholder"><div className="placeholder-lines"><i /><i /><i /></div><span>{title || "Magazine"}</span><BookOpen size={25} strokeWidth={1.2} /></div>}
  </div>;
}

function Modal({ title, subtitle, onClose, children, wide = false }: { title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; wide?: boolean }) {
  return <div className="modal-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className={`modal-card ${wide ? "modal-wide" : ""}`} role="dialog" aria-modal="true" aria-label={title}>
      <header className="modal-heading"><div><h2>{title}</h2>{subtitle && <p>{subtitle}</p>}</div><button className="icon-button" onClick={onClose} aria-label="Close"><X size={19} /></button></header>
      {children}
    </section>
  </div>;
}

function droppedImageUrls(dataTransfer: DataTransfer): string[] {
  const uriList = dataTransfer.getData("text/uri-list").split(/\r?\n/).map((line) => line.trim()).filter((line) => line && !line.startsWith("#"));
  const mozUrl = dataTransfer.getData("text/x-moz-url").split(/\r?\n/)[0]?.trim();
  const html = dataTransfer.getData("text/html");
  const htmlUrls: string[] = [];
  if (html) {
    const document = new DOMParser().parseFromString(html, "text/html");
    const base = uriList[0] || window.location.href;
    for (const image of document.querySelectorAll("img")) {
      const source = image.getAttribute("src") || image.getAttribute("srcset")?.split(",")[0]?.trim().split(/\s+/)[0];
      if (!source) continue;
      try { htmlUrls.push(new URL(source, base).toString()); } catch { /* Ignore non-URL image sources. */ }
    }
  }
  const textUrls = dataTransfer.getData("text/plain").match(/https?:\/\/[^\s<>"']+/g) || [];
  return [...new Set([...uriList, ...(mozUrl ? [mozUrl] : []), ...htmlUrls, ...textUrls])];
}

function ImagePicker({ value, onChange }: { value: string | null; onChange: (value: string | null) => void }) {
  const [error, setError] = useState("");
  const [dragOver, setDragOver] = useState(false);
  const [loadingUrl, setLoadingUrl] = useState(false);
  const choose = async (file?: File) => {
    if (!file) return;
    try { setError(""); onChange(await imageFileToDataUrl(file)); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not use this image."); }
  };
  const handleDrop = async (event: React.DragEvent<HTMLLabelElement>) => {
    event.preventDefault();
    setDragOver(false);
    setError("");
    const file = Array.from(event.dataTransfer.files).find((candidate) => candidate.type.startsWith("image/") || candidate.name.toLowerCase().endsWith(".gif"));
    if (file) { await choose(file); return; }
    const urls = droppedImageUrls(event.dataTransfer);
    if (!urls.length) { setError("Drop an image file or drag an image from a secure webpage."); return; }
    setLoadingUrl(true);
    let lastError: unknown;
    for (const url of urls) {
      try { onChange(await imageUrlToDataUrl(url)); setLoadingUrl(false); return; }
      catch (reason) { lastError = reason; }
    }
    setError(lastError instanceof Error ? lastError.message : "Could not fetch the dropped image.");
    setLoadingUrl(false);
  };
  return <div className="image-picker-row">
    <label className={`image-picker ${dragOver ? "drop-active" : ""}`} onDragEnter={(event) => { event.preventDefault(); setDragOver(true); }} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = "copy"; setDragOver(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragOver(false); }} onDrop={(event) => void handleDrop(event)} aria-label="Drop an image here or choose a file">
      {loadingUrl ? <span className="image-picker-empty"><LoaderCircle className="spin" size={18} /><small>Fetching…</small></span> : value ? <img src={value} alt="Selected thumbnail" /> : <span className="image-picker-empty"><Upload size={18} /><small>Choose image</small></span>}
      <input type="file" accept="image/*,.gif" onChange={(event) => void choose(event.target.files?.[0])} />
    </label>
    <div className="image-picker-copy"><strong>Thumbnail image</strong><span>Drop an HTTPS image from a webpage or choose a file.</span><span>JPG, PNG, GIF, or WebP · max 4 MB</span>{value && <button type="button" className="text-button" onClick={() => onChange(null)}>Remove image</button>}{error && <em className="field-error">{error}</em>}</div>
  </div>;
}

function CollectionDialog({ collection, onClose, onSave, busy }: { collection?: Collection; onClose: () => void; onSave: (data: { id?: string; name: string; description: string; thumbnail_data: string | null }) => void; busy: boolean }) {
  const [name, setName] = useState(collection?.name || "");
  const [description, setDescription] = useState(collection?.description || "");
  const [thumbnail, setThumbnail] = useState<string | null>(collection?.thumbnail_data || null);
  const [error, setError] = useState("");
  return <Modal title={collection ? "Edit collection" : "Create a collection"} subtitle={collection ? "Keep your shelf details up to date." : "A home for the publications you want to keep close."} onClose={onClose}>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (!name.trim()) { setError("Give your collection a name."); return; } onSave({ id: collection?.id, name: name.trim(), description: description.trim(), thumbnail_data: thumbnail }); }}>
      <label className="field"><span>Collection name <b>*</b></span><input autoFocus value={name} onChange={(event) => { setName(event.target.value); setError(""); }} placeholder="e.g. Compute!'s Gazette" />{error && <em className="field-error">{error}</em>}</label>
      <label className="field"><span>Description <small>Optional</small></span><textarea value={description} onChange={(event) => setDescription(event.target.value)} rows={3} placeholder="A short note about this collection…" /></label>
      <ImagePicker value={thumbnail} onChange={setThumbnail} />
      <footer className="form-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button><button className="button button-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{collection ? "Save changes" : "Create collection"}</button></footer>
    </form>
  </Modal>;
}

function CollectionCard({ collection, isList, onOpen, onEdit, onDelete }: { collection: Collection; isList: boolean; onOpen: () => void; onEdit: () => void; onDelete: () => void }) {
  return <article className={`collection-card ${isList ? "collection-list-row" : ""}`}>
    <button className="collection-card-open" onClick={onOpen} aria-label={`Open ${collection.name}`}>
      {!isList && <Cover image={collection.thumbnail_data} title={collection.name} />}
      <div className="collection-card-info"><span className="publication-date">COLLECTION</span><h3>{collection.name}</h3><p>{collection.description || "A collection in your reading room."}</p><span className="collection-card-count">{collection.publication_count || 0} {(collection.publication_count || 0) === 1 ? "publication" : "publications"}</span></div>
    </button>
    <div className="card-actions"><button className="icon-button" onClick={onEdit} title="Edit collection"><Settings2 size={16} /></button><button className="icon-button danger-hover" onClick={onDelete} title="Delete collection"><Trash2 size={16} /></button></div>
  </article>;
}

const emptyDraft = (): PublicationDraft => ({ archive_identifier: "", pdf_filename: "", source_url: "", title: "", date: "", publisher: "", creator: "", description: "", language: "", rights: "", subjects: [], metadata_json: "{}", thumbnail_data: null });

function PublicationDialog({ initial, collections, collectionId, onCollectionChange, onCreateCollection, onClose, onSave, busy }: {
  initial?: Publication; collections: Collection[]; collectionId: string | null; onCollectionChange: (id: string) => void;
  onCreateCollection: () => void; onClose: () => void; onSave: (draft: PublicationDraft) => void; busy: boolean;
}) {
  const [url, setUrl] = useState(initial?.source_url || "");
  const [draft, setDraft] = useState<PublicationDraft>(() => initial ? { ...initial, subjects: initial.subjects || [] } : emptyDraft());
  const [imported, setImported] = useState(!!initial);
  const [pdfFiles, setPdfFiles] = useState<ArchiveFile[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const update = <K extends keyof PublicationDraft>(key: K, value: PublicationDraft[K]) => setDraft((current) => ({ ...current, [key]: value }));

  const fetchMetadata = async () => {
    setLoading(true); setError("");
    try { const importedResult = await importArchivePdf(url); setDraft(importedResult.draft); setPdfFiles(importedResult.pdfFiles); setImported(true); }
    catch (reason) { setError(reason instanceof Error ? reason.message : "Could not import this Archive.org item."); }
    finally { setLoading(false); }
  };

  return <Modal title={initial ? "Edit publication" : "Add a publication"} subtitle={initial ? "Adjust the catalog details for this issue." : "Paste an Archive.org item or direct PDF link to get started."} onClose={onClose} wide>
    <form className="modal-form" onSubmit={(event) => { event.preventDefault(); if (!initial && !collectionId) { setError("Choose a collection before adding this publication."); return; } if (!draft.title.trim()) { setError("Publication title is required."); return; } onSave(draft); }}>
      {!initial && <label className="field target-collection-field"><span>Add to collection <b>*</b></span><select value={collectionId || ""} onChange={(event) => event.target.value === "__create_collection__" ? onCreateCollection() : onCollectionChange(event.target.value)}><option value="" disabled>Select a collection</option>{collections.map((collection) => <option key={collection.id} value={collection.id}>{collection.name}</option>)}<option value="__create_collection__">＋ Create a collection…</option></select></label>}
      {!initial && <div className="import-box">
        <div className="import-box-icon"><Archive size={19} /></div>
        <div className="import-box-body"><label className="field"><span>Archive.org URL</span><div className="import-input-row"><input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://archive.org/details/…" /><button type="button" className="button button-dark" onClick={() => void fetchMetadata()} disabled={!url.trim() || loading}>{loading ? <LoaderCircle size={16} className="spin" /> : <Sparkles size={15} />} Fetch details</button></div></label><p className="helper-line"><CircleHelp size={13} /> Metadata is imported from Archive.org and can be edited before saving.</p></div>
      </div>}
      {error && <div className="error-banner"><CircleHelp size={16} />{error}</div>}
      {imported && <>
        <div className="form-section-label"><span>Publication details</span><i />{draft.archive_identifier && <a href={`https://archive.org/details/${encodeURIComponent(draft.archive_identifier)}`} target="_blank" rel="noreferrer">Archive.org item <ExternalLink size={12} /></a>}</div>
        <div className="form-grid">
          <label className="field field-span"><span>Title <b>*</b></span><input autoFocus value={draft.title} onChange={(event) => update("title", event.target.value)} placeholder="Publication title" /></label>
          <label className="field"><span>Publication date</span><input value={draft.date} onChange={(event) => update("date", event.target.value)} placeholder="e.g. 1983-11" /></label>
          <label className="field"><span>Publisher</span><input value={draft.publisher} onChange={(event) => update("publisher", event.target.value)} placeholder="Publisher name" /></label>
          <label className="field"><span>Creator</span><input value={draft.creator} onChange={(event) => update("creator", event.target.value)} placeholder="Author or organization" /></label>
          <label className="field"><span>Language</span><input value={draft.language} onChange={(event) => update("language", event.target.value)} placeholder="e.g. English" /></label>
          <label className="field"><span>Rights</span><input value={draft.rights} onChange={(event) => update("rights", event.target.value)} placeholder="Rights statement" /></label>
          <label className="field field-span"><span>Description</span><textarea rows={3} value={draft.description} onChange={(event) => update("description", event.target.value)} placeholder="Description or notes…" /></label>
          <label className="field field-span"><span>Subjects <small>Separate with commas</small></span><input value={draft.subjects.join(", ")} onChange={(event) => update("subjects", event.target.value.split(",").map((item) => item.trim()).filter(Boolean))} placeholder="Computers, programming, magazines" /></label>
        </div>
        <div className="publication-file-row"><span className="file-pdf">PDF</span><div>{pdfFiles.length > 1 && !initial ? <select aria-label="PDF file" value={draft.pdf_filename} onChange={(event) => { const filename = event.target.value; update("pdf_filename", filename); update("source_url", archiveDownloadUrl(draft.archive_identifier, filename)); }}>{pdfFiles.map((file) => <option key={file.name} value={file.name}>{file.name}</option>)}</select> : <strong>{draft.pdf_filename}</strong>}<small>Internet Archive · {draft.archive_identifier}</small></div><Check size={16} /></div>
        <ImagePicker value={draft.thumbnail_data} onChange={(value) => update("thumbnail_data", value)} />
      </>}
      <footer className="form-actions"><button type="button" className="button button-quiet" onClick={onClose}>Cancel</button>{(!imported && !initial) ? <span className="form-hint">Fetch item details to continue</span> : <button className="button button-primary" disabled={busy}>{busy && <LoaderCircle size={16} className="spin" />}{initial ? "Save changes" : "Add to collection"}</button>}</footer>
    </form>
  </Modal>;
}

function PublicationCard({ publication, isList, onOpen, onEdit, onDelete, deleteLabel, onRemoveOffline, offlinePending, selectable, selected, onSelect }: {
  publication: Publication; isList: boolean; onOpen: () => void; onEdit: () => void; onDelete: () => void; deleteLabel: string;
  onRemoveOffline?: () => void; offlinePending: boolean; selectable: boolean; selected: boolean; onSelect: () => void;
}) {
  return <article className={`publication-card ${isList ? "publication-list-row" : ""} ${selectable ? "has-selection-control" : ""}`}>
    <button className="publication-open" onClick={onOpen} aria-label={selectable ? `${selected ? "Deselect" : "Select"} ${publication.title}` : `Read ${publication.title}`}>
      {!isList && <Cover image={publication.thumbnail_data} title={publication.title} />}
      <div className="publication-info"><span className="publication-date">{publication.date || "DATE UNKNOWN"}</span><h3>{publication.title || "Untitled publication"}</h3><p>{publication.publisher || publication.creator || "Internet Archive"}</p><span className={`publication-link ${publication.local_pdf_path ? "offline-link" : ""}`}>{publication.local_pdf_path ? <><Check size={13} /> Saved for offline reading</> : <><BookOpen size={13} /> Read publication</>}</span></div>
    </button>
    {selectable && <button className={`publication-select ${selected ? "is-selected" : ""}`} onClick={onSelect} aria-pressed={selected} aria-label={`${selected ? "Deselect" : "Select"} ${publication.title}`} title={selected ? "Deselect publication" : "Select publication"}>{selected && <Check size={15} strokeWidth={2.5} />}</button>}
    <div className="card-actions">{publication.local_pdf_path && onRemoveOffline && <button className="icon-button offline-action" onClick={onRemoveOffline} disabled={offlinePending} title="Remove saved copy" aria-label="Remove saved copy">{offlinePending ? <LoaderCircle className="spin" size={16} /> : <X size={16} />}</button>}<button className="icon-button" onClick={onEdit} title="Edit publication"><Settings2 size={16} /></button><button className="icon-button danger-hover" onClick={onDelete} title={deleteLabel}><Trash2 size={16} /></button></div>
  </article>;
}

function LibraryApp() {
  const queryClient = useQueryClient();
  const { viewMode, setViewMode } = useUIStore();
  const preferenceKey = "local";
  const [selectedCollectionId, setSelectedCollectionId] = useState<string | null>(() => localStorage.getItem(`magazine-rack-active-collection:${preferenceKey}`) || null);
  const [showCollections, setShowCollections] = useState(() => localStorage.getItem(`magazine-rack-show-collections:${preferenceKey}`) === "true");
  const [dialog, setDialog] = useState<Dialog>(null);
  const [quickCollectionDialogOpen, setQuickCollectionDialogOpen] = useState(false);
  const [editingCollection, setEditingCollection] = useState<Collection | undefined>();
  const [editingPublication, setEditingPublication] = useState<Publication | undefined>();
  const [reading, setReading] = useState<Publication | undefined>();
  const [search, setSearch] = useState("");
  const [sortOpen, setSortOpen] = useState(false);
  const [sortOrder, setSortOrder] = useState<"newest" | "oldest" | "title">("oldest");
  const [notice, setNotice] = useState("");
  const [addTargetCollectionId, setAddTargetCollectionId] = useState<string | null>(null);
  const [selectionMode, setSelectionMode] = useState(false);
  const [selectedPublicationIds, setSelectedPublicationIds] = useState<Set<string>>(() => new Set());
  const [downloadRoot, setDownloadRoot] = useState(() => localStorage.getItem(DOWNLOAD_ROOT_KEY) || "");
  const [offlineProgress, setOfflineProgress] = useState("");
  const [offlineSaveErrors, setOfflineSaveErrors] = useState<string[]>([]);
  const searchInput = useRef<HTMLInputElement>(null);
  const collectionImportInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!notice) return;
    const timeout = window.setTimeout(() => setNotice(""), 3200);
    return () => window.clearTimeout(timeout);
  }, [notice]);

  useEffect(() => {
    const onShortcut = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        searchInput.current?.focus();
      }
    };
    window.addEventListener("keydown", onShortcut);
    return () => window.removeEventListener("keydown", onShortcut);
  }, []);

  const collectionsQuery = useQuery({ queryKey: ["collections"], queryFn: () => getCollections() });
  const publicationsQuery = useQuery({ queryKey: ["publications", selectedCollectionId], queryFn: () => getPublications(selectedCollectionId) });
  const collections = collectionsQuery.data || [];
  const activeCollection = collections.find((collection) => collection.id === selectedCollectionId);

  useEffect(() => {
    localStorage.setItem(`magazine-rack-active-collection:${preferenceKey}`, selectedCollectionId || "");
    localStorage.setItem(`magazine-rack-show-collections:${preferenceKey}`, String(showCollections));
  }, [preferenceKey, selectedCollectionId, showCollections]);

  useEffect(() => {
    if (selectedCollectionId && collectionsQuery.isSuccess && !collections.some((collection) => collection.id === selectedCollectionId)) {
      setSelectedCollectionId(null);
    }
  }, [collections, collectionsQuery.isSuccess, selectedCollectionId]);
  useEffect(() => {
    if (!isTauri()) return;
    try {
      const stored = JSON.parse(localStorage.getItem(DOWNLOAD_ROOTS_KEY) || "[]") as unknown;
      const roots = Array.isArray(stored) ? stored.filter((path): path is string => typeof path === "string") : [];
      for (const path of roots) void invoke<string>("allow_download_directory", { path }).catch(() => undefined);
    } catch { /* Ignore invalid old folder preferences. */ }
  }, []);
  useEffect(() => {
    setSelectionMode(false);
    setSelectedPublicationIds(new Set());
    setOfflineSaveErrors([]);
    setOfflineProgress("");
  }, [selectedCollectionId, showCollections]);
  const publications = useMemo(() => {
    const filtered = (publicationsQuery.data || []).filter((publication) => {
      const term = search.toLowerCase().trim();
      return !term || [publication.title, publication.publisher, publication.creator, publication.date, ...publication.subjects].join(" ").toLowerCase().includes(term);
    });
    return filtered.sort((a, b) => sortOrder === "title" ? a.title.localeCompare(b.title) : sortOrder === "oldest" ? a.date.localeCompare(b.date) : b.date.localeCompare(a.date));
  }, [publicationsQuery.data, search, sortOrder]);
  const visibleCollections = useMemo(() => {
    const term = search.toLowerCase().trim();
    return collections.filter((collection) => !term || `${collection.name} ${collection.description}`.toLowerCase().includes(term))
      .sort((a, b) => sortOrder === "title" ? a.name.localeCompare(b.name) : sortOrder === "oldest" ? a.created_at.localeCompare(b.created_at) : b.updated_at.localeCompare(a.updated_at));
  }, [collections, search, sortOrder]);

  const refresh = () => { void queryClient.invalidateQueries({ queryKey: ["collections"] }); void queryClient.invalidateQueries({ queryKey: ["publications"] }); };
  const showMutationError = (error: Error) => setNotice(`Could not save changes: ${error.message}`);
  const collectionSave = useMutation({ mutationFn: (data: Parameters<typeof saveCollection>[0]) => saveCollection(data), onSuccess: () => { refresh(); setDialog(null); setEditingCollection(undefined); }, onError: showMutationError });
  const quickCollectionSave = useMutation({
    mutationFn: (data: Parameters<typeof saveCollection>[0]) => saveCollection(data),
    onSuccess: (id) => {
      refresh();
      setAddTargetCollectionId(id);
      setQuickCollectionDialogOpen(false);
      setNotice("Collection created and selected for this publication.");
    },
    onError: showMutationError,
  });
  const collectionImport = useMutation({
    mutationFn: importSharedCollection,
    onSuccess: ({ collectionId, imported, alreadyHad, skipped, merged }) => {
      refresh();
      setSelectedCollectionId(collectionId);
      setShowCollections(false);
      const added = imported + alreadyHad;
      setNotice(`${merged ? "Merged into existing collection" : "Collection imported"}: ${added} ${added === 1 ? "publication" : "publications"} added${skipped ? `, ${skipped} already in the collection` : ""}.`);
    },
    onError: (error: Error) => setNotice(`Could not import collection: ${error.message}`),
  });
  const collectionDelete = useMutation({ mutationFn: (id: string) => deleteCollection(id), onSuccess: (_, id) => { if (selectedCollectionId === id) setSelectedCollectionId(null); refresh(); setNotice("Collection deleted."); }, onError: showMutationError });
  const publicationSave = useMutation({ mutationFn: ({ draft, id, collectionId }: { draft: PublicationDraft; id?: string; collectionId: string | null }) => savePublication(draft, collectionId, id), onSuccess: () => { refresh(); setDialog(null); setEditingPublication(undefined); setNotice("Publication saved to your rack."); }, onError: showMutationError });
  const publicationDelete = useMutation({
    mutationFn: async ({ publicationId, collectionId, localPdfPath }: { publicationId: string; collectionId: string | null; localPdfPath: string | null }) => {
      if (collectionId) return removePublicationFromCollection(publicationId, collectionId);
      await deletePublication(publicationId);
      if (localPdfPath) await removeOfflinePdf(localPdfPath).catch(() => undefined);
    },
    onSuccess: (_, variables) => { refresh(); setNotice(variables.collectionId ? "Publication removed from this collection." : "Publication deleted."); },
    onError: showMutationError,
  });
  const offlineRemoveMutation = useMutation({
    mutationFn: async (publication: Publication) => {
      if (publication.local_pdf_path) await removeOfflinePdf(publication.local_pdf_path);
      await setLocalPdfPath(publication.id, null);
    },
    onSuccess: () => { refresh(); setNotice("Saved copy removed."); },
    onError: showMutationError,
  });
  const bulkOfflineMutation = useMutation({
    mutationFn: async ({ publications: selected, collection, root }: { publications: Publication[]; collection: Collection; root: string }) => {
      let saved = 0;
      let alreadySaved = 0;
      const failures: string[] = [];
      const folder = collectionPdfFolderPath(root, collection.name).replace(/\\/g, "/").toLowerCase();
      for (const publication of selected) {
        const currentPath = publication.local_pdf_path?.replace(/\\/g, "/").toLowerCase();
        if (currentPath?.startsWith(`${folder}/`)) { alreadySaved += 1; continue; }
        setOfflineProgress(publication.title);
        try {
          const path = await downloadPublicationPdf(publication, collection.name, root);
          try {
            await setLocalPdfPath(publication.id, path);
          } catch (error) {
            await removeOfflinePdf(path).catch(() => undefined);
            throw new Error(`The PDF was written, but Magazine Rack could not update its library record: ${error instanceof Error ? error.message : String(error)}`);
          }
          if (publication.local_pdf_path && publication.local_pdf_path !== path) await removeOfflinePdf(publication.local_pdf_path).catch(() => undefined);
          saved += 1;
        } catch (error) {
          failures.push(`${publication.title}: ${error instanceof Error ? error.message : "Download failed."}`);
        }
      }
      setOfflineProgress("");
      return { saved, alreadySaved, failures };
    },
    onMutate: () => setOfflineSaveErrors([]),
    onSuccess: ({ saved, alreadySaved, failures }) => {
      refresh();
      setSelectionMode(false);
      setSelectedPublicationIds(new Set());
      setOfflineSaveErrors(failures);
      setNotice(failures.length
        ? `${saved} saved, ${failures.length} failed. See the collection for details.`
        : `${saved} publication${saved === 1 ? "" : "s"} saved${alreadySaved ? `; ${alreadySaved} already saved in this collection` : ""}.`);
    },
    onError: (error: Error) => {
      setOfflineProgress("");
      setOfflineSaveErrors([error.message]);
      setNotice(`Could not save selected publications: ${error.message}`);
    },
  });

  const openCollectionDialog = (collection?: Collection) => { setEditingCollection(collection); setDialog(collection ? "edit-collection" : "new-collection"); };
  const openPublicationDialog = (publication?: Publication) => { setEditingPublication(publication); setAddTargetCollectionId(selectedCollectionId || collections[0]?.id || null); setDialog(publication ? "edit-publication" : "add-publication"); };
  const chooseDownloadLocation = async (): Promise<string | null> => {
    if (!isTauri()) { setNotice("Choose a storage folder from the desktop app."); return null; }
    try {
      const chosen = await openNativeDialog({ directory: true, multiple: false, title: "Choose a folder for saved publications" });
      if (typeof chosen !== "string") return null;
      const canonicalPath = await invoke<string>("allow_download_directory", { path: chosen });
      setDownloadRoot(canonicalPath);
      localStorage.setItem(DOWNLOAD_ROOT_KEY, canonicalPath);
      const storedRoots = JSON.parse(localStorage.getItem(DOWNLOAD_ROOTS_KEY) || "[]") as unknown;
      const roots = Array.isArray(storedRoots) ? storedRoots.filter((path): path is string => typeof path === "string") : [];
      if (!roots.includes(canonicalPath)) localStorage.setItem(DOWNLOAD_ROOTS_KEY, JSON.stringify([...roots, canonicalPath]));
      return canonicalPath;
    } catch (error) {
      const detail = `Could not use that folder: ${error instanceof Error ? error.message : "Folder access was denied."}`;
      setOfflineSaveErrors([detail]);
      setNotice(detail);
      return null;
    }
  };
  const togglePublicationSelection = (id: string) => setSelectedPublicationIds((current) => {
    const next = new Set(current);
    if (next.has(id)) next.delete(id); else next.add(id);
    return next;
  });
  const toggleVisibleSelection = () => {
    const visibleIds = publications.map((publication) => publication.id);
    const allSelected = visibleIds.every((id) => selectedPublicationIds.has(id));
    setSelectedPublicationIds((current) => {
      const next = new Set(current);
      for (const id of visibleIds) allSelected ? next.delete(id) : next.add(id);
      return next;
    });
  };
  const saveSelectedPublications = async () => {
    if (!activeCollection) return;
    const selected = (publicationsQuery.data || []).filter((publication) => selectedPublicationIds.has(publication.id));
    if (!selected.length) return;
    const chosenRoot = downloadRoot || await chooseDownloadLocation();
    if (!chosenRoot) return;
    try {
      const root = await invoke<string>("allow_download_directory", { path: chosenRoot });
      bulkOfflineMutation.mutate({ publications: selected, collection: activeCollection, root });
    } catch (error) {
      const detail = `Could not access the storage folder: ${error instanceof Error ? error.message : "Folder access was denied."}`;
      setOfflineSaveErrors([detail]);
      setNotice(detail);
    }
  };
  const exportCollection = async (collection: Collection) => {
    try {
      const members = await getPublications(collection.id);
      const shared = createSharedCollection(collection, members);
      if (isTauri()) {
        const root = downloadRoot || await chooseDownloadLocation();
        if (!root) return;
        const allowedRoot = await invoke<string>("allow_download_directory", { path: root });
        const allowedFolder = collectionPdfFolderPath(allowedRoot, collection.name);
        await mkdir(allowedFolder, { recursive: true });
        const filePath = `${allowedFolder}/${sharedCollectionFilename(shared)}`;
        await writeFile(filePath, new TextEncoder().encode(JSON.stringify(shared, null, 2)));
        setNotice(`Collection export saved to ${filePath}`);
      } else {
        downloadSharedCollection(shared);
        setNotice(`“${collection.name}” exported as a shareable collection file.`);
      }
    } catch (error) {
      setNotice(`Could not export collection: ${error instanceof Error ? error.message : "Could not read collection."}`);
    }
  };
  const importCollectionFile = async (file?: File) => {
    if (!file) return;
    try {
      const shared = parseSharedCollection(await file.text());
      collectionImport.mutate(shared);
    } catch (error) {
      setNotice(`Could not import collection: ${error instanceof Error ? error.message : "Invalid collection file."}`);
    } finally {
      if (collectionImportInput.current) collectionImportInput.current.value = "";
    }
  };

  return <div className="app-shell">
    <aside className="sidebar">
      <div className="brand"><div className="brand-mark"><LibraryBig size={19} strokeWidth={1.8} /></div><div><strong>Magazine Rack</strong><span>YOUR PERSONAL ARCHIVE</span></div></div>
      <div className="sidebar-rule" />
      <button className={`nav-link ${selectedCollectionId === null && !showCollections ? "nav-active" : ""}`} onClick={() => { setSelectedCollectionId(null); setShowCollections(false); }}><Archive size={17} /><span>All publications</span><span className="nav-count">{publicationsQuery.data?.length || 0}</span></button>
      <button className={`nav-link ${showCollections ? "nav-active" : ""}`} onClick={() => { setSelectedCollectionId(null); setShowCollections(true); }}><FolderOpen size={17} /><span>Collections</span><span className="nav-count">{collections.length}</span></button>
      <div className="collection-heading"><span>Your collections</span><button className="icon-button tiny" onClick={() => openCollectionDialog()} title="Create collection"><Plus size={16} /></button></div>
      <nav className="collection-nav">
        {collections.map((collection) => <button key={collection.id} className={`nav-link collection-link ${selectedCollectionId === collection.id && !showCollections ? "nav-active" : ""}`} onClick={() => { setSelectedCollectionId(collection.id); setShowCollections(false); }}>
          {collection.thumbnail_data ? <img className="collection-nav-thumb" src={collection.thumbnail_data} alt="" /> : <span className="collection-dot" />} <span className="collection-nav-name">{collection.name}</span><span className="nav-count">{collection.publication_count || 0}</span>
        </button>)}
        {!collections.length && <p className="sidebar-empty">Collections you create will show up here.</p>}
      </nav>
      <button className="new-collection-link" onClick={() => openCollectionDialog()}><Plus size={15} /> New collection</button>
      <div className="sidebar-bottom"><div className="storage-note"><div className="storage-icon"><BookOpen size={16} /></div><p><strong>Your library, your way</strong><span>Cataloged locally on this device.</span></p></div><div className="sidebar-footer"><span>MAGAZINE RACK</span><span>v1.1.0</span></div></div>
    </aside>

    <main className="main-area">
      <header className="topbar"><div className="breadcrumb"><span>Library</span><span className="breadcrumb-slash">/</span><strong>{showCollections ? "Collections" : activeCollection?.name || "All publications"}</strong></div><div className="topbar-right"><ThemeToggle /></div></header>
      <div className="content-wrap">
        <section className="page-intro">
          <div className="intro-copy"><div className="eyebrow"><span className="eyebrow-mark" /> YOUR READING ROOM</div><h1>{showCollections ? "Your collections" : activeCollection?.name || "All publications"}</h1><p>{showCollections ? "A set of shelves for every corner of your archive." : activeCollection?.description || "A thoughtfully arranged home for the things you love to read."}</p></div>
          {activeCollection && <div className="intro-actions"><button className="button button-quiet" onClick={() => void exportCollection(activeCollection)}><Upload size={15} /> Export collection</button><input ref={collectionImportInput} className="visually-hidden" type="file" accept=".json,application/json" onChange={(event) => void importCollectionFile(event.target.files?.[0])} /><button className="button button-quiet" onClick={() => collectionImportInput.current?.click()} disabled={collectionImport.isPending}>{collectionImport.isPending ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />} Import collection</button><button className="button button-quiet" onClick={() => openCollectionDialog(activeCollection)}><Settings2 size={15} /> Edit collection</button><button className="icon-button collection-delete" onClick={() => { if (window.confirm(`Delete “${activeCollection.name}”? Publications remain in All publications.`)) collectionDelete.mutate(activeCollection.id); }} title="Delete collection"><Trash2 size={16} /></button></div>}
        </section>
        <section className="library-toolbar">
          <div className="results-count"><strong>{showCollections ? visibleCollections.length : publications.length}</strong> {showCollections ? (visibleCollections.length === 1 ? "collection" : "collections") : (publications.length === 1 ? "publication" : "publications")}{search && <span> matching “{search}”</span>}</div>
          <div className="toolbar-actions"><label className="search-box"><Search size={16} /><input ref={searchInput} value={search} onChange={(event) => setSearch(event.target.value)} placeholder={showCollections ? "Search collections" : "Search your library"} /><kbd>⌘ K</kbd></label>
            <div className="sort-wrap"><button className={`button button-quiet sort-button ${sortOpen ? "is-open" : ""}`} onClick={() => setSortOpen((value) => !value)}><ArrowDownWideNarrow size={15} /> Sort <ChevronDown size={13} /></button>{sortOpen && <div className="sort-menu">{([["newest", showCollections ? "Recently updated" : "Newest first"], ["oldest", "Oldest first"], ["title", showCollections ? "Name A–Z" : "Title A–Z"]] as const).map(([key, label]) => <button key={key} onClick={() => { setSortOrder(key); setSortOpen(false); }}>{label}{sortOrder === key && <Check size={14} />}</button>)}</div>}</div>
            <span className="toolbar-separator" />
            <div className="view-toggle"><button className={viewMode === "grid" ? "selected" : ""} onClick={() => setViewMode("grid")} aria-label="Tile view"><Grid2X2 size={16} /></button><button className={viewMode === "list" ? "selected" : ""} onClick={() => setViewMode("list")} aria-label="List view"><LayoutList size={17} /></button></div>
            <button className="button button-primary add-publication-button" onClick={() => showCollections ? openCollectionDialog() : openPublicationDialog()}><Plus size={16} /> {showCollections ? "New collection" : "Add publication"}</button>
          </div>
        </section>
        {!showCollections && activeCollection && <section className="collection-tools">
          <div className="collection-tool-actions">
            {!selectionMode ? <button className="button button-quiet" onClick={() => setSelectionMode(true)}><Check size={15} /> Select publications</button> : <>
              <span className="selection-count">{selectedPublicationIds.size} selected</span>
              <button className="button button-quiet" onClick={toggleVisibleSelection}>{publications.length > 0 && publications.every((publication) => selectedPublicationIds.has(publication.id)) ? "Deselect visible" : "Select visible"}</button>
              <button className="button button-quiet" onClick={() => setSelectedPublicationIds(new Set())} disabled={!selectedPublicationIds.size}>Clear</button>
              <button className="button button-primary" onClick={() => void saveSelectedPublications()} disabled={!isTauri() || !selectedPublicationIds.size || bulkOfflineMutation.isPending} title={!isTauri() ? "Saving publications is available in the desktop app" : undefined}>
                {bulkOfflineMutation.isPending ? <LoaderCircle size={15} className="spin" /> : <Download size={15} />}
                {bulkOfflineMutation.isPending ? "Saving…" : `Save selected${selectedPublicationIds.size ? ` (${selectedPublicationIds.size})` : ""}`}
              </button>
              {offlineProgress && <span className="offline-progress" role="status">Saving “{offlineProgress}”…</span>}
              <button className="button button-quiet" onClick={() => { setSelectionMode(false); setSelectedPublicationIds(new Set()); }}>Done</button>
            </>}
          </div>
          <button className="button button-quiet storage-location-button" onClick={() => void chooseDownloadLocation()} title={downloadRoot || "Choose where collection PDFs are stored"}>
            <FolderOpen size={15} /> {downloadRoot ? `Folder: ${downloadRoot.split(/[\\/]/).filter(Boolean).pop() || downloadRoot}` : "Choose storage folder"}
          </button>
          {!isTauri() && <small className="form-hint">PDF saving is available in the desktop app.</small>}
        </section>}
        {offlineSaveErrors.length > 0 && <div className="offline-save-errors" role="alert"><div className="offline-save-errors-heading"><strong>Some publications could not be saved.</strong><button className="text-button" onClick={() => setOfflineSaveErrors([])}>Dismiss</button></div><ul>{offlineSaveErrors.map((error, index) => <li key={`${index}-${error}`}>{error}</li>)}</ul></div>}

        {showCollections ? visibleCollections.length ? <section className={`collection-grid ${viewMode === "list" ? "collection-list-view" : ""}`}>
          {visibleCollections.map((collection) => <CollectionCard key={collection.id} collection={collection} isList={viewMode === "list"} onOpen={() => { setSelectedCollectionId(collection.id); setShowCollections(false); }} onEdit={() => openCollectionDialog(collection)} onDelete={() => { if (window.confirm(`Delete “${collection.name}”? Publications remain in All publications.`)) collectionDelete.mutate(collection.id); }} />)}
        </section> : <div className="empty-state"><div className="empty-art"><div className="empty-sun" /><div className="empty-book empty-book-a" /><div className="empty-book empty-book-b" /><div className="empty-book empty-book-c" /><div className="empty-table" /></div><span className="eyebrow">A SHELF WITH ROOM TO GROW</span><h2>{search ? "No collections found" : "Create your first collection"}</h2><p>{search ? "Try another collection name or clear your search." : "Collections give your Archive.org publications a place of their own."}</p><div className="empty-actions">{search ? <button className="button button-quiet" onClick={() => setSearch("")}>Clear search</button> : <button className="button button-primary" onClick={() => openCollectionDialog()}><Plus size={16} /> Create collection</button>}</div></div> : publicationsQuery.isLoading ? <div className="loading-state"><LoaderCircle className="spin" size={25} /><span>Opening your library…</span></div> : publicationsQuery.isError ? <div className="error-state"><h3>Couldn’t load your library</h3><p>{publicationsQuery.error.message}</p><button className="button button-quiet" onClick={() => void publicationsQuery.refetch()}>Try again</button></div> : publications.length ? <section className={`publication-grid ${viewMode === "list" ? "list-view" : ""}`}>
          {publications.map((publication) => <PublicationCard key={publication.id} publication={publication} isList={viewMode === "list"} onOpen={() => selectionMode ? togglePublicationSelection(publication.id) : setReading(publication)} onEdit={() => openPublicationDialog(publication)} onRemoveOffline={selectedCollectionId && publication.local_pdf_path ? () => offlineRemoveMutation.mutate(publication) : undefined} offlinePending={offlineRemoveMutation.isPending && offlineRemoveMutation.variables?.id === publication.id} selectable={selectionMode && !!selectedCollectionId} selected={selectedPublicationIds.has(publication.id)} onSelect={() => togglePublicationSelection(publication.id)} deleteLabel={selectedCollectionId ? "Remove from collection" : "Delete publication"} onDelete={() => {
            const action = selectedCollectionId ? `Remove “${publication.title}” from this collection?` : `Delete “${publication.title}” from your library?`;
            if (window.confirm(action)) publicationDelete.mutate({ publicationId: publication.id, collectionId: selectedCollectionId, localPdfPath: publication.local_pdf_path });
          }} />)}
        </section> : <div className="empty-state"><div className="empty-art"><div className="empty-sun" /><div className="empty-book empty-book-a" /><div className="empty-book empty-book-b" /><div className="empty-book empty-book-c" /><div className="empty-table" /></div><span className="eyebrow">A SHELF WITH ROOM TO GROW</span><h2>{search ? "No publications found" : selectedCollectionId ? "This collection is waiting" : "Your reading room awaits"}</h2><p>{search ? "Try another title, publisher, or subject." : selectedCollectionId ? "Start gathering the issues and documents that belong here." : "Start by creating a collection, then add your favorite Archive.org publications."}</p><div className="empty-actions">{search ? <button className="button button-quiet" onClick={() => setSearch("")}>Clear search</button> : <>{!selectedCollectionId && <button className="button button-quiet" onClick={() => openCollectionDialog()}><FolderOpen size={15} /> Create collection</button>}<button className="button button-primary" onClick={() => openPublicationDialog()} disabled={!collections.length}><Plus size={16} /> Add a publication</button></>}</div>{!collections.length && !search && <small className="empty-tip">You’ll need a collection before adding your first publication.</small>}</div>}
        <footer className="content-footer"><span><Clock3 size={13} /> Your catalog is saved locally</span><span>Saved PDF copies are available offline</span></footer>
      </div>
    </main>

    {dialog === "new-collection" || dialog === "edit-collection" ? <CollectionDialog collection={editingCollection} onClose={() => setDialog(null)} busy={collectionSave.isPending} onSave={(data) => collectionSave.mutate(data)} /> : null}
    {dialog === "add-publication" || dialog === "edit-publication" ? <PublicationDialog initial={editingPublication} collections={collections} collectionId={editingPublication ? selectedCollectionId : addTargetCollectionId} onCollectionChange={setAddTargetCollectionId} onCreateCollection={() => setQuickCollectionDialogOpen(true)} onClose={() => { setDialog(null); setEditingPublication(undefined); }} busy={publicationSave.isPending} onSave={(draft) => publicationSave.mutate({ draft, id: editingPublication?.id, collectionId: editingPublication ? selectedCollectionId : addTargetCollectionId })} /> : null}
    {quickCollectionDialogOpen && <CollectionDialog onClose={() => setQuickCollectionDialogOpen(false)} busy={quickCollectionSave.isPending} onSave={(data) => quickCollectionSave.mutate(data)} />}
    {reading && <Suspense fallback={<div className="reader-backdrop"><div className="reader-message"><LoaderCircle className="spin" size={28} /><span>Preparing reader…</span></div></div>}><PdfReader publication={reading} onClose={() => setReading(undefined)} /></Suspense>}
    {notice && <div className="toast"><Check size={16} />{notice}<button onClick={() => setNotice("")} aria-label="Dismiss"><X size={14} /></button></div>}
  </div>;
}
