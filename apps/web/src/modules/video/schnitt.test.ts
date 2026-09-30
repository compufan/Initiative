import { describe, expect, it } from 'vitest';

import { neuesDoc } from '../bild/doc.js';
import { filmSchrittMs, filmZeitpunkte, kannTeilen } from './ausschnitt.js';
import { bildBereich } from './raster.js';
import {
  abschnittDazu,
  abschnittEntfernen,
  abschnittKuerzen,
  abschnittTeilen,
  abschnittVerschieben,
  ersterAbschnitt,
  filmAnfangMs,
  filmDauerMs,
  filmZuQuelle,
  haengtAmBild,
  hatInhaltsTeile,
  mussVerlegen,
  quelleZuFilm,
  rasterNeu,
  standDrin,
  standImRaster,
  verlegungVermerken,
  type Abschnitt,
} from './schnitt.js';

const doc = neuesDoc(64, 36);

function abschnitt(id: string, vonMs: number, bisMs: number, standMs = vonMs + 20): Abschnitt {
  return { id, vonMs, bisMs, doc, standMs };
}

describe('Film- und Quellzeit', () => {
  const liste = [abschnitt('a', 1000, 2000), abschnitt('b', 5000, 5500), abschnitt('c', 0, 300)];

  it('zählt die Länge des Films über alle Abschnitte', () => {
    expect(filmDauerMs(liste)).toBe(1800);
    expect(filmAnfangMs(liste, 2)).toBe(1500);
  });

  it('ordnet eine Grenze dem späteren Abschnitt zu', () => {
    expect(filmZuQuelle(liste, 999)).toEqual({ nummer: 0, quelleMs: 1999 });
    expect(filmZuQuelle(liste, 1000)).toEqual({ nummer: 1, quelleMs: 5000 });
    expect(filmZuQuelle(liste, 1600)).toEqual({ nummer: 2, quelleMs: 100 });
    // Hinter dem Ende: das Ende des letzten.
    expect(filmZuQuelle(liste, 99_999)).toEqual({ nummer: 2, quelleMs: 300 });
  });

  it('rechnet hin und zurück auf dieselbe Stelle', () => {
    for (const film of [0, 250, 999, 1000, 1499, 1500, 1799]) {
      const ort = filmZuQuelle(liste, film);
      expect(ort).not.toBeNull();
      if (ort) expect(quelleZuFilm(liste, ort.nummer, ort.quelleMs)).toBe(film);
    }
  });

  it('weiss auch bei zweimal demselben Stück, welches gemeint ist', () => {
    // Derselbe Ausschnitt zweimal hintereinander ist erlaubt; die Quellzeit
    // allein sagt dann nicht, wo im Film man steht.
    const doppelt = [abschnitt('a', 0, 400), abschnitt('b', 0, 400)];
    expect(quelleZuFilm(doppelt, 0, 100)).toBe(100);
    expect(quelleZuFilm(doppelt, 1, 100)).toBe(500);
  });
});

describe('standImRaster', () => {
  it('liegt auf einem Bild des Films, nicht daneben', () => {
    const stueck = { vonMs: 1000, bisMs: 2000 };
    const schritt = 40;
    const plan = filmZeitpunkte([stueck], 25, 1000).zeitpunkte;
    for (const ms of [900, 1000, 1013, 1500, 1987, 2500]) {
      const stand = standImRaster(stueck, ms, schritt);
      expect(
        plan.some((t) => Math.abs(t - stand) < 1e-6),
        `${ms} → ${stand}`,
      ).toBe(true);
    }
    expect(standImRaster(stueck, 1500, schritt)).toBe(1500);
    expect(standImRaster(stueck, 0, schritt)).toBe(1020);
  });
});

