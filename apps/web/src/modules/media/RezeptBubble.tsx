import { useEffect, useRef, useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import type { MessageRendererProps } from '../types.js';
import { MediaCaption, PendingMedia } from './MediaFrame.js';
import { buildAttachment, errorMessage, mediaBytes, mediaSrc, sendMedia } from './helpers.js';
import { BildEditor } from '../bild/BildEditor.js';
import { MAX_KANTE, type BildDoc } from '../bild/doc.js';
import { REZEPT_DATEINAME, REZEPT_MIME, rezeptLesen } from '../bild/rezept.js';
import { zeichneAusgabe } from '../bild/zeichnen.js';
import { prepareImage } from '../../lib/upload.js';
import { loadImageFromBlob } from '../stickers/helpers.js';
import { toast } from '../../state/ui.js';

/**
 * Ein Foto, dem seine Bearbeitung als Anweisung beiliegt.
 *
 * Zwei Blasen: oben das Ergebnis, darunter die Bearbeitung selbst – mit einem
 * Schalter auf das Original und einem Knopf zum Weiterdrehen. Das ist der
 * ganze Unterschied zur Bildblase: Dort sind die Regler in den Bildpunkten
 * verschwunden, hier stehen sie noch da.
 *
 * Gerechnet wird beim EMPFÄNGER, aus dem Original und der Anweisung. Das
 * kostet einen Augenblick beim ersten Anzeigen – und dafür ist alles
 * rücknehmbar, und das Bild ist genau einmal komprimiert und nicht zweimal.
 *
 * Geht dabei irgendetwas schief – kein `CompressionStream`, eine Datei aus
 * einer späteren Fassung, ein Rezept, das unterwegs verstümmelt wurde –, dann
 * steht hier das Original mit einem Satz daneben. Nicht ein roter Fehler: Das
 * Foto ist ja da, nur die Bearbeitung fehlt.
 */

/** Die grösste Kante, in der die Blase rechnet. */
const VORSCHAU_KANTE = 1600;

function rezeptAnhang(attachments: AttachmentDto[]): AttachmentDto | undefined {
  return attachments.find(
    (a) => a.kind === 'file' && (a.mime === REZEPT_MIME || a.fileName === REZEPT_DATEINAME),
  );
}

interface Stand {
  /** Das unberührte Bild, so wie es angekommen ist. */
  original: Blob;
  doc: BildDoc | null;
  /** Das gerechnete Ergebnis als Adresse – oder null, solange es keines gibt. */
  fertig: string | null;
  /**
   * Und das Original, ebenfalls als Adresse auf den schon geholten Blob.
   *
   * Nicht `mediaSrc`: Das zeigt auf die API, also auf eine andere Herkunft.
   * Die Bytes liegen hier ohnehin schon – ein zweites Herunterladen für
   * denselben Inhalt, und eine Leinwand, die das Bild danach anfasst, gilt
   * als „verunreinigt". Genau daran ist die erste Fassung dieser Blase im
   * Browser-Test gescheitert.
   */
  originalAdresse: string;
  breite: number;
  hoehe: number;
}

export function RezeptBubble({ message, isMine }: MessageRendererProps) {
  const [stand, setStand] = useState<Stand | null>(null);
  const [fehler, setFehler] = useState<string | null>(null);
  const [zeigtOriginal, setZeigtOriginal] = useState(false);
  const [bearbeitet, setBearbeitet] = useState(false);
  const [sendet, setSendet] = useState(false);
  /*
   * Die erzeugten Adressen an einem Ort.
   *
   * `URL.createObjectURL` hält den Blob fest, bis jemand `revokeObjectURL`
   * ruft – ein Foto von zwölf Megapunkten bleibt sonst im Arbeitsspeicher
   * liegen, auch wenn der Chat längst woanders ist. Bei zwanzig solchen
   * Blasen in einem Verlauf ist das kein Detail mehr.
   */
  const adressen = useRef<string[]>([]);

  const foto = message.attachments.find((a) => a.kind === 'image');
  const anweisung = rezeptAnhang(message.attachments);

  useEffect(() => {
    return () => {
      for (const adresse of adressen.current) URL.revokeObjectURL(adresse);
      adressen.current = [];
    };
  }, []);

  useEffect(() => {
    if (!foto || !anweisung) return undefined;
    let weg = false;

    void (async () => {
      try {
        const [bildBlob, rezeptBlob] = await Promise.all([mediaBytes(foto), mediaBytes(anweisung)]);
        if (weg) return;
        const bild = await loadImageFromBlob(bildBlob);
        if (weg) return;
        const doc = await rezeptLesen(rezeptBlob, bild.naturalWidth, bild.naturalHeight);
        if (weg) return;

        let fertig: string | null = null;
        if (doc) {
          /*
           * Auf Vorschaugrösse rechnen, nicht auf voller.
           *
           * Ein Foto von 4000 × 3000 mit drei Bereichen kostet auf dem
           * Prozessor Sekunden, und in einer Blase, die vier Zentimeter hoch
           * ist, sieht man davon nichts. Wer es gross will, tippt drauf –
           * und wer weiterbearbeitet, bekommt ohnehin das Original in den
           * Editor.
           */
          const klein = await verkleinern(bild, VORSCHAU_KANTE);
          const canvas = zeichneAusgabe(
            klein.bild,
            klein.breite,
            klein.hoehe,
            skaliert(doc, klein.faktor),
          );
          const blob = await new Promise<Blob | null>((auf) =>
            canvas.toBlob((wert) => auf(wert), 'image/webp', 0.92),
          );
          if (weg) return;
          if (blob) {
            fertig = URL.createObjectURL(blob);
            adressen.current.push(fertig);
          }
        }
        const originalAdresse = URL.createObjectURL(bildBlob);
        adressen.current.push(originalAdresse);
        setStand({
          original: bildBlob,
          doc,
          fertig,
          originalAdresse,
          breite: bild.naturalWidth,
          hoehe: bild.naturalHeight,
        });
        if (!doc) setFehler('Die Bearbeitung liess sich nicht lesen – hier steht das Original.');
      } catch (error) {
        if (weg) return;
        setFehler(errorMessage(error, 'Das Foto konnte nicht geladen werden'));
      }
    })();

    return () => {
      weg = true;
    };
  }, [foto, anweisung]);

  if (!foto) {
    return (
      <PendingMedia emoji="🧪" label="Foto wird gesendet …" message={message} isMine={isMine} />
    );
  }

  const zeigt = !stand
    ? mediaSrc(foto)
    : stand.fertig && !zeigtOriginal
      ? stand.fertig
      : stand.originalAdresse;
  const ratio = foto.width && foto.height ? `${foto.width} / ${foto.height}` : '4 / 3';

  return (
    <div className="media-bubble">
      <div className="media-frame" style={{ aspectRatio: ratio }}>
        {foto.previewDataUrl && (
          <img className="media-blur" src={foto.previewDataUrl} alt="" aria-hidden="true" />
        )}
        <img
          className="media-image is-loaded"
          src={zeigt}
          alt={foto.fileName ?? 'Foto'}
          decoding="async"
        />
      </div>

      {/*
       * Die zweite Blase.
       *
       * Sie steht auch dann da, wenn das Rechnen noch läuft – sonst springt
       * die Blase in der Höhe, sobald das Ergebnis fertig ist, und der ganze
       * Verlauf ruckt darunter weg.
       */}
      <div className="rezept-leiste">
        <span className="rezept-marke" aria-hidden="true">
          🧪
        </span>
        <div className="rezept-text">
          <strong>Bearbeitung liegt bei</strong>
          <span className="rezept-klein">
            {fehler ??
              (stand
                ? zeigtOriginal
                  ? 'Du siehst gerade das unbearbeitete Original.'
                  : 'Das Original ist mitgekommen – nichts davon ist eingerechnet.'
                : 'wird gerechnet …')}
          </span>
        </div>
        {stand?.fertig && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setZeigtOriginal((wert) => !wert)}
            aria-pressed={zeigtOriginal}
          >
            {zeigtOriginal ? 'Bearbeitet' : 'Original'}
          </button>
        )}
        {stand && (
          <button
            type="button"
            className="btn btn-sm"
            onClick={() => setBearbeitet(true)}
            disabled={sendet}
          >
            ✏️ Weiter
          </button>
        )}
      </div>

      <MediaCaption body={message.body} isMine={isMine} />

      {bearbeitet && stand && (
        <BildEditor
          quelle={stand.original}
          name={foto.fileName}
          startDoc={stand.doc}
          onClose={() => setBearbeitet(false)}
          zielName="In den Chat"
          onFertig={async (blob, dateiname) => {
            setSendet(true);
            try {
              const bild = await prepareImage(blob, MAX_KANTE, true);
              const gesendet = await sendMedia(message.conversationId, 'image', null, [
                buildAttachment({
                  kind: 'image',
                  mime: bild.mime,
                  fileName: dateiname,
                  blob: bild.blob,
                  width: bild.width,
                  height: bild.height,
                  previewDataUrl: bild.previewDataUrl,
                }),
              ]);
              if (gesendet) toast('Liegt im Chat.', 'success');
            } finally {
              setSendet(false);
            }
          }}
          onRezept={async (original, rezept, dateiname) => {
            setSendet(true);
            try {
              await rezeptSenden(message.conversationId, original, rezept, dateiname, foto);
            } finally {
              setSendet(false);
            }
          }}
        />
      )}
    </div>
  );
}

