import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, test } from '@playwright/test';

/**
 * Das erste Bild eines Videos – scharf, und zwar ohne Abspielen.
 *
 * # Die Beschwerde
 *
 * „Die Vorschau von Bildern und Videos in der App ist sehr unscharf.“ Bei den
 * Bildern war es wirklich eine Vorschau, die einem scharfen Bild wich. Beim
 * Video nicht: Dort stand `poster={previewDataUrl}` neben `preload="metadata"`,
 * und diese Kombination heisst „hole die Kopfdaten und keinen einzigen
 * Bildpunkt“. Der Klecks war also nicht die Vorstufe, er war das Ergebnis –
 * bis jemand auf Abspielen drückte.
 *
 * # Warum im Browser
 *
 * Geprüft wird ein SPRUNG in einer echten Videodatei. Dafür braucht es einen
 * Dekodierer; in Node gibt es keinen. Das Video entsteht deshalb hier: eine
 * Leinwand, `captureStream`, `MediaRecorder` – erst rot, dann grün. Damit ist
 * am Farbwert ablesbar, ob wirklich der ANFANG im Rahmen steht und nicht
 * irgendeine Stelle.
 */

const HIER = fileURLToPath(new URL('.', import.meta.url));

/** Alle `.tsx` unter `src/` – für die Quelltextprüfung ganz unten. */
function dateienUnter(ordner: string): string[] {
  const raus: string[] = [];
  for (const name of readdirSync(ordner)) {
    const pfad = join(ordner, name);
    if (statSync(pfad).isDirectory()) raus.push(...dateienUnter(pfad));
    else if (pfad.endsWith('.tsx')) raus.push(pfad);
  }
  return raus;
}

