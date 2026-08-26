/**
 * Holt die Bausteine fuer das Freistellen ins `public/`-Verzeichnis.
 *
 * Warum ein Skript und nicht einfach im Git ablegen: die WASM-Laufzeit von
 * MediaPipe ist rund 22 MB, die Modelle noch einmal ein halbes. Das gehoert
 * nicht in die Versionsverwaltung – jedes `git clone` waere sonst dauerhaft
 * belastet. Stattdessen laeuft dieses Skript vor jedem Build (auch bei
 * Vercel) und legt die Dateien frisch ab.
 *
 * Nichts davon landet im JavaScript-Bundle. Die App laedt eine Datei erst,
 * wenn jemand das jeweilige Verfahren zum ersten Mal benutzt.
 */
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, copyFile, readFile, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const publicDir = join(hier, '..', 'public');
const require = createRequire(import.meta.url);

/** Die WASM-Laufzeit von MediaPipe. Beide Varianten: mit und ohne SIMD. */
const WASM_DATEIEN = [
  'vision_wasm_internal.js',
  'vision_wasm_internal.wasm',
  // Ohne diese beiden scheitert der Start auf iOS vor 16.4: MediaPipe fragt
  // die "nosimd"-Namen an, bekommt 404 und bricht ab.
  'vision_wasm_nosimd_internal.js',
  'vision_wasm_nosimd_internal.wasm',
];

/**
 * Die Modelle. Feste Versionsnummer statt "latest", damit ein Build von
 * heute dieselben Dateien bekommt wie einer von naechster Woche.
 */
const MODELLE = [
  {
    name: 'selfie-segmenter.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/image_segmenter/selfie_segmenter/float16/1/selfie_segmenter.tflite',
    mindestGroesse: 200_000,
  },
  {
    name: 'blaze-face-short-range.tflite',
    url: 'https://storage.googleapis.com/mediapipe-models/face_detector/blaze_face_short_range/float16/1/blaze_face_short_range.tflite',
    mindestGroesse: 150_000,
  },
  {
    // U^2-Net, kleine Fassung. Apache-2.0 (github.com/xuebinqin/U-2-Net).
    // Bewusst NICHT RMBG-1.4 oder @imgly/background-removal: das eine ist
    // ausdruecklich nicht fuer kommerzielle Nutzung freigegeben, das andere
    // steht unter AGPL – bei einer ausgelieferten Web-App hiesse das, den
    // gesamten Quelltext offenlegen zu muessen.
    name: 'u2netp.onnx',
    url: 'https://github.com/danielgatis/rembg/releases/download/v0.0.0/u2netp.onnx',
    mindestGroesse: 4_000_000,
  },
  {
    // BiRefNet-lite, 1024er-Fassung, halbe Genauigkeit. MIT-Lizenz, wie das
    // Grundmodell ZhengPeng7/BiRefNet_lite. Deutlich sauberere Kanten als
    // U^2-Net – Haare, Zaeune, Brillenbuegel –, dafuer der groesste Download
    // der App und spuerbar mehr Rechenzeit. Deshalb ein *zusaetzliches*
    // Verfahren und kein Ersatz, von Haus aus abgeschaltet.
    //
    // Feste Fassung ueber den Commit statt `main`: Ein Build von heute soll
    // dieselbe Datei bekommen wie einer von naechster Woche.
    //
    // # Warum die 1024er Fassung
    //
    // Dasselbe Netz mit doppelter Kantenlänge, also vierfacher Fläche.
    // Gemessen an einem Haarausschnitt trägt die 1024er Maske 30 % mehr
    // Struktur; einzelne Strähnen stehen dort als dünne Linien, wo die 512er
    // einen weichen Wulst zeigt. Die waren nicht schlecht hochgerechnet –
    // sie sind nie berechnet worden.
    //
    // Der Preis: rund 15 MB mehr Download und etwa die dreieinhalbfache
    // Rechenzeit. Wem das zu lang dauert, stellt hier wieder auf
    // `studioludens/birefnet-lite-512` um und setzt EINGABE in
    // engines/birefnet.ts zurück auf 512 – mehr ist es nicht.
    name: 'birefnet-lite-1024.onnx',
    url: 'https://huggingface.co/onnx-community/BiRefNet_lite-ONNX/resolve/de15b22ba131738a16dff04aab8bdf8dc32e3ac1/onnx/model_fp16.onnx',
    mindestGroesse: 110_000_000,
    sha256: 'd39b897ceb16ae654c1731f3dba0cf9b368d9cae74b5a57459b455cc8bfec402',
    // Ein fremder Server, der gerade nicht erreichbar ist, darf keine
    // Veroeffentlichung verhindern. Fehlt die Datei, meldet die App das
    // Verfahren schlicht als nicht verfuegbar.
    optional: true,
  },
  {
    // NanoSAM: punktgefuehrtes Segmentieren. Apache-2.0 durchgehend – die
    // ONNX-Fassung dragonSwing/nanosam, deren Vorlage binh234/nanosam und
    // NVIDIA-AI-IOT/nanosam, der Decoder aus MobileSAM bzw. Segment Anything.
    //
    // ACHTUNG beim Nachziehen: Im selben Repo liegt unter `op11/` ein fast
    // gleich benannter zweiter Satz OHNE `_ln_`, und die Download-Verweise im
    // README zeigen fuer B2 und B4 beide auf die B1-Datei. Deshalb feste
    // Namen und Pruefsummen statt irgendeinem Verweis zu folgen.
    name: 'nanosam-encoder.onnx',
    url: 'https://huggingface.co/dragonSwing/nanosam/resolve/e49afdaee2078a826f542929996a14fb0b69a2fa/sam_hgv2_b1_ln_nonorm_image_encoder.onnx',
    mindestGroesse: 12_000_000,
    sha256: '0001b3349220a86ff6a41819ebdfd9f2a8c0707a90ef3e4f9726d46db09a9a32',
    optional: true,
  },
  {
    name: 'nanosam-decoder.onnx',
    url: 'https://huggingface.co/dragonSwing/nanosam/resolve/e49afdaee2078a826f542929996a14fb0b69a2fa/mobile_sam_mask_decoder.onnx',
    mindestGroesse: 16_000_000,
    sha256: '41e49a298099048186ce109a4518286b8972959898a02577414405efa5c3b247',
    optional: true,
  },
];