/**
 * Ein Rezept in den Chat: Bild und Anweisung als EINE Nachricht.
 *
 * Zwei Nachrichten wären der naheliegende Weg und der falsche: Sie könnten
 * einzeln ankommen, einzeln scheitern und einzeln gelöscht werden – und ein
 * Rezept ohne sein Bild ist nichts, ein Bild ohne sein Rezept eine stille
 * Lüge über das, was der Absender gesehen hat.
 */
export async function rezeptSenden(
  conversationId: string,
  original: Blob,
  rezept: Blob,
  name: string,
  masse?: { width?: number | null; height?: number | null; previewDataUrl?: string | null },
  caption?: string | null,
): Promise<boolean> {
  /*
   * Das Bild geht durch `prepareImage`, das Rezept nicht.
   *
   * Und `prepareImage` darf hier nichts umrechnen, was die Masse ändert:
   * Jeder Punkt im Rezept steht in Originalpunkten. Deshalb `MAX_KANTE` –
   * dieselbe Grenze, mit der auch der Editor arbeitet, und die Masse, die im
   * Rezept stehen, kommen aus demselben Lauf.
   */
  const bild = await prepareImage(original, MAX_KANTE, true);
  return await sendMedia(conversationId, 'rezept', caption ?? null, [
    buildAttachment({
      kind: 'image',
      mime: bild.mime,
      fileName: name,
      blob: bild.blob,
      width: bild.width,
      height: bild.height,
      previewDataUrl: bild.previewDataUrl ?? masse?.previewDataUrl ?? undefined,
    }),
    buildAttachment({
      kind: 'file',
      mime: REZEPT_MIME,
      fileName: REZEPT_DATEINAME,
      blob: rezept,
    }),
  ]);
}

