/**
 * Die Teilbilder eines bewegten Bildes einzeln herausholen.
 *
 * # Warum das gebraucht wird
 *
 * Ein bewegtes GIF blieb bisher nur dann bewegt, wenn es UNBERÜHRT
 * durchgereicht wurde. Sobald jemand etwas daran machte – und dafür geht man
 * ins Studio –, wurde ein Standbild daraus: Eine Leinwand nimmt genau ein
 * Teilbild auf. Um das zu ändern, müssen erst einmal alle Teilbilder da sein.
 *
 * # Womit
 *
 * `ImageDecoder` aus den WebCodecs. Der Browser hat den Entschlüssler für GIF
 * und bewegtes WebP ohnehin – er zeigt solche Bilder ja an –, und diese
 * Schnittstelle gibt ihn heraus, statt ihn hinter `<img>` zu verstecken.
 *
 * Das ist der einzige Weg ohne eigenen Entschlüssler. Die Alternative wäre,
 * GIF und WebP von Hand zu lesen: LZW auspacken, Teilbilder übereinander
 * legen, Entsorgungsarten beachten – für WebP dazu VP8L. Das sind tausend
 * Zeilen und ein Angriffspunkt bei jedem fremden Bild.
 *
 * # Wo es das nicht gibt
 *
 * `ImageDecoder` ist nicht überall da. Dann gibt es hier `null` zurück, und
 * der Aufrufer macht, was er vorher auch tat: das bewegte Bild unverändert
 * durchreichen oder ein Standbild daraus machen. Das ist kein Rückschritt,
 * sondern der Zustand von vorher.
 */

/** Ein Teilbild mit seiner Standzeit. */
export interface GelesenesBild {
  /** Das Teilbild – womöglich kleiner als in der Datei, siehe `massstab`. */
  bild: ImageBitmap;
  /**
   * Die Grösse des Teilbilds IN DER DATEI. Darauf beziehen sich die
   * Koordinaten im Sticker-Dokument (Striche, Masken, Lage), nicht auf die
   * Grösse von `bild`.
   */
  breite: number;
  hoehe: number;
  dauerMs: number;
}

/**
 * Wie klein ein Teilbild entpackt werden darf: Zielpunkte je Bildpunkt der
 * Datei (0 … 1), aus dessen Grösse. Fehlt sie, bleibt die Originalgrösse.
 */
export type Massstab = (breite: number, hoehe: number) => number;

interface DecoderKlasse {
  new (init: { data: ArrayBuffer | Uint8Array; type: string }): DecoderInstanz;
  isTypeSupported?: (typ: string) => Promise<boolean>;
}

interface DecoderInstanz {
  completed: Promise<void>;
  tracks: {
    ready: Promise<void>;
    selectedTrack?: { frameCount: number; animated: boolean } | null;
  };
  decode(optionen: { frameIndex: number }): Promise<{
    image: {
      duration?: number | null;
      displayWidth?: number;
      displayHeight?: number;
      close?: () => void;
    } & CanvasImageSource;
  }>;
  close(): void;
}

/** Kann dieses Gerät bewegte Bilder auseinandernehmen? */
export function lesenMoeglich(): boolean {
  return typeof (globalThis as { ImageDecoder?: unknown }).ImageDecoder !== 'undefined';
}

/**
 * Wie viele Teilbilder höchstens gelesen werden.
 *
 * Ein GIF kann hunderte haben. Jedes davon würde hinterher durch die ganze
 * Stickerkette gerechnet und landete im Ergebnis – bei fünfhundert Teilbildern
 * wären das Minuten Rechenzeit für eine Datei, die niemand verschicken kann.
 * Vierzig sind bei zehn Bildern je Sekunde vier Sekunden Bewegung, und das
 * ist mehr, als ein Sticker braucht.
 */
export const TEILBILDER_MAX = 40;

