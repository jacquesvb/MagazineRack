import { useEffect, useRef, useState } from "react";
import { ChevronLeft, ChevronRight, Download, ExternalLink, LoaderCircle, Minus, Plus, X } from "lucide-react";
import * as pdfjs from "pdfjs-dist";
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { downloadArchivePdf } from "./archive";
import { readOfflinePdf } from "./offline";
import type { Publication } from "./types";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;

export default function PdfReader({ publication, onClose }: { publication: Publication; onClose: () => void }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const pdfRef = useRef<pdfjs.PDFDocumentProxy | null>(null);
  const renderTaskRef = useRef<pdfjs.RenderTask | null>(null);
  const [pageCount, setPageCount] = useState(0);
  const [pageNumber, setPageNumber] = useState(1);
  const [scale, setScale] = useState(1.15);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");

  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setPageNumber(1);
    setPageCount(0);
    (publication.local_pdf_path ? readOfflinePdf(publication.local_pdf_path) : downloadArchivePdf(publication.source_url))
      .then((data) => pdfjs.getDocument({ data }).promise)
      .then((document) => {
        if (!active) { void document.destroy(); return; }
        pdfRef.current = document;
        setPageCount(document.numPages);
        setLoading(false);
      })
      .catch((reason: unknown) => {
        if (active) {
          setError(publication.local_pdf_path
            ? "The saved PDF could not be read. Remove its offline copy and download it again."
            : reason instanceof Error ? reason.message : "The PDF could not be opened.");
          setLoading(false);
        }
      });
    return () => { active = false; renderTaskRef.current?.cancel(); void pdfRef.current?.destroy(); pdfRef.current = null; };
  }, [publication.source_url, publication.local_pdf_path]);

  useEffect(() => {
    let active = true;
    renderTaskRef.current?.cancel();
    const render = async () => {
      const doc = pdfRef.current;
      const canvas = canvasRef.current;
      if (!doc || !canvas) return;
      try {
        const page = await doc.getPage(pageNumber);
        if (!active) return;
        const viewport = page.getViewport({ scale });
        const context = canvas.getContext("2d");
        if (!context) return;
        const ratio = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * ratio);
        canvas.height = Math.floor(viewport.height * ratio);
        canvas.style.width = `${viewport.width}px`;
        canvas.style.height = `${viewport.height}px`;
        context.setTransform(ratio, 0, 0, ratio, 0, 0);
        const task = page.render({ canvasContext: context, viewport });
        renderTaskRef.current = task;
        await task.promise;
      } catch (reason) {
        if (active && !(reason instanceof Error && reason.name === "RenderingCancelledException")) {
          setError("This page could not be rendered.");
        }
      }
    };
    void render();
    return () => { active = false; renderTaskRef.current?.cancel(); };
  }, [pageNumber, scale, pageCount]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
      if (event.key === "ArrowRight") setPageNumber((page) => Math.min(pageCount, page + 1));
      if (event.key === "ArrowLeft") setPageNumber((page) => Math.max(1, page - 1));
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose, pageCount]);

  return <div className="reader-backdrop" role="dialog" aria-modal="true" aria-label={`Reading ${publication.title}`}>
    <header className="reader-toolbar">
      <div className="reader-title"><button className="icon-button toolbar-close" onClick={onClose} aria-label="Close reader"><X size={19} /></button><div><strong>{publication.title}</strong><span>{publication.local_pdf_path ? "Saved on this device" : publication.date || "Archive.org PDF"}</span></div></div>
      <div className="reader-controls">
        <button className="icon-button" onClick={() => setScale((value) => Math.max(0.6, value - 0.15))} aria-label="Zoom out"><Minus size={17} /></button>
        <span className="zoom-label">{Math.round(scale * 100)}%</span>
        <button className="icon-button" onClick={() => setScale((value) => Math.min(2.4, value + 0.15))} aria-label="Zoom in"><Plus size={17} /></button>
        <span className="toolbar-divider" />
        <button className="icon-button" disabled={pageNumber <= 1} onClick={() => setPageNumber((page) => page - 1)} aria-label="Previous page"><ChevronLeft size={19} /></button>
        <span className="page-label">{pageCount ? `${pageNumber} / ${pageCount}` : "—"}</span>
        <button className="icon-button" disabled={!pageCount || pageNumber >= pageCount} onClick={() => setPageNumber((page) => page + 1)} aria-label="Next page"><ChevronRight size={19} /></button>
      </div>
      <a className="icon-button reader-external" href={publication.source_url} target="_blank" rel="noreferrer" title="Open PDF on Archive.org"><ExternalLink size={17} /></a>
    </header>
    <main className="reader-canvas-area">
      {loading && <div className="reader-message"><LoaderCircle className="spin" size={28} /><span>Loading publication…</span></div>}
      {error && <div className="reader-message reader-error"><p>{error}</p><a href={publication.source_url} target="_blank" rel="noreferrer"><Download size={15} /> Open on Archive.org</a></div>}
      <canvas ref={canvasRef} className="pdf-canvas" />
    </main>
  </div>;
}
