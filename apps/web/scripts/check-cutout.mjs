/**
 * Prüft die Freistell-Verfahren in einem echten Browser.
 *
 * Warum eigenes Skript statt Vitest: die Modelle brauchen WebAssembly, Canvas
 * und einen laufenden Server. In der Testumgebung von Vitest gibt es das
 * nicht – und ein Test, der das Entscheidende nicht prüfen kann, prüft nichts.
 *
 * Das Entscheidende ist hier die *Richtung* der Maske. Sie kann technisch
 * einwandfrei ankommen und trotzdem genau verkehrt herum sein; dann bleibt
 * der Hintergrund stehen und die Person verschwindet. Genau das war beim
 * ersten Anlauf der Fall. Deshalb wird an einem echten Porträt geprüft: Ecken
 * müssen weg sein, der Schwerpunkt der Maske muss im Motiv liegen.
 *
 * Aufruf im Projektordner:
 *   pnpm --filter @initiative/web run check:cutout
 */
import { spawn } from 'node:child_process';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const hier = dirname(fileURLToPath(import.meta.url));
const webDir = join(hier, '..');
const PORT = 5199;
const APP = `http://127.0.0.1:${PORT}`;

/**
 * Ein Porträt von Google, mit dem MediaPipe selbst seine Beispiele zeigt.
 * Wird nur zum Prüfen geladen und liegt deshalb nicht im Git.
 */
const TESTBILD_URL = 'https://storage.googleapis.com/mediapipe-assets/portrait.jpg';
const TESTBILD = join(webDir, 'public', '__test-portrait.jpg');

/** Was jedes Verfahren am Porträt liefern muss. */
const ERWARTUNG = {
  person: { minFlaeche: 0.2, maxFlaeche: 0.8 },
  // Ein Kopf ist deutlich kleiner als eine Person – und sitzt weiter oben.
  face: { minFlaeche: 0.03, maxFlaeche: 0.4, maxSchwerpunktY: 0.45 },
  object: { minFlaeche: 0.2, maxFlaeche: 0.8 },
  birefnet: { minFlaeche: 0.2, maxFlaeche: 0.8 },
};

async function testbildBereitlegen() {
  try {
    if ((await stat(TESTBILD)).size > 100_000) return;
  } catch {
    /* noch nicht da */
  }
  const antwort = await fetch(TESTBILD_URL);
  if (!antwort.ok) throw new Error(`Testbild nicht ladbar: HTTP ${antwort.status}`);
  await mkdir(dirname(TESTBILD), { recursive: true });
  await writeFile(TESTBILD, Buffer.from(await antwort.arrayBuffer()));
}

async function warteAufServer(versuche = 60) {
  for (let i = 0; i < versuche; i += 1) {
    try {
      const antwort = await fetch(APP, { signal: AbortSignal.timeout(2000) });
      if (antwort.ok) return;
    } catch {
      /* noch nicht oben */
    }
    await new Promise((fertig) => setTimeout(fertig, 500));
  }
  throw new Error('Der Entwicklungsserver ist nicht hochgekommen.');
}

/**
 * Mit `--nur person,object` laesst sich auf einzelne Verfahren einschraenken.
 *
 * Der Grund ist unfein, aber praktisch: „Hohe Qualitaet“ rechnet auf einem
 * gedrosselten Rechner Minuten. Wer nur an diesem einen Verfahren
 * herumprobiert, will nicht jedes Mal alle vier abwarten.
 */
const nurIndex = process.argv.indexOf('--nur');
const NUR =
  nurIndex >= 0 && process.argv[nurIndex + 1]
    ? process.argv[nurIndex + 1].split(',').map((wert) => wert.trim())
    : Object.keys(ERWARTUNG);

console.log('Freistellen im Browser prüfen …');
await testbildBereitlegen();

