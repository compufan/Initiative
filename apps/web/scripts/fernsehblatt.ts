import { transformWithEsbuild, type Plugin } from 'vite';

/**
 * Das Fernsehblatt für ältere Fernseher absenken – und nur das Fernsehblatt.
 *
 * # Der Fehler
 *
 * `tv.ts` versprach, mit dem auszukommen, „was jeder Browser seit ungefähr
 * 2017 kann". Gebaut wurde aber die ganze App mit `target: 'es2022'`, und das
 * hat zwei Folgen, die man dem Quelltext nicht ansieht:
 *
 *   * **Der Verkleinerer schreibt NEUERE Schreibweisen hinein, als dastehen.**
 *     esbuild macht bei diesem Ziel aus `a != null ? a : b` ein `a ?? b`, aus
 *     `a == null ? void 0 : a.b` ein `a?.b` und aus `catch (e) {}` ein
 *     `catch {}` – nachgemessen. Ein Blatt, das von Hand ohne `??` geschrieben
 *     ist, trägt es nach dem Bau trotzdem. `??` kennt Chromium erst ab 80.
 *   * **Im Stilblatt dasselbe:** Vier Zeilen `top/right/bottom/left: 0` werden
 *     zu `inset: 0` (Chromium 87). Ein Samsung von 2021 (Chromium 76) verwirft
 *     das, und die Bühne hat die Grösse null.
 *
 * Samsung-Fernseher von 2019 bis 2022 (Tizen 5 bis 6.5, Chromium 63 bis 85)
 * und LG webOS 5 und 6 (Chromium 68 und 79) blieben damit beim „…" stehen oder
 * zeigten nichts.
 *
 * # Warum nicht einfach die ganze App tiefer bauen
 *
 * `build.target` gilt für alle Einstiegspunkte zugleich – ein eigenes Ziel je
 * Eintrag kennt Vite nicht. Die App tiefer zu bauen hiesse, auch ONNX Runtime,
 * MediaPipe und jedes eigene Modul durch die Absenkung zu schicken: Klassen
 * mit privaten Feldern würden zu WeakMap-Gerüsten, jede Zeile mit `?.` länger,
 * und was sich gar nicht absenken lässt (BigInt, `await` auf oberster Ebene)
 * bräche den Bau – für Telefone, die das alles längst können. Das Risiko läge
 * bei der App, der Nutzen allein beim Fernseher.
 *
 * Ein zweiter, eigener Bau nur für `tv.html` wäre die andere Möglichkeit. Er
 * bräuchte ein zweites Konfigurationsstück, einen zweiten Aufruf im
 * Dockerfile und in `package.json` und müsste sich mit dem Service Worker den
 * Ausgabeordner teilen. Das sind drei Stellen, die auseinanderlaufen können.
 *
 * # Was stattdessen geschieht
 *
 * Dieses Stück hängt sich an das ENDE des Baus: Nachdem Vite alles für
 * ES2022 verkleinert hat, geht es über genau die Stücke, die das Fernsehblatt
 * lädt – den Einstieg `tv` und was er importiert –, und senkt sie mit
 * derselben esbuild-Fassung auf `chrome63` ab. Dasselbe mit dem Stilblatt
 * dieses Einstiegs. Die App selbst bleibt Byte für Byte, wie sie war; ein
 * geteiltes Stück wie `mischen.ts` wird für beide abgesenkt, und das schadet
 * einem neuen Browser nicht.
 *
 * Was sich so NICHT nachrüsten lässt, sind fehlende Methoden (`replaceChildren`,
 * `Promise.finally`). Die sind im Blatt von Hand vermieden – siehe
 * `src/tv/chat.ts`, `leeren`.
 *
 * # Warum `chrome63`
 *
 * Darunter lädt das Blatt ohnehin nicht: `<script type="module">` gibt es ab
 * Chromium 61, und `import()`, das Vite für nachgeladene Stücke benutzt, ab
 * 63. Samsung 2019 (Tizen 5.0) hat genau 63. Noch ältere Geräte (Samsung 2018
 * mit Chromium 56, LG webOS 4 mit 53) kennen Modulskripte gar nicht; für sie
 * bliebe nur ein zweiter Bau als klassisches Skript, und den gibt es nicht.
 * Das steht so auch in `docs/FEATURES.md`.
 */
