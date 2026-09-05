/**
 * Stellt die Liste der fremden Bestandteile zusammen – für die Seite
 * „Verwendete Software“ in der App.
 *
 * # Warum erzeugt und nicht von Hand gepflegt
 *
 * Weil eine von Hand gepflegte Liste nach dem dritten `pnpm add` nicht mehr
 * stimmt, und eine falsche Nennung schlechter ist als gar keine: Sie erweckt
 * den Anschein, geprüft worden zu sein. Dieses Skript liest die Lizenzen
 * dort, wo sie stehen – in der `package.json` jedes Pakets und in seiner
 * LICENSE-Datei – und die Modelle aus `prepare-models.mjs`, der einzigen
 * Stelle, an der ihre Herkunft steht.
 *
 * # Warum trotzdem eine Handliste dabei ist
 *
 * Weil ein Teil der fremden Arbeit gar nicht als npm-Paket ankommt, sondern
 * fest einkompiliert in zwei WASM-Dateien von zusammen 50 MB: Eigen, die
 * Emscripten-Laufzeit, Protobuf, XNNPACK. Kein Werkzeug findet sie, weil es
 * dort keine Paketgrenzen mehr gibt – man sieht sie nur an den übrig
 * gebliebenen C++-Symbolen. Was hier steht, ist an genau diesen Symbolen
 * nachgewiesen; der Beleg steht je Eintrag dabei.
 *
 * Aufruf: `pnpm lizenzen`. Läuft ausserdem vor jedem Bauen.
 */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { MODELLE } from './prepare-models.mjs';

const hier = dirname(fileURLToPath(import.meta.url));
const webDir = join(hier, '..');
const wurzel = join(webDir, '..', '..');
const ZIEL = join(webDir, 'public', 'lizenzen.json');

/**
 * Was in den beiden WASM-Dateien steckt, ohne je ein Paket gewesen zu sein.
 *
 * Jeder Eintrag ist am Binärbestand nachgewiesen, nicht aus einer
 * Abhängigkeitsliste abgeschrieben. Der Beleg steht dabei, damit man es
 * nachprüfen kann, statt es glauben zu müssen.
 */
const EINGEBAUT = [
  {
    name: 'Eigen',
    lizenz: 'MPL-2.0',
    urheber: 'Benoît Jacob, Gaël Guennebaud u. a.',
    quelle: 'https://eigen.tuxfamily.org/',
    teil: 'wasm',
    beleg:
      'C++-Symbole EigenForTFLite in vision_wasm_internal.wasm sowie Eigen::half und EigenNonBlockingThreadPool in ort-wasm-simd-threaded.wasm.',
    hinweis:
      'Dateibezogenes Copyleft: Wer eine Eigen-Datei ändert, muss diese Datei quelloffen halten. Wir ändern nichts an Eigen – es kommt fertig einkompiliert in den WASM-Dateien an.',
  },
  {
    name: 'Emscripten',
    lizenz: 'MIT',
    urheber: 'Emscripten-Autoren',
    quelle: 'https://github.com/emscripten-core/emscripten',
    teil: 'wasm',
    beleg:
      'Der Klebecode vision_wasm_internal.js und ort-wasm-simd-threaded.mjs ist von Emscripten erzeugt (Symbole EmscriptenEH, EmscriptenSjLj).',
    hinweis:
      'Emscripten steht wahlweise unter MIT oder der NCSA-Lizenz der University of Illinois. Hier steht der MIT-Text.',
  },
  {
    name: 'Protocol Buffers (C++)',
    lizenz: 'BSD-3-Clause',
    urheber: 'Google LLC',
    quelle: 'https://github.com/protocolbuffers/protobuf',
    teil: 'wasm',
    beleg:
      'Beide Laufzeiten lesen ihre Modellformate über Protobuf; Symbole google::protobuf im WASM.',
  },
  {
    name: 'XNNPACK',
    lizenz: 'BSD-3-Clause',
    urheber: 'Google LLC / Facebook Inc. / Georgia Tech',
    quelle: 'https://github.com/google/XNNPACK',
    teil: 'wasm',
    beleg: 'Rechenkerne von TensorFlow Lite in der MediaPipe-Laufzeit.',
  },
  {
    name: 'TensorFlow Lite',
    lizenz: 'Apache-2.0',
    urheber: 'The TensorFlow Authors',
    quelle: 'https://github.com/tensorflow/tensorflow',
    teil: 'wasm',
    beleg:
      'MediaPipe führt seine .tflite-Modelle mit TensorFlow Lite aus; Symbole tflite:: im WASM.',
  },
];

/**
 * Die Lizenztexte, entdoppelt.
 *
 * Die MIT-Lizenz verlangt nicht nur den Namen des Rechteinhabers, sondern
 * ausdrücklich, dass „this permission notice“ mitgeliefert wird – der Text
 * selbst. Vierhundert Texte einzeln abzulegen wäre eine Megabyte-Datei;
 * dabei sind es fast immer dieselben paar Texte mit einer anderen
 * Copyright-Zeile. Also: jeder Text einmal, jeder Eintrag verweist darauf.
 */