async function vorhanden(pfad, mindestGroesse = 1) {
  try {
    return (await stat(pfad)).size >= mindestGroesse;
  } catch {
    return false;
  }
}

async function wasmKopieren() {
  // `package.json` steht nicht in den "exports" des Pakets – deshalb ueber
  // den Haupteinstieg gehen und dessen Verzeichnis nehmen.
  const quelle = dirname(require.resolve('@mediapipe/tasks-vision'));
  const ziel = join(publicDir, 'mediapipe');
  await mkdir(ziel, { recursive: true });
  for (const datei of WASM_DATEIEN) {
    await copyFile(join(quelle, 'wasm', datei), join(ziel, datei));
  }
  console.log(`  MediaPipe-Laufzeit: ${WASM_DATEIEN.length} Dateien nach public/mediapipe/`);
}

/**
 * Laedt eine Datei auf die Platte und rechnet dabei ihre Pruefsumme mit.
 *
 * Nicht ueber `arrayBuffer()`: Das groesste Modell ist knapp 94 MB, und die
 * komplett in den Speicher zu ziehen, nur um sie gleich wieder wegzuschreiben,
 * ist unnoetig – auf einem kleinen Bauknecht kann es sogar schiefgehen.
 */
async function laden(url, pfad) {
  const antwort = await fetch(url);
  if (!antwort.ok || !antwort.body) throw new Error(`HTTP ${antwort.status} von ${url}`);
  const hash = createHash('sha256');
  const strom = Readable.fromWeb(antwort.body);
  strom.on('data', (stueck) => hash.update(stueck));
  await pipeline(strom, createWriteStream(pfad));
  return hash.digest('hex');
}

async function pruefsummeVon(pfad) {
  // Nur fuer die kleinen Dateien beim erneuten Pruefen – die grosse traegt
  // ihre Summe schon vom Laden her.
  return createHash('sha256')
    .update(await readFile(pfad))
    .digest('hex');
}

/**
 * Eine `.gz`-Fassung neben die Datei legen.
 *
 * # Warum das noetig ist
 *
 * Caddy komprimiert unterwegs, aber nur, was es fuer komprimierbar haelt –
 * und die Liste geht nach dem Inhaltstyp. `.wasm` steht darauf (nachgemessen:
 * `content-encoding: gzip`), `.onnx` kennt es nicht und liefert es als
 * `application/octet-stream` roh aus.
 *
 * Bei einem 109-MiB-Modell sind das 31 MiB, die jeder ueber Mobilfunk
 * umsonst zieht: gzip drueckt die Datei auf 78 MiB.
 *
 * Warum vorkomprimiert und nicht unterwegs: 109 MiB bei jedem ersten Abruf
 * zu packen kostet den Server Sekunden an Rechenzeit. Einmal beim Bauen
 * kostet es nichts, und `file_server { precompressed gzip }` reicht die
 * fertige Datei einfach durch.
 *
 * Fehlschlagen darf das: Ohne `.gz` liefert Caddy die Rohfassung aus. Das ist
 * langsamer, aber nicht kaputt.
 */
