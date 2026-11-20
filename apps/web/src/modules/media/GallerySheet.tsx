import { useEffect, useRef, useState, type ChangeEvent } from 'react';
import { LIMITS, formatBytes, formatDuration } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { EmptyState, Spinner } from '../../components/Feedback.js';
import { prepareImage, videoPreview } from '../../lib/upload.js';
import { BildBearbeiten } from '../bild/BildBearbeiten.js';
import { rezeptSenden } from './RezeptBubble.js';
import type { Anpassung } from '../bild/ton.js';
import type { ComposerActionProps } from '../types.js';
import { toast } from '../../state/ui.js';
import { hdGemerkt, hdMerken, hdZiel, istHd } from './fotoQualitaet.js';
import {
  buildAttachment,
  errorMessage,
  kindForFile,
  mimeForFile,
  sendMedia,
  withinUploadLimit,
} from './helpers.js';

interface GalleryItem {
  id: string;
  kind: 'image' | 'video';
  blob: Blob;
  /**
   * Die Datei, wie sie hereinkam – vor jeder Bearbeitung.
   *
   * Nur dafür da, dass „auf alle übertragen" auf einem BEREITS bearbeiteten
   * Bild nicht doppelt rechnet: Ohne sie läge der Kontrast des einen Laufs
   * noch in den Bildpunkten, und der des zweiten käme obendrauf.
   */
  original: Blob;
  /**
   * Die gewählte Datei selbst, unverändert – für „Als Datei senden“ (Original
   * mit allen Metadaten) und um beim Umschalten auf HD neu zu rechnen.
   */
  quelle: File;
  mime: string;
  fileName: string;
  url: string;
  width?: number;
  height?: number;
  durationMs?: number;
  previewDataUrl?: string;
  size: number;
}

const MAX_SELECTION = 20;

/**
 * Eine fortlaufende Nummer, die den ganzen Lebenslauf des Blatts durchhält.
 *
 * Bewusst ein Modulzähler und keine Zufallszahl: Er ist nachvollziehbar, und
 * in Tests kommt zweimal dasselbe heraus.
 */
let kennungZaehler = 0;
function naechsteKennung(): number {
  kennungZaehler += 1;
  return kennungZaehler;
}