const texte = new Map();

function textMerken(inhalt) {
  const kennung = createHash('sha256').update(inhalt).digest('hex').slice(0, 12);
  if (!texte.has(kennung)) texte.set(kennung, inhalt);
  return kennung;
}

/** Copyright-Zeilen und Lizenztext eines Pakets. */
async function lizenzAus(ordner) {
  for (const name of ['LICENSE', 'LICENSE.md', 'LICENCE', 'LICENSE.txt', 'COPYING', 'NOTICE']) {
    const pfad = join(ordner, name);
    if (!existsSync(pfad)) continue;
    const text = await readFile(pfad, 'utf8');
    // ALLE Copyright-Zeilen, nicht nur die erste: react-router nennt drei
    // Rechteinhaber, und die MIT-Lizenz verlangt den Vermerk vollstaendig.
    const zeilen = text
      .split('\n')
      .map((zeile) => zeile.trim())
      .filter((zeile) => /^copyright/i.test(zeile));
    return { urheber: zeilen.join(' · '), textId: textMerken(text.trim()) };
  }
  return { urheber: '', textId: undefined };
}

/** Die Pakete, die im Browser ankommen. */
async function npmPakete() {
  const roh = execFileSync('pnpm', ['ls', '--prod', '--depth', 'Infinity', '--json'], {
    cwd: webDir,
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const baum = JSON.parse(roh);
  const gesehen = new Map();

  const gehen = async (knoten) => {
    for (const [name, wert] of Object.entries(knoten ?? {})) {
      if (!wert || typeof wert !== 'object') continue;
      const schluessel = `${name}@${wert.version}`;
      if (gesehen.has(schluessel)) continue;
      gesehen.set(schluessel, true);
      if (wert.path && !name.startsWith('@initiative/')) {
        try {
          const paket = JSON.parse(await readFile(join(wert.path, 'package.json'), 'utf8'));
          eintraege.push({
            name,
            version: wert.version,
            lizenz:
              typeof paket.license === 'string'
                ? paket.license
                : (paket.license?.type ?? 'unbekannt'),
            ...(await lizenzAus(wert.path)),
            quelle:
              paket.homepage ?? paket.repository?.url ?? `https://www.npmjs.com/package/${name}`,
            teil: 'web',
          });
        } catch {
          /* Paket ohne lesbare package.json – kommt bei Verweisen vor */
        }
      }
      await gehen(wert.dependencies);
    }
  };

  const eintraege = [];
  for (const wurzelKnoten of baum) {
    await gehen(wurzelKnoten.dependencies);
  }
  return eintraege;
}

/**
 * Vier Pakete, die als „devDependency“ geführt werden und trotzdem beim
 * Nutzer ankommen – deshalb stehen sie hier von Hand.
 *
 * `vite-plugin-pwa` spielt über `virtual:pwa-register` Laufzeitcode ein
 * (src/main.tsx), `workbox-precaching` steckt im Service Worker (src/sw.ts),
 * `workbox-window` liegt als eigene Datei im Auslieferungsstand, und von
 * `vite` selbst kommt der modulepreload-Notbehelf mit. Ein Werkzeug, das nur
 * `dependencies` liest, übersieht alle vier.
 */
const AUSGELIEFERTE_WERKZEUGE = ['vite', 'vite-plugin-pwa', 'workbox-precaching', 'workbox-window'];

async function werkzeugPakete() {
  const paket = JSON.parse(await readFile(join(webDir, 'package.json'), 'utf8'));
  const eintraege = [];
  for (const name of AUSGELIEFERTE_WERKZEUGE) {
    const version = paket.devDependencies?.[name];
    if (!version) continue;
    const ordner = join(webDir, 'node_modules', name);
    if (!existsSync(ordner)) continue;
    const eigen = JSON.parse(await readFile(join(ordner, 'package.json'), 'utf8'));
    eintraege.push({
      name,
      version: eigen.version,
      lizenz:
        typeof eigen.license === 'string' ? eigen.license : (eigen.license?.type ?? 'unbekannt'),
      ...(await lizenzAus(ordner)),
      quelle: eigen.homepage ?? `https://www.npmjs.com/package/${name}`,
      teil: 'web',
    });
  }
  return eintraege;
}

/** Die Kisten der API. Das Binärprogramm geht an niemanden – trotzdem genannt. */
function rustKisten() {
  try {
    const roh = execFileSync(
      'cargo',
      [
        'metadata',
        '--format-version',
        '1',
        '--manifest-path',
        join(wurzel, 'apps', 'api', 'Cargo.toml'),
      ],
      { encoding: 'utf8', maxBuffer: 128 * 1024 * 1024, stdio: ['ignore', 'pipe', 'ignore'] },
    );
    const daten = JSON.parse(roh);
    return daten.packages
      .filter((paket) => paket.name !== 'initiative-api')
      .map((paket) => {
        const ordner = paket.manifest_path ? dirname(paket.manifest_path) : null;
        return {
          name: paket.name,
          version: paket.version,
          lizenz: paket.license ?? (paket.license_file ? 'siehe Lizenzdatei' : 'unbekannt'),
          urheber: (paket.authors ?? []).join(', '),
          quelle: paket.repository ?? paket.homepage ?? `https://crates.io/crates/${paket.name}`,
          teil: 'api',
          ordner,
        };
      });
  } catch {
    return null;
  }
}

/**
 * Die Lizenztexte, die zu keinem Ordner gehören.
 *
 * Modelle und einkompilierte Bibliotheken bringen keine LICENSE-Datei mit, die
 * man auslesen könnte – ein Modell ist eine Datei mit Zahlen. Ihr Lizenztext
 * muss trotzdem mit, und zwar in der veröffentlichten Fassung. Die liegt
 * deshalb hier als Datei, nicht als Verweis auf einen fremden Server: Eine
 * Lizenz, die man nachladen muss, fehlt genau dann, wenn man sie braucht.
 */
const TEXTDATEIEN = {
  'Apache-2.0': 'apache-2.0.txt',
  MIT: 'mit.txt',
  'BSD-3-Clause': 'bsd-3-clause.txt',
  'MPL-2.0': 'mpl-2.0.txt',
  ISC: 'isc.txt',
};

async function textFuerLizenz(lizenz) {
  const datei = TEXTDATEIEN[lizenz];
  if (!datei) return undefined;
  return textMerken((await readFile(join(hier, datei), 'utf8')).trim());
}

async function modellEintraege() {
  const aus = [];
  for (const modell of MODELLE) {
    if (!modell.lizenz) continue;
    aus.push({
      name: modell.name,
      lizenz: modell.lizenz,
      urheber: modell.urheber ?? '',
      quelle: modell.url,
      teil: 'modell',
      hinweis: modell.hinweis,
      textId: await textFuerLizenz(modell.lizenz),
    });
  }
  return aus;
}

// Auch die einkompilierten Bibliotheken bekommen ihren Lizenztext.
const eingebaut = [];
for (const eintrag of EINGEBAUT) {
  eingebaut.push({ ...eintrag, textId: await textFuerLizenz(eintrag.lizenz) });
}

/**
 * Rückfall für Pakete ohne eigene Lizenzdatei.
 *
 * Viele Pakete – gerade aus der Rust-Registry – nennen ihre Lizenz nur als
 * Kürzel in der Metadatei und legen keinen Text bei. Der Text gilt trotzdem;
 * er steht dann eben in seiner veröffentlichten Fassung hier. Aus einer
 * Angabe wie „MIT OR Apache-2.0“ wird das erste Kürzel genommen, das wir
 * haben – erlaubt ist beides, wir müssen uns nur auf eines festlegen.
 */
async function textNachkuerzel(lizenz) {
  for (const stueck of String(lizenz)
    .replace(/[()]/g, ' ')
    .split(/\s+OR\s+|\s+AND\s+|\//i)) {
    const treffer = await textFuerLizenz(stueck.trim());
    if (treffer) return treffer;
  }
  return undefined;
}

const rust = rustKisten();
// Die Lizenztexte der Kisten liegen im Quellordner der Registry.
for (const kiste of rust ?? []) {
  if (kiste.ordner) Object.assign(kiste, await lizenzAus(kiste.ordner));
  delete kiste.ordner;
}
const liste = {
  erzeugt: 'beim Bauen – siehe scripts/lizenzen.mjs',
  gruppen: [
    {
      teil: 'web',
      titel: 'Im Browser',
      eintraege: [...(await npmPakete()), ...(await werkzeugPakete())],
    },
    { teil: 'wasm', titel: 'Fest in den Rechenwerken', eintraege: eingebaut },
    { teil: 'modell', titel: 'Modelle', eintraege: await modellEintraege() },
    {
      teil: 'api',
      titel: 'Auf dem Server',
      eintraege: rust ?? [],
      fehlt: rust === null ? 'Cargo war beim Erzeugen nicht erreichbar.' : undefined,
    },
  ],
};

for (const gruppe of liste.gruppen) {
  for (const eintrag of gruppe.eintraege) {
    if (!eintrag.textId) eintrag.textId = await textNachkuerzel(eintrag.lizenz);
  }
  gruppe.eintraege.sort((a, b) => a.name.localeCompare(b.name, 'de'));
}

liste.texte = Object.fromEntries(texte);
await writeFile(ZIEL, JSON.stringify(liste), 'utf8');
const anzahl = liste.gruppen.reduce((summe, gruppe) => summe + gruppe.eintraege.length, 0);
console.log(`Lizenzliste geschrieben: ${anzahl} Eintraege in ${ZIEL}`);
for (const gruppe of liste.gruppen) {
  console.log(
    `  ${gruppe.titel}: ${gruppe.eintraege.length}${gruppe.fehlt ? ` (${gruppe.fehlt})` : ''}`,
  );
}
console.log(`  Lizenztexte (entdoppelt): ${texte.size}`);