async function vorkomprimieren(pfad, groesse) {
  // Unter einem Megabyte lohnt der Aufwand nicht – und die tflite-Dateien
  // von MediaPipe sind ohnehin schon dicht gepackt.
  if (groesse < 1024 * 1024) return;
  try {
    await pipeline(createReadStream(pfad), createGzip({ level: 9 }), createWriteStream(`${pfad}.gz`));
    const klein = (await stat(`${pfad}.gz`)).size;
    console.log(
      `    vorkomprimiert: ${(klein / 1024 / 1024).toFixed(1)} MB` +
        ` (${Math.round((1 - klein / groesse) * 100)} % weniger)`,
    );
  } catch (fehler) {
    console.warn(`    nicht vorkomprimierbar (${fehler.message}) – wird roh ausgeliefert`);
  }
}

async function modelleLaden() {
  const ziel = join(publicDir, 'models');
  await mkdir(ziel, { recursive: true });
  const uebersprungen = [];
  for (const modell of MODELLE) {
    const pfad = join(ziel, modell.name);
    try {
      if (await vorhanden(pfad, modell.mindestGroesse)) {
        // Eine vorhandene Datei nur dann noch einmal pruefen, wenn wir wissen,
        // wie sie aussehen soll – sonst vertrauen wir wie bisher der Groesse.
        if (modell.sha256 && (await pruefsummeVon(pfad)) !== modell.sha256) {
          console.warn(`  ${modell.name}: Pruefsumme passt nicht, wird neu geladen`);
          await rm(pfad, { force: true });
        } else {
          console.log(`  ${modell.name}: schon da`);
          // Die Datei liegt, die `.gz` vielleicht nicht – etwa nach einem
          // Wechsel auf einen Stand, der sie noch nicht kannte.
          if (!(await vorhanden(`${pfad}.gz`))) {
            await vorkomprimieren(pfad, (await stat(pfad)).size);
          }
          continue;
        }
      }

      const summe = await laden(modell.url, pfad);
      const groesse = (await stat(pfad)).size;
      if (groesse < modell.mindestGroesse) {
        // Ein Fehlerbild oder eine HTML-Seite statt des Modells – lieber laut
        // scheitern als eine kaputte Datei ausliefern.
        await rm(pfad, { force: true });
        throw new Error(`nur ${groesse} Bytes erhalten, das kann nicht stimmen`);
      }
      if (modell.sha256 && summe !== modell.sha256) {
        await rm(pfad, { force: true });
        throw new Error(`Pruefsumme ${summe} statt ${modell.sha256}`);
      }
      console.log(`  ${modell.name}: ${(groesse / 1024 / 1024).toFixed(1)} MB geladen`);
      await vorkomprimieren(pfad, groesse);
    } catch (fehler) {
      if (!modell.optional) throw new Error(`${modell.name}: ${fehler.message}`);
      uebersprungen.push(`${modell.name} (${fehler.message})`);
    }
  }
  for (const eintrag of uebersprungen) {
    console.warn(`  Uebersprungen: ${eintrag}`);
    console.warn('  Dieses Verfahren steht in dieser Fassung der App nicht zur Verfuegung.');
  }
}

/**
 * Mit `--optional` ist ein Fehlschlag kein Abbruch.
 *
 * Beim Entwickeln und in den Browser-Tests wird das Freistellen nicht
 * gebraucht; ohne Netz sollte trotzdem `pnpm dev` starten. Beim Bauen fuer
 * die Veroeffentlichung gilt das NICHT – dort waeren fehlende Modelle ein
 * stiller 404 in der fertigen App.
 */
const optional = process.argv.includes('--optional');

console.log('Freistell-Bausteine bereitlegen …');
try {
  await wasmKopieren();
  await modelleLaden();
  console.log('Fertig.');
} catch (fehler) {
  if (!optional) throw fehler;
  console.warn(`  Uebersprungen: ${fehler.message}`);
  console.warn('  Das Freistellen mit Modellen steht in dieser Sitzung nicht zur Verfuegung.');
}