/** Photo and video picker with a preview grid and one shared caption. */
export function GallerySheet({ conversationId, onClose }: ComposerActionProps) {
  const [items, setItems] = useState<GalleryItem[]>([]);
  const [caption, setCaption] = useState('');
  const [loading, setLoading] = useState(false);
  const [sending, setSending] = useState(false);
  /** HD: bis 4096 Punkte statt 1920 (`fotoQualitaet.ts`), je Gerät gemerkt. */
  const [hd, setHd] = useState(hdGemerkt);
  const [umrechnen, setUmrechnen] = useState(false);
  /*
   * Solange der Fotoeditor offen ist, tritt dieses Blatt zur Seite.
   *
   * Sonst läge es darüber: Ein Blatt liegt mit Absicht über der Werkstatt,
   * weil aus der Werkstatt heraus Blätter aufgehen – hier ist es umgekehrt.
   */
  const [editorOffen, setEditorOffen] = useState(false);
  /** Der Stand der Reihe: `null` heisst, es läuft gerade keine. */
  const [reihe, setReihe] = useState<{ fertig: number; gesamt: number } | null>(null);
  const reihenAbbruch = useRef<AbortController | null>(null);
  const itemsRef = useRef<GalleryItem[]>([]);

  useEffect(() => {
    itemsRef.current = items;
  }, [items]);

  // Release every preview URL when the sheet closes.
  useEffect(
    () => () => {
      itemsRef.current.forEach((item) => URL.revokeObjectURL(item.url));
    },
    [],
  );

  const pick = async (event: ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(event.target.files ?? []);
    event.target.value = '';
    if (files.length === 0) return;

    setLoading(true);
    const next: GalleryItem[] = [];
    try {
      for (const file of files) {
        if (items.length + next.length >= MAX_SELECTION) {
          toast(`Es können höchstens ${MAX_SELECTION} Dateien auf einmal gesendet werden`, 'info');
          break;
        }
        const kind = kindForFile(file);
        if (kind !== 'image' && kind !== 'video') {
          toast(`„${file.name}“ ist kein Foto und kein Video`, 'error');
          continue;
        }
        if (!withinUploadLimit(kind, file.size, file.name)) continue;

        try {
          if (kind === 'image') {
            const ziel = hdZiel(hd);
            const prepared = await prepareImage(file, ziel.kante, false, ziel.guete);
            next.push({
              /*
               * Die Kennung muss über AUFRUFE hinweg eindeutig sein.
               *
               * `next.length` zählt nur innerhalb des gerade gewählten
               * Stapels. Wer dieselbe Datei zweimal auswählte – „Weitere
               * auswählen" und noch einmal dasselbe Foto –, bekam zweimal
               * dieselbe Kennung, und das ✕ auf der einen Kachel entfernte
               * beide: `remove` filtert über `item.id !== id`.
               */
              id: `${file.name}-${file.lastModified}-${naechsteKennung()}`,
              kind,
              blob: prepared.blob,
              original: prepared.blob,
              quelle: file,
              mime: prepared.mime,
              fileName: file.name,
              url: URL.createObjectURL(prepared.blob),
              width: prepared.width,
              height: prepared.height,
              previewDataUrl: prepared.previewDataUrl,
              size: prepared.blob.size,
            });
          } else {
            const preview = await videoPreview(file);
            next.push({
              // Dieselbe Begründung wie beim Bild darüber – hier war sie beim
              // Beheben schlicht übersehen worden.
              id: `${file.name}-${file.lastModified}-${naechsteKennung()}`,
              kind,
              blob: file,
              original: file,
              quelle: file,
              mime: mimeForFile(file),
              fileName: file.name,
              url: URL.createObjectURL(file),
              width: preview?.width,
              height: preview?.height,
              durationMs: preview?.durationMs,
              previewDataUrl: preview?.previewDataUrl,
              size: file.size,
            });
          }
        } catch (error) {
          toast(errorMessage(error, `„${file.name}“ konnte nicht gelesen werden`), 'error');
        }
      }
      if (next.length > 0) setItems((current) => [...current, ...next]);
    } finally {
      setLoading(false);
    }
  };

  /**
   * HD an oder aus – und die noch unbearbeiteten Bilder neu rechnen.
   *
   * Bearbeitete bleiben, wie sie sind: Neu aus der Quelle gerechnet, wäre die
   * Bearbeitung weg.
   */
  const hdSetzen = async (an: boolean) => {
    setHd(an);
    hdMerken(an);
    const ziele = itemsRef.current.filter(
      (item) => item.kind === 'image' && item.blob === item.original,
    );
    if (ziele.length === 0) return;
    setUmrechnen(true);
    try {
      const ziel = hdZiel(an);
      const neu = new Map<string, Awaited<ReturnType<typeof prepareImage>>>();
      for (const item of ziele) {
        neu.set(item.id, await prepareImage(item.quelle, ziel.kante, false, ziel.guete));
      }
      setItems((alt) =>
        alt.map((eintrag) => {
          const fertig = neu.get(eintrag.id);
          if (!fertig || eintrag.blob !== eintrag.original) return eintrag;
          URL.revokeObjectURL(eintrag.url);
          return {
            ...eintrag,
            blob: fertig.blob,
            original: fertig.blob,
            mime: fertig.mime,
            url: URL.createObjectURL(fertig.blob),
            width: fertig.width,
            height: fertig.height,
            previewDataUrl: fertig.previewDataUrl,
            size: fertig.blob.size,
          };
        }),
      );
    } catch (error) {
      toast(errorMessage(error, 'Die Bilder konnten nicht neu berechnet werden'), 'error');
    } finally {
      setUmrechnen(false);
    }
  };

  /**
   * „Als Datei senden“: jede gewählte Datei unverändert, als Dokument – ohne
   * Verkleinern, ohne Neukodierung, mit allen Metadaten.
   */
  const alsDateiSenden = async () => {
    if (items.length === 0 || sending) return;
    if (!items.every((item) => withinUploadLimit('file', item.quelle.size, item.fileName))) return;
    setSending(true);
    try {
      for (const item of items) {
        const ok = await sendMedia(conversationId, 'file', null, [
          buildAttachment({
            kind: 'file',
            mime: item.quelle.type || mimeForFile(item.quelle),
            fileName: item.quelle.name || item.fileName,
            blob: item.quelle,
          }),
        ]);
        if (!ok) return;
      }
      onClose();
    } finally {
      setSending(false);
    }
  };

  const remove = (id: string) => {
    setItems((current) => {
      const hit = current.find((item) => item.id === id);
      if (hit) URL.revokeObjectURL(hit.url);
      return current.filter((item) => item.id !== id);
    });
  };

  /**
   * Tauscht ein ausgewähltes Bild gegen seine bearbeitete Fassung.
   *
   * Die alte Vorschau-Adresse wird freigegeben – sonst hielte jede Bearbeitung
   * das ursprüngliche Bild bis zum Neuladen der Seite im Speicher fest.
   */
  const ersetzen = async (id: string, fertig: Blob, fertigName: string) => {
    // Wie in `CameraSheet`: schon kodiert, also nicht noch einmal.
    const prepared = await prepareImage(
      new File([fertig], fertigName, { type: fertig.type || 'image/webp' }),
      1920,
      true,
    );
    setItems((alt) =>
      alt.map((eintrag) => {
        if (eintrag.id !== id) return eintrag;
        URL.revokeObjectURL(eintrag.url);
        return {
          ...eintrag,
          blob: prepared.blob,
          mime: prepared.mime,
          fileName: fertigName,
          url: URL.createObjectURL(prepared.blob),
          width: prepared.width,
          height: prepared.height,
          previewDataUrl: prepared.previewDataUrl,
          size: prepared.blob.size,
        };
      }),
    );
    toast('Bearbeitete Fassung übernommen.', 'success');
  };

  /**
   * Licht und Farbe eines Bildes auf alle anderen Bilder der Auswahl.
   *
   * Gerechnet wird vom ORIGINAL jedes Eintrags, nicht von seiner
   * möglicherweise schon bearbeiteten Fassung – sonst läge bei einem Bild,
   * an dem vorher jemand gedreht hat, beides übereinander.
   *
   * Videos bleiben aussen vor: Sie durch die Farbkette zu schicken hiesse,
   * sie neu zu kodieren, und das ist etwas völlig anderes als ein Foto
   * durchzurechnen.
   */
  const uebertragen = async (anpassung: Anpassung) => {
    const ziele = itemsRef.current.filter((item) => item.kind === 'image');
    if (ziele.length === 0) return;
    const steuerung = new AbortController();
    reihenAbbruch.current = steuerung;
    setReihe({ fertig: 0, gesamt: ziele.length });
    /*
     * Die Rechnung erst hier holen: Sie zieht die ganze Zeichenkette des
     * Editors mit, und die braucht nur, wer wirklich überträgt. Die Klasse
     * für den Abbruch kommt aus demselben Modul – deshalb steht sie neben
     * dem `try`, damit der `catch` sie kennt.
     */
    let abbruchArt: (new (...args: never[]) => Error) | null = null;
    try {
      const { StapelAbbruch, stapelAnwenden } = await import('../bild/stapel.js');
      abbruchArt = StapelAbbruch;
      const ergebnis = await stapelAnwenden(
        ziele.map((item) => ({ id: item.id, quelle: item.original })),
        anpassung,
        (fertig, gesamt) => setReihe({ fertig, gesamt }),
        steuerung.signal,
      );
      /*
       * Durch `prepareImage` wie beim Bearbeiten eines einzelnen Bildes.
       *
       * Nicht wegen der Grösse – die stimmt schon –, sondern wegen der
       * Vorschau: An ihr hängt die sofort sichtbare, unscharfe Kachel im
       * Chat. Ohne sie käme das Bild dort als leerer Rahmen an, bis es
       * geladen ist, und das gerade bei Bildern, die durch eine Reihe
       * gelaufen sind. Der Merker `true` sagt „ist schon kodiert" – es wird
       * also nicht ein zweites Mal komprimiert.
       */
      const vorschauen = new Map<string, Awaited<ReturnType<typeof prepareImage>>>();
      for (const [id, neu] of ergebnis) {
        vorschauen.set(
          id,
          await prepareImage(new File([neu.blob], 'reihe', { type: neu.mime }), 1920, true),
        );
      }
      setItems((alt) =>
        alt.map((eintrag) => {
          const fertig = vorschauen.get(eintrag.id);
          if (!fertig) return eintrag;
          URL.revokeObjectURL(eintrag.url);
          return {
            ...eintrag,
            blob: fertig.blob,
            mime: fertig.mime,
            url: URL.createObjectURL(fertig.blob),
            width: fertig.width,
            height: fertig.height,
            previewDataUrl: fertig.previewDataUrl,
            size: fertig.blob.size,
          };
        }),
      );
      toast(
        `Licht und Farbe auf ${ziele.length} ${ziele.length === 1 ? 'Bild' : 'Bilder'} übertragen.`,
        'success',
      );
    } catch (error) {
      if (abbruchArt && error instanceof abbruchArt)
        toast('Abgebrochen – nichts geändert.', 'info');
      else toast(errorMessage(error, 'Das Übertragen ist fehlgeschlagen'), 'error');
    } finally {
      reihenAbbruch.current = null;
      setReihe(null);
    }
  };

  const send = async () => {
    if (items.length === 0 || sending) return;
    setSending(true);
    try {
      const images = items.filter((item) => item.kind === 'image');
      const videos = items.filter((item) => item.kind === 'video');
      let captionUsed = false;

      for (let index = 0; index < images.length; index += LIMITS.attachmentsPerMessage) {
        const chunk = images.slice(index, index + LIMITS.attachmentsPerMessage);
        const ok = await sendMedia(
          conversationId,
          'image',
          captionUsed ? null : caption,
          chunk.map((item) =>
            buildAttachment({
              kind: 'image',
              mime: item.mime,
              fileName: item.fileName,
              blob: item.blob,
              width: item.width,
              height: item.height,
              previewDataUrl: item.previewDataUrl,
            }),
          ),
        );
        if (!ok) return;
        captionUsed = true;
      }

      for (const item of videos) {
        const ok = await sendMedia(conversationId, 'video', captionUsed ? null : caption, [
          buildAttachment({
            kind: 'video',
            mime: item.mime,
            fileName: item.fileName,
            blob: item.blob,
            width: item.width,
            height: item.height,
            durationMs: item.durationMs,
            previewDataUrl: item.previewDataUrl,
          }),
        ]);
        if (!ok) return;
        captionUsed = true;
      }

      onClose();
    } finally {
      setSending(false);
    }
  };

  const totalSize = items.reduce((sum, item) => sum + item.size, 0);

  return (
    <Sheet open onClose={onClose} title="Foto oder Video" beiseite={editorOffen}>
      <label className="btn btn-primary btn-block">
        {items.length === 0 ? 'Dateien auswählen' : 'Weitere auswählen'}
        <input
          type="file"
          accept="image/*,video/*"
          multiple
          className="media-visually-hidden"
          onChange={(event) => void pick(event)}
        />
      </label>

      <label className="media-hd-schalter">
        <input
          type="checkbox"
          role="switch"
          checked={hd}
          disabled={umrechnen || sending}
          onChange={(event) => void hdSetzen(event.target.checked)}
        />
        <span className="media-hd-abzeichen" aria-hidden="true">
          HD
        </span>
        <span>
          Fotos in HD senden
          <span className="muted"> · bis 4096 statt 1920 Punkte</span>
        </span>
      </label>

      {(loading || umrechnen) && <Spinner label="Vorschau wird erstellt …" />}

      {!loading && items.length === 0 && (
        <EmptyState
          emoji="🖼️"
          title="Noch nichts ausgewählt"
          description="Wähle Fotos oder Videos aus deiner Galerie. Mehrfachauswahl ist möglich."
        />
      )}

      {items.length > 0 && (
        <>
          <div className="media-grid media-grid-3">
            {items.map((item) => (
              <div key={item.id} className="media-tile">
                {item.kind === 'image' ? (
                  <img src={item.url} alt={item.fileName} />
                ) : (
                  <>
                    {item.previewDataUrl ? (
                      <img src={item.previewDataUrl} alt={item.fileName} />
                    ) : (
                      <span className="media-tile-fallback" aria-hidden="true">
                        🎬
                      </span>
                    )}
                    <span className="media-badge">
                      ▶ {item.durationMs ? formatDuration(item.durationMs) : 'Video'}
                    </span>
                  </>
                )}
                {item.kind === 'image' && istHd(item.width, item.height) && (
                  <span className="media-hd-abzeichen media-tile-hd" title="In HD">
                    HD
                  </span>
                )}
                {item.kind === 'image' && (
                  <span className="media-tile-edit">
                    <BildBearbeiten
                      blob={item.blob}
                      name={item.fileName}
                      className="media-tile-knopf"
                      tipp="Zuschneiden, geraderichten, Licht und Farbe – vor dem Senden"
                      onFertig={(fertig, fertigName) => ersetzen(item.id, fertig, fertigName)}
                      onOffen={setEditorOffen}
                      stapelAnzahl={items.filter((e) => e.kind === 'image').length - 1}
                      onStapel={uebertragen}
                      /*
                       * Nur bei genau EINEM Bild in der Auswahl.
                       *
                       * Eine Rezeptnachricht trägt ein Bild und eine
                       * Anweisung. Bei drei Bildern bliebe offen, zu welchem
                       * die Anweisung gehört – und der Empfänger sähe zwei
                       * unbearbeitete Fotos neben einem bearbeiteten.
                       */
                      alsRezept={
                        items.length === 1
                          ? async (original, rezept, rezeptName) => {
                              setSending(true);
                              const ok = await rezeptSenden(
                                conversationId,
                                original,
                                rezept,
                                rezeptName,
                                item,
                                caption,
                              );
                              setSending(false);
                              if (ok) onClose();
                            }
                          : undefined
                      }
                    />
                  </span>
                )}
                <button
                  type="button"
                  className="media-tile-remove"
                  onClick={() => remove(item.id)}
                  aria-label={`${item.fileName} entfernen`}
                  data-tipp="Diese Datei aus der Auswahl nehmen"
                >
                  <span className="media-tile-x" aria-hidden="true">
                    ✕
                  </span>
                </button>
              </div>
            ))}
          </div>

          <p className="muted" style={{ margin: 0, fontSize: '0.82rem' }}>
            {items.length} {items.length === 1 ? 'Datei' : 'Dateien'} · {formatBytes(totalSize)}
          </p>

          {/*
            Der Stand der Reihe – mit Abbruch.

            Eine Reihe über zwanzig Fotos dauert auf einem Telefon spürbar
            lange. Ohne Anzeige sähe es aus, als hänge die App; ohne Abbruch
            wäre man ihr ausgeliefert. Das `<progress>` ist bewusst das
            eingebaute Element und kein nachgebauter Balken: Es meldet sich
            bei einer Vorlesehilfe von selbst.
          */}
          {reihe && (
            <div className="media-reihe" role="status">
              <progress value={reihe.fertig} max={reihe.gesamt} />
              <span>
                Licht und Farbe übertragen … {reihe.fertig} von {reihe.gesamt}
              </span>
              <button
                type="button"
                className="btn btn-sm"
                onClick={() => reihenAbbruch.current?.abort()}
              >
                Abbrechen
              </button>
            </div>
          )}

          <input
            className="input"
            value={caption}
            onChange={(event) => setCaption(event.target.value)}
            placeholder="Bildunterschrift (optional)"
            aria-label="Bildunterschrift"
          />

          <button
            type="button"
            className="btn btn-primary btn-block"
            onClick={() => void send()}
            disabled={sending || reihe !== null || umrechnen}
          >
            {sending ? 'Wird gesendet …' : `Senden (${items.length})`}
          </button>
          <button
            type="button"
            className="btn btn-block"
            onClick={() => void alsDateiSenden()}
            disabled={sending || reihe !== null}
          >
            📎 Als Datei senden (Original)
          </button>
          <p className="muted" style={{ margin: 0, fontSize: '0.78rem' }}>
            Als Datei geht jedes Foto und Video unverändert hinaus – in voller Grösse und mit
            allen Angaben, die die Kamera hineinschreibt (etwa der Ort).
          </p>
        </>
      )}
    </Sheet>
  );
}