describe('abschnittTeilen', () => {
  it('gibt beiden Hälften dieselbe Bearbeitung', () => {
    const liste = [abschnitt('a', 0, 2000, 500)];
    const erg = abschnittTeilen(liste, 0, 1200, 40, 'neu');
    expect(erg).not.toBeNull();
    const [vorn, hinten] = erg?.abschnitte ?? [];
    expect(vorn).toMatchObject({ id: 'a', vonMs: 0, bisMs: 1200, standMs: 500 });
    expect(hinten).toMatchObject({ id: 'neu', vonMs: 1200, bisMs: 2000 });
    expect(vorn.doc).toBe(hinten.doc);
  });

  it('verlegt das Stellbild der Hälfte, aus der es herausfällt', () => {
    const vornStand = abschnittTeilen([abschnitt('a', 0, 2000, 500)], 0, 1200, 40, 'neu');
    expect(vornStand?.verlegung).toEqual({ id: 'neu', vonMs: 500, nachMs: 1220 });
    const hintenStand = abschnittTeilen([abschnitt('a', 0, 2000, 1500)], 0, 1200, 40, 'neu');
    // Die Kennung bleibt bei der Hälfte mit dem Stellbild.
    expect(hintenStand?.verlegung.id).toBe('neu');
    expect(hintenStand?.abschnitte[1].id).toBe('a');
    expect(hintenStand?.verlegung.vonMs).toBe(1500);
    const vorn = hintenStand?.abschnitte[0];
    expect(vorn && standDrin(vorn)).toBe(true);
    expect(hintenStand?.abschnitte[1].standMs).toBe(1500);
  });

  it('teilt nicht so, dass ein leeres Reststück entsteht', () => {
    const liste = [abschnitt('a', 0, 2000)];
    expect(abschnittTeilen(liste, 0, 10, 40)).toBeNull();
    expect(abschnittTeilen(liste, 0, 1990, 40)).toBeNull();
    expect(abschnittTeilen(liste, 1, 1000, 40)).toBeNull();
  });
});

describe('abschnittKuerzen', () => {
  it('hält den Abschnitt im Video und mindestens ein Bild lang', () => {
    const liste = [abschnitt('a', 1000, 2000, 1500)];
    const erg = abschnittKuerzen(liste, 0, -500, 99_000, 3000, 40);
    expect(erg.abschnitte[0]).toMatchObject({ vonMs: 0, bisMs: 3000 });
    const eng = abschnittKuerzen(liste, 0, 1500, 1500, 3000, 40);
    expect(eng.abschnitte[0].bisMs - eng.abschnitte[0].vonMs).toBe(40);
  });

  it('meldet keine Verlegung, solange das Stellbild drin bleibt', () => {
    const erg = abschnittKuerzen([abschnitt('a', 1000, 2000, 1500)], 0, 1200, 1800, 3000, 40);
    expect(erg.verlegung).toBeNull();
    expect(erg.abschnitte[0].standMs).toBe(1500);
  });

  it('rückt ein herausgefallenes Stellbild an den Rand und meldet es', () => {
    const erg = abschnittKuerzen([abschnitt('a', 1000, 2000, 1100)], 0, 1400, 2000, 3000, 40);
    const neu = erg.abschnitte[0];
    expect(standDrin(neu)).toBe(true);
    expect(neu.standMs).toBe(1420);
    expect(erg.verlegung).toEqual({ id: 'a', vonMs: 1100, nachMs: 1420 });
  });
});

describe('Verschieben, Entfernen, Hinzufügen', () => {
  const liste = [abschnitt('a', 0, 1000), abschnitt('b', 1000, 2000), abschnitt('c', 2000, 3000)];

  it('verschiebt und bleibt am Rand stehen', () => {
    expect(abschnittVerschieben(liste, 1, -1).map((a) => a.id)).toEqual(['b', 'a', 'c']);
    expect(abschnittVerschieben(liste, 0, -1)).toBe(liste);
    expect(abschnittVerschieben(liste, 2, 1)).toBe(liste);
  });

  it('lässt den letzten Abschnitt stehen', () => {
    expect(abschnittEntfernen(liste, 1).map((a) => a.id)).toEqual(['a', 'c']);
    const einer = [abschnitt('a', 0, 1000)];
    expect(abschnittEntfernen(einer, 0)).toBe(einer);
  });

  it('legt einen neuen Abschnitt hinter dem gewählten an, mit dessen Bearbeitung', () => {
    const erg = abschnittDazu(liste, 0, 10_000, 40, 'neu');
    expect(erg.neu).toBe(1);
    expect(erg.abschnitte.map((a) => a.id)).toEqual(['a', 'neu', 'b', 'c']);
    const neu = erg.abschnitte[1];
    expect(neu).toMatchObject({ vonMs: 1000, bisMs: 3000, doc });
    expect(standDrin(neu)).toBe(true);
    expect(erg.verlegung).toEqual({ id: 'neu', vonMs: liste[0].standMs, nachMs: neu.standMs });
  });

  it('bleibt beim Hinzufügen am Ende im Video', () => {
    const erg = abschnittDazu([abschnitt('a', 0, 1000)], 0, 1200, 40, 'neu');
    const neu = erg.abschnitte[1];
    expect(neu.vonMs).toBeGreaterThanOrEqual(0);
    expect(neu.bisMs).toBeLessThanOrEqual(1200);
    expect(neu.bisMs).toBeGreaterThan(neu.vonMs);
  });
});