const server = spawn('pnpm', ['exec', 'vite', '--port', String(PORT), '--strictPort'], {
  cwd: webDir,
  stdio: 'ignore',
  detached: true,
});
let code = 1;
try {
  await warteAufServer();

  // Ueber @playwright/test, weil playwright-core nur mittelbar installiert ist.
  const { chromium } = await import('@playwright/test');
  const browser = await chromium.launch({
    executablePath:
      process.env.CHROMIUM_PATH ?? '/opt/pw-browsers/chromium-1194/chrome-linux/chrome',
    args: ['--no-sandbox'],
  });
  const page = await (await browser.newContext()).newPage();
  page.on('console', (m) => {
    if (m.type() === 'error') console.log('    [Browser]', m.text().slice(0, 240));
  });

  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  // Vite bereitet grosse Abhängigkeiten beim ersten Import auf und lädt die
  // Seite danach neu. Also einmal anstossen, warten, neu laden.
  await page
    .evaluate(async () => {
      await import('/src/modules/stickers/engines/person.ts');
      await import('/src/modules/stickers/engines/face.ts');
      await import('/src/modules/stickers/engines/object.ts');
      await import('/src/modules/stickers/engines/birefnet.ts');
    })
    .catch(() => {});
  await page.waitForTimeout(9000);
  await page.goto(APP, { waitUntil: 'domcontentloaded' });
  await page.waitForTimeout(1500);

  const bericht = await page.evaluate(async (verfahren) => {
    const engines = await import('/src/modules/stickers/engines/index.ts');
    const { vorlageAus, maskeTraegt } = await import('/src/modules/stickers/engines/prepare.ts');

    const img = new Image();
    img.src = '/__test-portrait.jpg';
    await img.decode();
    const { image } = vorlageAus(img, img.naturalWidth, img.naturalHeight);
    const w = image.width;
    const h = image.height;

    const ergebnis = {};
    for (const key of verfahren) {
      const start = performance.now();
      try {
        // Das grosse Modell ist von Haus aus aus – zum Prüfen einschalten.
        engines.writeEngineSetting(key, true);
        const alpha = await engines.runEngine(key, { image });
        const bei = (x, y) => alpha[Math.floor(y) * w + Math.floor(x)];

        let sx = 0;
        let sy = 0;
        let n = 0;
        for (let y = 0; y < h; y += 1) {
          for (let x = 0; x < w; x += 1) {
            if (alpha[y * w + x] > 128) {
              sx += x;
              sy += y;
              n += 1;
            }
          }
        }

        ergebnis[key] = {
          ok: true,
          laenge: alpha.length,
          erwartet: w * h,
          ecken: [bei(2, 2), bei(w - 3, 2), bei(2, h - 3), bei(w - 3, h - 3)],
          anteil: n / (w * h),
          schwerpunkt: n ? [sx / n / w, sy / n / h] : null,
          amSchwerpunkt: n ? bei(sx / n, sy / n) : 0,
          traegt: maskeTraegt(alpha),
          ms: Math.round(performance.now() - start),
        };
      } catch (error) {
        ergebnis[key] = {
          ok: false,
          fehler: String(error?.message ?? error),
          ms: Math.round(performance.now() - start),
        };
      }
    }
    return ergebnis;
  }, NUR);

  await browser.close();

  let alleOk = true;
  for (const [key, e] of Object.entries(bericht)) {
    if (!e.ok) {
      alleOk = false;
      console.log(`  FEHL ${key.padEnd(7)} ${e.fehler} (${e.ms} ms)`);
      continue;
    }
    const soll = ERWARTUNG[key];
    const sp = e.schwerpunkt;
    const gruende = [];
    if (e.laenge !== e.erwartet) gruende.push(`Maskengrösse ${e.laenge} statt ${e.erwartet}`);
    if (!e.ecken.every((v) => v < 64)) gruende.push(`Ecken bleiben stehen (${e.ecken.join(',')})`);
    if (!e.traegt) gruende.push('Maske ist praktisch leer');
    if (!sp) gruende.push('kein Motiv gefunden');
    else {
      if (e.amSchwerpunkt <= 192) gruende.push(`Schwerpunkt nicht gedeckt (${e.amSchwerpunkt})`);
      if (sp[0] < 0.15 || sp[0] > 0.85)
        gruende.push(`Schwerpunkt liegt seitlich (${sp[0].toFixed(2)})`);
      if (soll.maxSchwerpunktY && sp[1] > soll.maxSchwerpunktY) {
        gruende.push(`Schwerpunkt zu tief (${sp[1].toFixed(2)} > ${soll.maxSchwerpunktY})`);
      }
    }
    if (e.anteil < soll.minFlaeche || e.anteil > soll.maxFlaeche) {
      gruende.push(
        `Fläche ${(e.anteil * 100).toFixed(0)}% ausserhalb von ${soll.minFlaeche * 100}–${soll.maxFlaeche * 100}%`,
      );
    }

    if (gruende.length > 0) alleOk = false;
    console.log(
      `  ${gruende.length === 0 ? 'OK  ' : 'FEHL'} ${key.padEnd(7)} ` +
        `Ecken ${e.ecken.join(',')} · Schwerpunkt ${sp ? sp.map((v) => v.toFixed(2)).join('/') : '-'} ` +
        `= ${e.amSchwerpunkt} · ${(e.anteil * 100).toFixed(0)}% Fläche · ${e.ms} ms`,
    );
    for (const grund of gruende) console.log(`       ↳ ${grund}`);
  }
  code = alleOk ? 0 : 1;
} finally {
  // Die ganze Prozessgruppe beenden – vite startet Kindprozesse.
  try {
    process.kill(-server.pid, 'SIGTERM');
  } catch {
    /* schon weg */
  }
}
process.exit(code);