test('das Video zeigt sein erstes Bild scharf, ohne dass jemand abspielt', async ({ page }) => {
  await page.goto('/');

  const ergebnis = await page.evaluate(async () => {
    const ladeHelfer = '/src/modules/media/helpers.ts';
    const helfer = (await import(
      /* @vite-ignore */ ladeHelfer
    )) as typeof import('../src/modules/media/helpers.js');

    /* ---- 1. Ein echtes Video aufnehmen: erst rot, dann grün. ---- */
    const leinwand = document.createElement('canvas');
    leinwand.width = 160;
    leinwand.height = 120;
    const ctx = leinwand.getContext('2d');
    if (!ctx) throw new Error('keine Leinwand');
    const malen = (farbe: string, ms: number) =>
      new Promise<void>((auf) => {
        const ende = performance.now() + ms;
        const schritt = () => {
          ctx.fillStyle = farbe;
          ctx.fillRect(0, 0, leinwand.width, leinwand.height);
          if (performance.now() < ende) requestAnimationFrame(schritt);
          else auf();
        };
        schritt();
      });

    ctx.fillStyle = '#ff0000';
    ctx.fillRect(0, 0, leinwand.width, leinwand.height);
    const strom = leinwand.captureStream(25);
    const art =
      ['video/webm;codecs=vp9', 'video/webm;codecs=vp8', 'video/webm'].find((t) =>
        MediaRecorder.isTypeSupported(t),
      ) ?? '';
    const rekorder = new MediaRecorder(strom, art ? { mimeType: art } : undefined);
    const teile: Blob[] = [];
    rekorder.ondataavailable = (e) => {
      if (e.data.size > 0) teile.push(e.data);
    };
    const gestoppt = new Promise<void>((auf) => {
      rekorder.onstop = () => auf();
    });
    rekorder.start();
    await malen('#ff0000', 700);
    await malen('#00ff00', 700);
    rekorder.stop();
    await gestoppt;
    strom.getTracks().forEach((spur) => spur.stop());
    const datei = new Blob(teile, { type: art || 'video/webm' });

    /* ---- 2. Ein Video wie im Chat: Kopfdaten laden, nicht mehr. ---- */
    const quelle = URL.createObjectURL(datei);
    const bauen = () => {
      const video = document.createElement('video');
      video.preload = 'metadata';
      video.muted = true;
      video.playsInline = true;
      video.src = quelle;
      document.body.appendChild(video);
      return video;
    };
    const video = bauen();
    await new Promise<void>((auf, ab) => {
      video.onloadedmetadata = () => auf();
      video.onerror = () => ab(new Error('Video nicht ladbar'));
    });

    const laengeImKopf = video.duration;
    helfer.standbildHolen(video);

    const warten = async (pruefung: () => boolean, ms = 6000) => {
      const ende = performance.now() + ms;
      while (performance.now() < ende) {
        if (pruefung()) return true;
        await new Promise((auf) => setTimeout(auf, 30));
      }
      return false;
    };
    const fertig = await warten(
      () => video.dataset.standbild === 'fertig' && video.readyState >= 2,
    );

    /* ---- 3. Was steht jetzt im Rahmen? ---- */
    const probe = document.createElement('canvas');
    probe.width = video.videoWidth || 1;
    probe.height = video.videoHeight || 1;
    const pctx = probe.getContext('2d', { willReadFrequently: true });
    let punkt: number[] = [];
    try {
      pctx?.drawImage(video, 0, 0);
      const d = pctx?.getImageData(
        Math.floor(probe.width / 2),
        Math.floor(probe.height / 2),
        1,
        1,
      ).data;
      punkt = d ? [d[0], d[1], d[2]] : [];
    } catch {
      punkt = [];
    }

    const nachher = {
      fertig,
      merker: video.dataset.standbild ?? null,
      zeit: video.currentTime,
      bereit: video.readyState,
      punkt,
      breite: video.videoWidth,
      laengeImKopf,
    };

    // Ein zweiter Ruf – `loadedmetadata` kommt bei jedem Quellwechsel erneut.
    helfer.standbildHolen(video);
    const nochmal = { merker: video.dataset.standbild ?? null, zeit: video.currentTime };

    /* ---- 4. Ein laufendes Video wird nicht zurückgerissen. ---- */
    const zweites = bauen();
    await new Promise<void>((auf, ab) => {
      zweites.onloadedmetadata = () => auf();
      zweites.onerror = () => ab(new Error('Video nicht ladbar'));
    });
    zweites.currentTime = 0.9;
    await warten(() => Math.abs(zweites.currentTime - 0.9) < 0.3, 3000);
    const stelleVorher = zweites.currentTime;
    helfer.standbildHolen(zweites);
    await new Promise((auf) => setTimeout(auf, 400));
    const laufend = {
      merker: zweites.dataset.standbild ?? null,
      vorher: stelleVorher,
      nachher: zweites.currentTime,
    };

    video.remove();
    zweites.remove();
    URL.revokeObjectURL(quelle);

    return { nachher, nochmal, laufend, groesse: datei.size };
  });

  expect(ergebnis.groesse, 'die Aufnahme ist leer geblieben').toBeGreaterThan(0);
  expect(ergebnis.nachher.fertig, 'das Standbild kam nicht zustande').toBe(true);

  /*
   * `HAVE_CURRENT_DATA` oder mehr – notwendig, aber NICHT hinreichend, und das
   * ist nachgemessen: Nimmt man den Sprung ganz heraus, steht hier trotzdem 2
   * (die Quelle ist hier ein Blob im Gerät, da hält sich Chromium nicht streng
   * an `preload`), und abgezeichnet wird trotzdem Schwarz. Die Aussage trägt
   * deshalb der Farbwert unten, nicht diese Zahl.
   */
  expect(ergebnis.nachher.bereit).toBeGreaterThanOrEqual(2);
  expect(ergebnis.nachher.breite).toBeGreaterThan(0);

  /*
   * Und zwar der ANFANG. Rot war die erste Sekunde, Grün die zweite. Stünde
   * hier Grün, wäre irgendeine Stelle geholt worden; stünde hier nichts oder
   * Schwarz, wäre gar kein Bild entschlüsselt worden.
   */
  const [r, g, b] = ergebnis.nachher.punkt;
  expect(ergebnis.nachher.punkt, 'es liess sich kein Bild abzeichnen').toHaveLength(3);
  expect(r, `erwartet war der rote Anfang, gemessen ${r},${g},${b}`).toBeGreaterThan(150);
  expect(g, `erwartet war der rote Anfang, gemessen ${r},${g},${b}`).toBeLessThan(110);
  expect(b).toBeLessThan(110);

  /*
   * Danach steht die Uhr wieder auf Null. Ohne diesen zweiten Sprung begänne
   * das Abspielen bei einem Zehntel, und der Anfang fehlte – eine kleine,
   * aber dauerhafte Verschlechterung, die man erst beim genauen Hinsehen
   * bemerkt.
   */
  expect(ergebnis.nachher.zeit, 'das Video steht nicht wieder am Anfang').toBeLessThan(0.02);
  expect(ergebnis.nachher.merker).toBe('fertig');

  /*
   * Und ein zweiter Ruf fasst nichts mehr an. `loadedmetadata` kommt bei
   * jedem Quellwechsel erneut; ohne den Merker spränge das Video dann jedes
   * Mal aufs Neue hin und zurück.
   */
  expect(ergebnis.nochmal.merker, 'der zweite Ruf hat erneut gesprungen').toBe('fertig');
  expect(ergebnis.nochmal.zeit).toBeLessThan(0.02);

  /*
   * Wer schon weitergespult hat, wird in Ruhe gelassen. Ohne diese Wache
   * risse ein zweites `loadedmetadata` – das kommt bei jedem Quellwechsel –
   * das Video mitten im Abspielen an den Anfang zurück.
   */
  expect(ergebnis.laufend.merker, 'ein gespultes Video wurde angefasst').toBeNull();
  expect(Math.abs(ergebnis.laufend.nachher - ergebnis.laufend.vorher)).toBeLessThan(0.05);
});