describe('Mitnahme der Masken vermerken', () => {
  const mitTipp = {
    ...neuesDoc(64, 36),
    bereiche: [
      {
        id: 'b1',
        name: 'Motiv',
        // Auch ein abgeschalteter Bereich zählt: Wer ihn später einschaltet,
        // bekäme sonst die Maske eines anderen Bildes.
        aktiv: false,
        teile: [
          {
            id: 't1',
            modus: 'dazu' as const,
            umkehren: false,
            art: 'tipp' as const,
            mitNetz: false,
            punkte: [{ x: 1, y: 1 }],
            toleranz: 32,
            breite: 64,
            hoehe: 36,
            alpha: new Uint8Array(64 * 36),
            marke: 1,
          },
        ],
        anpassung: { ...neuesDoc(1, 1).anpassung, unschaerfe: 0 },
      },
    ],
  };

  it('erkennt Masken, die an einem Bild hängen – auch abgeschaltete', () => {
    expect(hatInhaltsTeile(mitTipp)).toBe(true);
    expect(hatInhaltsTeile(neuesDoc(64, 36))).toBe(false);
    expect(hatInhaltsTeile(null)).toBe(false);
  });

  it('vermerkt nur dort etwas, wo Masken hängen', () => {
    const ohne = [abschnitt('a', 0, 1000, 500)];
    expect(verlegungVermerken(ohne, { id: 'a', vonMs: 100, nachMs: 500 })).toEqual(ohne);
    const mit: Abschnitt[] = [{ ...abschnitt('a', 0, 1000, 500), doc: mitTipp }];
    const erg = verlegungVermerken(mit, { id: 'a', vonMs: 100, nachMs: 500 });
    expect(erg[0].teileMs).toBe(100);
    expect(mussVerlegen(erg[0])).toBe(true);
  });

  it('behält den ÄLTESTEN Stand, wenn zweimal verlegt wird, bevor gerechnet ist', () => {
    // Zweimal gekürzt: Die Masken gehören immer noch zum allerersten Bild.
    const mit: Abschnitt[] = [{ ...abschnitt('a', 0, 1000, 700), doc: mitTipp, teileMs: 100 }];
    const erg = verlegungVermerken(mit, { id: 'a', vonMs: 500, nachMs: 700 });
    expect(erg[0].teileMs).toBe(100);
  });

  it('räumt den Vermerk weg, wenn das Stellbild dorthin zurückkehrt', () => {
    const mit: Abschnitt[] = [{ ...abschnitt('a', 0, 1000, 100), doc: mitTipp, teileMs: 100 }];
    const erg = verlegungVermerken(mit, { id: 'a', vonMs: 500, nachMs: 100 });
    expect(erg[0].teileMs).toBeUndefined();
    expect(mussVerlegen(erg[0])).toBe(false);
  });
});