/**
 * Die Teilbilder einer Datei, eines nach dem anderen.
 *
 * WARUM einzeln: Vierzig Teilbilder eines GIF von 4000 × 4000 Punkten sind als
 * Bitmaps 2,5 GB – auf einem Telefon ist der Reiter weg, bevor das erste
 * gezeichnet wird. Wer ein Teilbild nach dem anderen holt, verarbeitet und
 * schliesst, hält höchstens eines; mit `massstab` ist auch das nur so gross,
 * wie die Sticker-Fläche es braucht.
 *
 * Jedes gelieferte `bild` gehört dem Aufrufer, er schliesst es. Bricht er ab
 * (`break`, Wurf), schliesst die Folge den Entschlüssler selbst.
 *
 * Liefert gar nichts, wenn es hier nicht geht oder die Datei weniger als zwei
 * Teilbilder hat. Scheitert ein Teilbild mittendrin, wirft sie.
 */
export async function* teilbilderFolge(
  datei: Blob,
  typ: string,
  massstab?: Massstab,
): AsyncGenerator<GelesenesBild, void, void> {
  const Decoder = (globalThis as { ImageDecoder?: DecoderKlasse }).ImageDecoder;
  if (!Decoder) return;
  if (Decoder.isTypeSupported && !(await Decoder.isTypeSupported(typ))) return;
  const decoder = new Decoder({ data: await datei.arrayBuffer(), type: typ });
  try {
    await decoder.tracks.ready;
    /*
     * Auf `completed` warten, bevor gezählt wird.
     *
     * `frameCount` wächst, während der Browser liest. Wer sofort fragt,
     * bekommt oft eine Eins – und schneidet damit ein Bild von dreissig
     * Teilbildern auf eines zusammen, ohne dass irgendwo ein Fehler
     * auftaucht.
     */
    await decoder.completed;
    const spur = decoder.tracks.selectedTrack;
    const anzahl = Math.min(TEILBILDER_MAX, spur?.frameCount ?? 0);
    if (anzahl < 2) return;

    for (let i = 0; i < anzahl; i += 1) {
      const { image } = await decoder.decode({ frameIndex: i });
      let gelesen: GelesenesBild;
      try {
        /*
         * `duration` steht in MIKROsekunden. In Millisekunden gelesen liefe
         * ein Sticker tausendmal zu schnell, und das sähe aus wie ein
         * Flackern, nicht wie ein Fehler in einer Einheit.
         */
        const dauerMs = image.duration != null ? image.duration / 1000 : 100;
        const masse = image as {
          displayWidth?: number;
          displayHeight?: number;
          width?: number;
          height?: number;
        };
        const breite = masse.displayWidth ?? masse.width ?? 0;
        const hoehe = masse.displayHeight ?? masse.height ?? 0;
        const m = massstab && breite > 0 && hoehe > 0 ? massstab(breite, hoehe) : 1;
        const bild =
          m > 0 && m < 1
            ? await createImageBitmap(image, {
                resizeWidth: Math.max(1, Math.ceil(breite * m)),
                resizeHeight: Math.max(1, Math.ceil(hoehe * m)),
                resizeQuality: 'high',
              })
            : await createImageBitmap(image);
        gelesen = {
          bild,
          breite: breite || bild.width,
          hoehe: hoehe || bild.height,
          dauerMs: dauerMs > 0 ? dauerMs : 100,
        };
      } finally {
        // Auch wenn `createImageBitmap` wirft: Ein offenes `VideoFrame`
        // hält Decoderspeicher, an den der Einsammler nicht herankommt.
        image.close?.();
      }
      yield gelesen;
    }
  } finally {
    decoder.close();
  }
}

/**
 * Alle Teilbilder einer Datei auf einmal – oder `null`, wenn es hier nicht geht.
 *
 * Wirft nicht: Ein bewegtes Bild, das sich nicht auseinandernehmen lässt, ist
 * ein Standbild mehr und kein Fehler. Der Aufrufer sieht `null` und geht den
 * Weg, den er vorher ging. Hält alle Bitmaps zugleich – wer sie nur
 * nacheinander braucht, nimmt `teilbilderFolge`.
 */
export async function teilbilderLesen(
  datei: Blob,
  typ: string,
  massstab?: Massstab,
): Promise<GelesenesBild[] | null> {
  const raus: GelesenesBild[] = [];
  try {
    for await (const gelesen of teilbilderFolge(datei, typ, massstab)) raus.push(gelesen);
  } catch {
    // Scheitert Teilbild zwölf, sind elf schon entpackt – und mit `null`
    // erfährt der Aufrufer nie von ihnen. Also hier freigeben.
    for (const { bild } of raus) bild.close();
    return null;
  }
  return raus.length >= 2 ? raus : null;
}