export const FERNSEH_ZIEL = 'chrome63';

/** Der Name des Einstiegs in `vite.config.ts` (`rollupOptions.input.tv`). */
const EINSTIEG = 'tv';

interface StueckKopf {
  isEntry: boolean;
  name: string;
  imports: readonly string[];
}

/** Alle Stücke, die der Einstieg lädt – er selbst und seine Importe, rekursiv. */
export function stueckeDesBlatts(
  alle: Record<string, StueckKopf>,
  einstieg = EINSTIEG,
): Set<string> {
  const raus = new Set<string>();
  const offen = Object.keys(alle).filter(
    (name) => alle[name].isEntry && alle[name].name === einstieg,
  );
  while (offen.length > 0) {
    const name = offen.pop()!;
    if (raus.has(name)) continue;
    raus.add(name);
    for (const weiter of alle[name]?.imports ?? []) offen.push(weiter);
  }
  return raus;
}

/** Ein Stück JavaScript für den Fernseher absenken. */
export async function fernsehSkriptSenken(code: string, name: string) {
  const ergebnis = await transformWithEsbuild(code, name, {
    target: FERNSEH_ZIEL,
    format: 'esm',
    minify: true,
    sourcemap: true,
  });
  // Als Text: Rollup nimmt beides, und esbuilds Kartenobjekt passt nicht
  // Feld für Feld zu Rollups Typ (`sourcesContent` darf dort kein `null` sein).
  return { code: ergebnis.code, map: JSON.stringify(ergebnis.map) };
}

/** Ein Stilblatt für den Fernseher absenken. */
export async function fernsehStilSenken(css: string, name: string): Promise<string> {
  const ergebnis = await transformWithEsbuild(css, name, {
    loader: 'css',
    target: FERNSEH_ZIEL,
    minify: true,
  });
  return ergebnis.code;
}

export function fernsehblattFuerAlteGeraete(): Plugin {
  return {
    name: 'initiative:fernsehblatt-alte-geraete',
    apply: 'build',
    /*
     * `order: 'post'`: NACH der Verkleinerung von Vite. Davor liefe die
     * Absenkung ins Leere – der Verkleinerer schriebe `??` & Co. hinterher
     * wieder hinein. Die Quellkarte, die hier zurückgeht, verkettet Rollup
     * mit der vorigen; die Zeilen im Browser zeigen weiter auf `tv.ts`.
     */
    renderChunk: {
      order: 'post',
      async handler(code, chunk, _optionen, meta) {
        const blatt = stueckeDesBlatts(meta.chunks as Record<string, StueckKopf>);
        if (!blatt.has(chunk.fileName)) return null;
        return fernsehSkriptSenken(code, chunk.fileName);
      },
    },
    /*
     * Das Stilblatt steht erst hier fertig im Bündel: Vite sammelt es beim
     * Zerlegen und legt es danach als eigene Datei ab. Welche es ist, weiss
     * das Einstiegsstück (`viteMetadata.importedCss`).
     */
    generateBundle: {
      order: 'post',
      async handler(_optionen, buendel) {
        for (const datei of Object.values(buendel)) {
          if (datei.type !== 'chunk' || !datei.isEntry || datei.name !== EINSTIEG) continue;
          const stile = datei.viteMetadata?.importedCss ?? new Set<string>();
          for (const name of stile) {
            const blatt = buendel[name];
            if (!blatt || blatt.type !== 'asset') continue;
            blatt.source = await fernsehStilSenken(String(blatt.source), name);
          }
        }
      },
    },
  };
}