describe('Formen hängen am Bild wie Masken', () => {
  const mitVerlauf = {
    ...neuesDoc(64, 36),
    bereiche: [
      {
        id: 'b1',
        name: 'Himmel',
        aktiv: true,
        teile: [
          {
            id: 'v1',
            modus: 'dazu' as const,
            umkehren: false,
            art: 'verlauf' as const,
            von: { x: 0, y: 20 },
            bis: { x: 0, y: 0 },
          },
        ],
        anpassung: { ...neuesDoc(1, 1).anpassung, unschaerfe: 0 },
      },
    ],
  };

  it('zählt einen Verlauf als bildgebunden – nicht als Maske aus dem Inhalt', () => {
    // Ein Verlauf steht in Punkten des Stellbildes; rückt das Stellbild bei
    // einem Schwenk, ohne dass er mitgenommen wird, liegt er woanders.
    expect(haengtAmBild(mitVerlauf)).toBe(true);
    expect(hatInhaltsTeile(mitVerlauf)).toBe(false);
    const erg = verlegungVermerken([{ ...abschnitt('a', 0, 1000, 500), doc: mitVerlauf }], {
      id: 'a',
      vonMs: 100,
      nachMs: 500,
    });
    expect(mussVerlegen(erg[0])).toBe(true);
  });

  it('nimmt beim Hinzufügen den Stand, zu dem die Masken der Vorlage wirklich gehören', () => {
    // Die Vorlage wartet selbst noch: Ihre Masken gehören zu 100, nicht zu
    // ihrem schon verschobenen Stellbild bei 700.
    const liste: Abschnitt[] = [{ ...abschnitt('a', 0, 1000, 700), doc: mitVerlauf, teileMs: 100 }];
    const erg = abschnittDazu(liste, 0, 10_000, 40, 'neu');
    expect(erg.verlegung?.vonMs).toBe(100);
  });
});