/** Das Bild auf eine Arbeitsgrösse bringen – mit dem Faktor, der dabei anfiel. */
async function verkleinern(
  bild: HTMLImageElement,
  kante: number,
): Promise<{ bild: CanvasImageSource; breite: number; hoehe: number; faktor: number }> {
  const gross = Math.max(bild.naturalWidth, bild.naturalHeight);
  if (gross <= kante) {
    return { bild, breite: bild.naturalWidth, hoehe: bild.naturalHeight, faktor: 1 };
  }
  const faktor = kante / gross;
  const breite = Math.max(1, Math.round(bild.naturalWidth * faktor));
  const hoehe = Math.max(1, Math.round(bild.naturalHeight * faktor));
  const flaeche = document.createElement('canvas');
  flaeche.width = breite;
  flaeche.height = hoehe;
  const ctx = flaeche.getContext('2d');
  if (!ctx) return { bild, breite: bild.naturalWidth, hoehe: bild.naturalHeight, faktor: 1 };
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(bild, 0, 0, breite, hoehe);
  return { bild: flaeche, breite, hoehe, faktor };
}

/**
 * Dasselbe Dokument, aber in den Punkten eines kleineren Bildes.
 *
 * ALLES im Dokument steht in Originalpunkten – Zuschnitt, Verlaufsgriffe,
 * Ellipsen, Pinselzüge, Strichbreiten, Schrifthöhen. Wird das Bild verkleinert
 * und das Dokument nicht, liegt jeder davon um denselben Faktor daneben: Der
 * Zuschnitt ragte über den Rand, die Ellipse sässe unten rechts ausserhalb.
 *
 * Die Rasterfelder der Netz- und Tiefenteile bleiben, wie sie sind: Sie tragen
 * ihre eigenen Masse und werden beim Rastern ohnehin auf die Zielgrösse
 * gebracht. Ihr Bezug ist der Bildausschnitt, nicht die Punktzahl.
 */
function skaliert(doc: BildDoc, faktor: number): BildDoc {
  if (faktor === 1) return doc;
  const p = (wert: number) => wert * faktor;
  return {
    ...doc,
    zuschnitt: {
      x: p(doc.zuschnitt.x),
      y: p(doc.zuschnitt.y),
      w: p(doc.zuschnitt.w),
      h: p(doc.zuschnitt.h),
    },
    striche: doc.striche.map((s) => ({
      ...s,
      breite: p(s.breite),
      punkte: s.punkte.map(p),
      quelle: s.quelle ? { x: p(s.quelle.x), y: p(s.quelle.y) } : undefined,
    })),
    texte: doc.texte.map((t) => ({ ...t, x: p(t.x), y: p(t.y), groesse: p(t.groesse) })),
    bereiche: doc.bereiche.map((b) => ({
      ...b,
      teile: b.teile.map((teil) => {
        switch (teil.art) {
          case 'verlauf':
            return {
              ...teil,
              von: { x: p(teil.von.x), y: p(teil.von.y) },
              bis: { x: p(teil.bis.x), y: p(teil.bis.y) },
            };
          case 'radial':
            return {
              ...teil,
              mitte: { x: p(teil.mitte.x), y: p(teil.mitte.y) },
              rx: p(teil.rx),
              ry: p(teil.ry),
            };
          case 'pinsel':
            return {
              ...teil,
              striche: teil.striche.map((s) => ({
                ...s,
                breite: p(s.breite),
                punkte: s.punkte.map(p),
              })),
            };
          default:
            return teil;
        }
      }),
    })),
  };
}