test('die Sprungstelle passt zu jeder Länge – auch zu keiner', async ({ page }) => {
  await page.goto('/');

  const werte = await page.evaluate(async () => {
    const ladeHelfer = '/src/modules/media/helpers.ts';
    const helfer = (await import(
      /* @vite-ignore */ ladeHelfer
    )) as typeof import('../src/modules/media/helpers.js');
    return {
      lang: helfer.standbildZiel(12),
      kurz: helfer.standbildZiel(0.06),
      ohne: helfer.standbildZiel(Number.POSITIVE_INFINITY),
      unbekannt: helfer.standbildZiel(Number.NaN),
      null_: helfer.standbildZiel(0),
      zeit: helfer.STANDBILD_ZEIT,
    };
  });

  // Ein normales Video: ein Zehntel, nah genug am ersten Bild.
  expect(werte.lang).toBeCloseTo(werte.zeit, 6);

  /*
   * Ein Video von sechs Hundertsteln: Ein Zehntel läge HINTER dem Ende, der
   * Sprung ginge ins Leere und der Rahmen bliebe leer.
   */
  expect(werte.kurz).toBeCloseTo(0.03, 6);
  expect(werte.kurz).toBeLessThan(0.06);

  /*
   * Und der Fall, der die eigene Kamera betrifft: `MediaRecorder` schreibt
   * fast nie eine Länge in den Kopf, `duration` ist dann `Infinity`. Das
   * darf den Sprung NICHT verhindern – die Daten sind ja da. Eine frühere
   * Fassung verlangte eine endliche Länge und hätte ausgerechnet die eigene
   * Aufnahme ohne Standbild gelassen.
   */
  expect(werte.ohne, 'eine Aufnahme ohne Längenangabe bekäme kein Standbild').toBeCloseTo(
    werte.zeit,
    6,
  );
  expect(werte.unbekannt).toBeCloseTo(werte.zeit, 6);
  expect(werte.null_).toBeCloseTo(werte.zeit, 6);
});

test('kein `<video>` trägt noch ein Plakat aus der unscharfen Vorschau', async () => {
  /*
   * Eine Quelltextprüfung, und zwar mit Absicht.
   *
   * `poster` zusammen mit `preload="metadata"` ist die Kombination, die die
   * Beschwerde ausgelöst hat: Das Plakat IST die eingebettete Vorschau, und
   * ohne Bilddaten bleibt es stehen. Der Fehler sieht beim Schreiben aber
   * völlig harmlos aus – man gibt dem Video ja etwas zu zeigen. Er fällt auch
   * bei keinem Ablauftest auf, weil das Video „ein Bild hat“. Deshalb steht
   * hier die Regel selbst.
   */
  const treffer: string[] = [];
  for (const pfad of dateienUnter(join(HIER, '..', 'src'))) {
    const text = readFileSync(pfad, 'utf8');
    for (const block of text.matchAll(/<video[\s\S]*?\/?>/g)) {
      if (block[0].includes('poster')) treffer.push(pfad.split('/src/')[1]);
    }
  }
  expect(
    treffer,
    'ein Plakat aus der Vorschau bleibt stehen, bis jemand abspielt – ' +
      'statt dessen `standbildHolen` an `onLoadedMetadata`',
  ).toEqual([]);
});