describe('Kanten auf dem Raster', () => {
  /** Liegt `ms` auf einer Kante des Rasters – bis auf Gleitkommareste? */
  function aufRaster(ms: number, s: number): boolean {
    return Math.abs(ms / s - Math.round(ms / s)) < 1e-9;
  }

  it('teilt auf einer Rasterkante, auch bei 24 Bildern je Sekunde', () => {
    const s = filmSchrittMs(24);
    const alt = abschnitt('a', 24 * s, 72 * s, 50 * s);
    // 1043 ms ist 1 ms mehr als die gerundete Mindestweite von der Kante bei
    // 1000 ms – gerundet landet die Stelle genau ein Bild daneben.
    const erg = abschnittTeilen([alt], 0, 1043, s, 'neu');
    expect(erg).not.toBeNull();
    const [vorn, hinten] = erg?.abschnitte ?? [];
    expect(vorn.bisMs).toBeCloseTo(25 * s, 9);
    expect(hinten.vonMs).toBe(vorn.bisMs);
    expect(aufRaster(vorn.bisMs, s)).toBe(true);
  });

  it.each([10, 15, 24, 25, 30, 50, 60])(
    'teilt bei %i Bildern je Sekunde überall dort, wo die Zeitleiste ✂ anbietet',
    (rate) => {
      // Die Zeitleiste gibt den Knopf mit `kannTeilen` und einem GERUNDETEN
      // Bild Abstand frei. Täte das Teilen danach nichts, wäre der Knopf eine
      // Falle – siehe `abschnittTeilen`.
      const s = filmSchrittMs(rate);
      const alt = abschnitt('a', 30 * s, 45 * s, 31 * s);
      for (let bei = alt.vonMs; bei <= alt.bisMs; bei += 0.5) {
        if (!kannTeilen(alt, bei, Math.max(1, Math.round(s)))) continue;
        const erg = abschnittTeilen([alt], 0, bei, s, 'neu');
        expect(erg, `bei ${bei}`).not.toBeNull();
        for (const haelfte of erg?.abschnitte ?? []) {
          const { k0, k1 } = bildBereich(haelfte, s);
          expect(k1 - k0).toBeGreaterThanOrEqual(1);
          expect(aufRaster(haelfte.vonMs, s) && aufRaster(haelfte.bisMs, s)).toBe(true);
          expect(standDrin(haelfte)).toBe(true);
        }
      }
    },
  );

  it('kürzt auf das Raster und nie über das letzte ganze Bild hinaus', () => {
    const s = filmSchrittMs(30);
    const liste = [abschnitt('a', 30 * s, 60 * s, 45 * s)];
    const erg = abschnittKuerzen(liste, 0, 1013, 1987, 5020, s);
    expect(erg.abschnitte[0].vonMs).toBeCloseTo(30 * s, 9);
    expect(erg.abschnitte[0].bisMs).toBeCloseTo(60 * s, 9);
    // 5020 ms bei 25 Bildern je Sekunde: 125 ganze Bilder, das Ende bei 5000.
    const ende = abschnittKuerzen([abschnitt('a', 0, 1000, 500)], 0, 0, 99_000, 5020, 40);
    expect(ende.abschnitte[0].bisMs).toBe(5000);
    const hinten = abschnittKuerzen([abschnitt('a', 0, 1000, 500)], 0, 5010, 5030, 5020, 40);
    expect(hinten.abschnitte[0]).toMatchObject({ vonMs: 4960, bisMs: 5000 });
  });

  it('legt einen neuen Abschnitt auf das Raster', () => {
    const s = filmSchrittMs(30);
    const erg = abschnittDazu([abschnitt('a', 0, 1010, 500)], 0, 10_000, s, 'neu');
    const neu = erg.abschnitte[1];
    expect(aufRaster(neu.vonMs, s) && aufRaster(neu.bisMs, s)).toBe(true);
    expect(neu.vonMs).toBeCloseTo(30 * s, 9);
    expect(neu.bisMs).toBeCloseTo(90 * s, 9);
    expect(standDrin(neu)).toBe(true);
  });

  it('fängt einen Film auf dem Raster an – mit abgerundetem Ende', () => {
    const s24 = filmSchrittMs(24);
    const erst = ersterAbschnitt(5000, s24, 'a');
    expect(erst.vonMs).toBe(0);
    expect(erst.bisMs).toBeCloseTo(120 * s24, 9);
    expect(erst.standMs).toBeCloseTo(s24 / 2, 9);
    expect(ersterAbschnitt(3010, 40, 'a').bisMs).toBe(3000);
    // Kürzer als ein Bild: trotzdem eines.
    expect(ersterAbschnitt(10, 40, 'a').bisMs).toBe(40);
  });

  it('rastert bei einer neuen Bildrate alle Kanten neu – und lässt Fertiges stehen', () => {
    const liste = [abschnitt('a', 0, 1000, 500), abschnitt('b', 2000, 3000, 2500)];
    expect(rasterNeu(liste, 40, 10_000).abschnitte).toBe(liste);
    const s = filmSchrittMs(30);
    const erg = rasterNeu(liste, s, 10_000);
    expect(erg.verlegungen).toEqual([]);
    for (const neu of erg.abschnitte) {
      expect(aufRaster(neu.vonMs, s) && aufRaster(neu.bisMs, s)).toBe(true);
    }
    expect(erg.abschnitte[0].bisMs).toBeCloseTo(30 * s, 9);
    // Ein Abschnitt, der schon auf dem neuen Raster liegt, bleibt dasselbe Objekt.
    expect(rasterNeu([liste[0]], s, 10_000).abschnitte[0]).toBe(liste[0]);
  });

  it('hält beim Umrastern jeden Abschnitt mindestens ein Bild lang und in der Quelle', () => {
    const s = filmSchrittMs(10);
    const erg = rasterNeu(
      [abschnitt('a', 20, 40, 30), abschnitt('b', 4990, 5010, 5000), abschnitt('c', 150, 450, 160)],
      s,
      5020,
    );
    const [a, b, c] = erg.abschnitte;
    expect(a).toMatchObject({ vonMs: 0, bisMs: 100 });
    expect(b).toMatchObject({ vonMs: 4900, bisMs: 5000 });
    expect(c).toMatchObject({ vonMs: 200, bisMs: 500 });
    // Das Stellbild von c lag danach draussen und wurde an das nächste Bild verlegt.
    expect(erg.verlegungen).toEqual([{ id: 'c', vonMs: 160, nachMs: 250 }]);
    expect(standDrin(a) && standDrin(b) && standDrin(c)).toBe(true);
  });
});
