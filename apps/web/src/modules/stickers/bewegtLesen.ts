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
  bild: ImageBitmap;
  dauerMs: number;
}

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
    image: { duration?: number | null; close?: () => void } & CanvasImageSource;
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
 * Die Teilbilder einer Datei – oder `null`, wenn es hier nicht geht.
 *
 * Wirft nicht: Ein bewegtes Bild, das sich nicht auseinandernehmen lässt, ist
 * ein Standbild mehr und kein Fehler. Der Aufrufer sieht `null` und geht den
 * Weg, den er vorher ging.
 */
export async function teilbilderLesen(datei: Blob, typ: string): Promise<GelesenesBild[] | null> {
  const Decoder = (globalThis as { ImageDecoder?: DecoderKlasse }).ImageDecoder;
  if (!Decoder) return null;
  try {
    if (Decoder.isTypeSupported && !(await Decoder.isTypeSupported(typ))) return null;
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
      if (anzahl < 2) return null;

      const raus: GelesenesBild[] = [];
      for (let i = 0; i < anzahl; i += 1) {
        const { image } = await decoder.decode({ frameIndex: i });
        /*
         * `duration` steht in MIKROsekunden. In Millisekunden gelesen liefe
         * ein Sticker tausendmal zu schnell, und das sähe aus wie ein
         * Flackern, nicht wie ein Fehler in einer Einheit.
         */
        const dauerMs = image.duration != null ? image.duration / 1000 : 100;
        const bild = await createImageBitmap(image);
        image.close?.();
        raus.push({ bild, dauerMs: dauerMs > 0 ? dauerMs : 100 });
      }
      return raus;
    } finally {
      decoder.close();
    }
  } catch {
    return null;
  }
}
