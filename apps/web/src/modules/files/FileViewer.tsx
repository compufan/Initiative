import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { formatBytes, formatDuration, type AttachmentDto } from '@initiative/shared';
import { FotoWerkstatt } from '../media/FotoWerkstatt.js';
import { mediaSrc } from '../media/helpers.js';

interface FileViewerProps {
  items: AttachmentDto[];
  index: number;
  onClose: () => void;
  /**
   * Wohin eine bearbeitete Fassung gehört – bei einer Sammlung: in dieselbe.
   * Ohne das erscheinen Bearbeiten und Sticker gar nicht erst.
   */
  ablegen?: (blob: Blob, name: string) => Promise<void>;
  zielName?: string;
}

/**
 * Der eingebaute Betrachter für alles, was in einer Sammlung liegen kann.
 *
 * Bild, Video, Ton und PDF werden hier gezeigt, ohne die App zu verlassen.
 * Alles Übrige bekommt eine ehrliche Karte mit Namen, Größe und einem Knopf
 * zum Öffnen – ein leerer schwarzer Kasten wäre schlechter als die Auskunft,
 * dass dieser Dateityp sich hier nicht anzeigen lässt.
 */
export function FileViewer({ items, index, onClose, ablegen, zielName }: FileViewerProps) {
  const [aktuell, setAktuell] = useState(index);
  /** Solange Editor oder Studio offen sind, deutet der Betrachter keine Tasten. */
  const [werkstattOffen, setWerkstattOffen] = useState(false);
  const datei = items[aktuell];

  // Die Seite dahinter bleibt gesperrt, solange der Betrachter offen ist –
  // auch waehrend Editor oder Studio darueber liegen.
  useEffect(() => {
    const vorher = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = vorher;
    };
  }, []);

  useEffect(() => {
    if (werkstattOffen) return undefined;
    const beiTaste = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
      if (event.key === 'ArrowRight') setAktuell((wert) => (wert + 1) % items.length);
      if (event.key === 'ArrowLeft') setAktuell((wert) => (wert - 1 + items.length) % items.length);
    };
    window.addEventListener('keydown', beiTaste);
    return () => window.removeEventListener('keydown', beiTaste);
  }, [items.length, onClose, werkstattOffen]);

  if (!datei) return null;

  return createPortal(
    <div className="fv-backdrop" role="dialog" aria-modal="true">
      <header className="fv-bar">
        <button type="button" className="icon-btn" aria-label="Schließen" onClick={onClose}>
          ✕
        </button>
        <div className="fv-title">
          <strong className="truncate">{datei.fileName ?? 'Datei'}</strong>
          <span className="fv-meta">{formatBytes(datei.size)}</span>
        </div>
        {datei.kind === 'image' && (
          <FotoWerkstatt
            foto={datei}
            ablegen={ablegen}
            zielName={zielName}
            onOffen={setWerkstattOffen}
          />
        )}
        <a
          className="icon-btn"
          href={mediaSrc(datei)}
          target="_blank"
          rel="noreferrer"
          aria-label="In neuem Tab öffnen"
        >
          ↗
        </a>
      </header>

      <div className="fv-body">
        <Inhalt datei={datei} />
      </div>

      {items.length > 1 && (
        <footer className="fv-bar fv-bar-bottom">
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAktuell((wert) => (wert - 1 + items.length) % items.length)}
          >
            ‹ Zurück
          </button>
          <span className="fv-meta">
            {aktuell + 1} von {items.length}
          </span>
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setAktuell((wert) => (wert + 1) % items.length)}
          >
            Weiter ›
          </button>
        </footer>
      )}
    </div>,
    document.body,
  );
}

function Inhalt({ datei }: { datei: AttachmentDto }) {
  const quelle = mediaSrc(datei);
  const mime = datei.mime.split(';')[0].trim().toLowerCase();

  if (datei.kind === 'image' || mime.startsWith('image/')) {
    return <img className="fv-image" src={quelle} alt={datei.fileName ?? 'Bild'} />;
  }

  if (datei.kind === 'video' || mime.startsWith('video/')) {
    return (
      // eslint-disable-next-line jsx-a11y/media-has-caption
      <video
        className="fv-video"
        src={quelle}
        poster={datei.previewDataUrl ?? undefined}
        controls
        playsInline
        preload="metadata"
      />
    );
  }

  if (datei.kind === 'audio' || mime.startsWith('audio/')) {
    return (
      <div className="fv-card">
        <div className="fv-card-icon" aria-hidden="true">
          🎵
        </div>
        <strong>{datei.fileName ?? 'Tonaufnahme'}</strong>
        {datei.durationMs != null && datei.durationMs > 0 && (
          <span className="fv-meta">{formatDuration(datei.durationMs)}</span>
        )}
        {/* eslint-disable-next-line jsx-a11y/media-has-caption */}
        <audio className="fv-audio" src={quelle} controls preload="metadata" />
      </div>
    );
  }

  if (mime === 'application/pdf') {
    // Ein <object> statt <iframe>: Safari auf dem iPhone zeigt PDFs in einem
    // iframe nur als leere Fläche, hier greift wenigstens der Rückfall.
    return (
      <object className="fv-pdf" data={quelle} type="application/pdf" aria-label="PDF">
        <Unbekannt datei={datei} hinweis="Dieses Gerät kann PDFs nicht in der App anzeigen." />
      </object>
    );
  }

  return <Unbekannt datei={datei} />;
}

function Unbekannt({ datei, hinweis }: { datei: AttachmentDto; hinweis?: string }) {
  return (
    <div className="fv-card">
      <div className="fv-card-icon" aria-hidden="true">
        📄
      </div>
      <strong className="truncate">{datei.fileName ?? 'Datei'}</strong>
      <span className="fv-meta">
        {datei.mime} · {formatBytes(datei.size)}
      </span>
      <p className="fv-hint">
        {hinweis ?? 'Dieser Dateityp lässt sich hier nicht anzeigen.'} Zum Öffnen brauchst du eine
        passende App auf dem Gerät.
      </p>
      <a className="btn btn-primary" href={mediaSrc(datei)} target="_blank" rel="noreferrer">
        Öffnen
      </a>
    </div>
  );
}
