import { describe, expect, it } from 'vitest';

import {
  BILDRATEN,
  FILM_BILDRATEN,
  abtasten,
  dauerJeBildMs,
  filmSchrittMs,
  filmZeitpunkte,
  groesseSchaetzenB,
  groesseText,
  kannTeilen,
  stueckTeilen,
  zeitpunkte,
} from './ausschnitt.js';

describe('Die angebotenen Bildraten', () => {
  it('gehen alle in Hundertsteln auf', () => {
    /*
     * Der Grund, warum es überhaupt eine Liste gibt und kein Zahlenfeld. Geht
     * eine Rate nicht auf, läuft das GIF messbar schneller oder langsamer als
     * das Video – und niemand käme auf die Idee, das an der Bildrate
     * festzumachen.
     */
    for (const { rate } of BILDRATEN) {
      const hundertstel = 100 / rate;
      expect(hundertstel, `${rate}/s`).toBe(Math.round(hundertstel));
    }
  });

  it('bleibt bei mindestens zwei Hundertsteln Standzeit', () => {
    // `gifSchreiben` hebt alles darunter auf zwei an. Eine Rate, die das
    // reisst, liefe im GIF langsamer als angeschrieben.
    for (const { rate } of BILDRATEN) {
      expect(dauerJeBildMs(rate), `${rate}/s`).toBeGreaterThanOrEqual(20);
    }
  });

  it('gibt jeder Rate einen Titel und einen Satz', () => {
    for (const rate of BILDRATEN) {
      expect(rate.titel.length, String(rate.rate)).toBeGreaterThan(1);
      expect(rate.beschreibung.length, String(rate.rate)).toBeGreaterThan(8);
    }
  });
});

describe('dauerJeBildMs', () => {
  it('rechnet die üblichen Raten genau um', () => {
    expect(dauerJeBildMs(5)).toBe(200);
    expect(dauerJeBildMs(10)).toBe(100);
    expect(dauerJeBildMs(12.5)).toBe(80);
    expect(dauerJeBildMs(20)).toBe(50);
    expect(dauerJeBildMs(25)).toBe(40);
  });

  it('liefert immer ein Vielfaches von zehn', () => {
    // Alles andere verliert GIF beim Schreiben, ohne sich zu beschweren.
    for (const rate of [3, 7, 9, 11, 24, 30, 60]) {
      expect(dauerJeBildMs(rate) % 10, `${rate}/s`).toBe(0);
    }
  });
});

describe('zeitpunkte', () => {
  it('legt die Bilder im Abstand der Standzeit ab', () => {
    const { zeitpunkte: liste, schrittMs: schritt } = zeitpunkte(0, 500, 10, 100);
    expect(schritt).toBe(100);
    expect(liste).toEqual([0, 100, 200, 300, 400]);
  });

  it('fängt beim gewählten Anfang an und nicht bei null', () => {
    // Der Anfang ist eine Stelle im Video, keine Verschiebung – wer bei 2,4 s
    // beginnt, will das Bild von 2,4 s.
    expect(zeitpunkte(2400, 2700, 10, 100).zeitpunkte).toEqual([2400, 2500, 2600]);
  });

  it('schneidet hinten ab, statt auszudünnen', () => {
    /*
     * Ausdünnen wäre die naheliegende Rettung und die falsche: Jedes zweite
     * Bild bei voller Standzeit ergibt Zeitlupe, bei halber Standzeit den
     * schnellen Vorlauf. Ein kürzerer Ausschnitt ist ehrlich – und er steht
     * mit `gekuerztMs` auch da.
     */
    const kurz = zeitpunkte(0, 5000, 10, 12);
    expect(kurz.zeitpunkte).toHaveLength(12);
    expect(kurz.zeitpunkte[11]).toBe(1100);
    expect(kurz.gekuerztMs).toBe(3800);
  });

  it('meldet keine Kürzung, wenn alles hineinpasst', () => {
    expect(zeitpunkte(0, 1000, 10, 50).gekuerztMs).toBe(0);
  });

  it('gibt auch für einen Punkt ohne Länge ein Bild zurück', () => {
    // Wer die beiden Griffe übereinanderschiebt, bekommt ein Standbild und
    // keine Fehlermeldung – ein GIF ohne Teilbilder wirft in `gifSchreiben`.
    expect(zeitpunkte(1200, 1200, 10, 50).zeitpunkte).toEqual([1200]);
  });

  it('nimmt einen verdrehten Bereich hin, statt rückwärts zu laufen', () => {
    const verdreht = zeitpunkte(900, 300, 10, 50);
    expect(verdreht.zeitpunkte).toEqual([900]);
  });

  it('rundet die Zahl der Bilder, statt den Rest wegzuwerfen', () => {
    // 950 ms bei zehn Bildern je Sekunde sind zehn Bilder, nicht neun.
    expect(zeitpunkte(0, 950, 10, 50).zeitpunkte).toHaveLength(10);
  });
});

describe('groesseSchaetzenB', () => {
  it('trifft die Messung, aus der die Zahlen stammen', () => {
    /*
     * Fünfzig Bilder à 512 × 512 durch `gifSchreiben`: 6 505 995 Byte als
     * Vollbild, 916 000 freigestellt. Die Schätzung darf davon ein paar
     * Prozent abweichen, aber nicht ein Vielfaches – sonst steht auf dem Knopf
     * „rund 2 MB" und heraus kommen sechs.
     */
    expect(groesseSchaetzenB(50, 512, false)).toBeCloseTo(6_506_000, -5);
    expect(groesseSchaetzenB(50, 512, true)).toBeCloseTo(916_000, -4);
  });

  it('wächst mit der FLÄCHE und nicht mit der Kante', () => {
    // Die halbe Kante ist ein Viertel der Bildpunkte. Wer linear schätzt,
    // verspricht bei 256 die Hälfte und liefert ein Viertel.
    const gross = groesseSchaetzenB(20, 512, false);
    const klein = groesseSchaetzenB(20, 256, false);
    expect(klein).toBeCloseTo(gross / 4, -3);
  });

  it('macht freigestellt deutlich leichter als Vollbild', () => {
    // Der Grund, warum Freistellen überhaupt unter die 4-MB-Grenze für
    // Sticker führt: Die durchsichtige Fläche ist EIN Tafelplatz, und eine
    // lange Reihe desselben Platzes packt LZW fast umsonst.
    expect(groesseSchaetzenB(50, 512, true) * 5).toBeLessThan(groesseSchaetzenB(50, 512, false));
  });
});

describe('groesseText', () => {
  it('wechselt bei knapp unter einem Megabyte die Einheit', () => {
    expect(groesseText(400_000)).toBe('rund 400 kB');
    expect(groesseText(1_400_000)).toBe('rund 1,4 MB');
  });

  it('schreibt das Komma deutsch', () => {
    // Ein Punkt liest sich hier als Tausendertrenner – „rund 1.4 MB" sieht
    // aus wie 1400.
    expect(groesseText(2_500_000)).not.toContain('.');
  });

  it('sagt nie „rund 0 kB"', () => {
    expect(groesseText(120)).toBe('rund 1 kB');
  });
});

describe('Die Bildraten für den Film', () => {
  it('reichen bis 60 und sind aufsteigend', () => {
    // Die Bitte lautete wörtlich „bis zu 60 Bilder pro sekunde beim Video
    // bearbeiten". Eine Liste, die bei 25 endet, erfüllt sie nicht.
    expect(FILM_BILDRATEN.at(-1)?.rate).toBe(60);
    for (let i = 1; i < FILM_BILDRATEN.length; i += 1) {
      expect(FILM_BILDRATEN[i].rate).toBeGreaterThan(FILM_BILDRATEN[i - 1].rate);
    }
  });

  it('bleibt von der GIF-Liste getrennt', () => {
    /*
     * Der Grund, warum es zwei Listen gibt: GIF zählt die Standzeit in
     * Hundertsteln. Stünde 60 in `BILDRATEN`, böte das GIF-Blatt eine Rate
     * an, die es nicht schreiben kann.
     */
    for (const { rate } of BILDRATEN) {
      expect(100 / rate, `${rate}/s im GIF`).toBe(Math.round(100 / rate));
    }
    expect(BILDRATEN.some((eintrag) => eintrag.rate > 25)).toBe(false);
  });

  it('gibt jeder Rate einen Titel und einen Satz', () => {
    for (const rate of FILM_BILDRATEN) {
      expect(rate.titel.length, String(rate.rate)).toBeGreaterThan(1);
      expect(rate.beschreibung.length, String(rate.rate)).toBeGreaterThan(8);
    }
  });
});

describe('filmSchrittMs', () => {
  it('rastert NICHT auf zehn Millisekunden', () => {
    /*
     * Das ist der ganze Punkt. `dauerJeBildMs(60)` ist 20 ms, also 50 Bilder
     * je Sekunde – während `videoSchreiben` die Zeitstempel mit 1000/60
     * schreibt. Der Film liefe um den Faktor 1,2 zu schnell, und zwar
     * lautlos.
     */
    expect(filmSchrittMs(60)).toBeCloseTo(16.666, 2);
    expect(dauerJeBildMs(60)).toBe(20);
    expect(filmSchrittMs(30)).toBeCloseTo(33.333, 2);
    expect(dauerJeBildMs(30)).toBe(30);
  });

  it('trifft die runden Raten genau', () => {
    expect(filmSchrittMs(25)).toBe(40);
    expect(filmSchrittMs(50)).toBe(20);
    expect(filmSchrittMs(10)).toBe(100);
  });
});

describe('filmZeitpunkte', () => {
  it('tastet in die BILDMITTE ab', () => {
    /*
     * Gemessen gegen eine echte Quelle mit 60 Bildern je Sekunde: 140
     * Sprünge exakt auf die Bildgrenze lieferten nur 93 verschiedene Bilder,
     * in die Mitte gesprungen 140 von 140.
     */
    const plan = filmZeitpunkte([{ vonMs: 0, bisMs: 120 }], 25, 100);
    expect(plan.zeitpunkte).toEqual([20, 60, 100]);
  });

  it('lässt den GIF-Weg auf der Bildgrenze', () => {
    expect(zeitpunkte(0, 120, 25, 100).zeitpunkte).toEqual([0, 40, 80]);
  });

  it('reiht mehrere Stücke hintereinander und meldet die Schnitte', () => {
    const plan = filmZeitpunkte(
      [
        { vonMs: 0, bisMs: 200 },
        { vonMs: 1000, bisMs: 1200 },
      ],
      10,
      100,
    );
    expect(plan.zeitpunkte).toEqual([50, 150, 1050, 1150]);
    expect(plan.schnitte).toEqual([2]);
  });

  it('nimmt die Reihenfolge der Stücke ernst', () => {
    // Das ist der Sinn der Pfeile in der Oberfläche: Wer das hintere Stück
    // nach vorn holt, will den Film in dieser Reihenfolge sehen.
    const plan = filmZeitpunkte(
      [
        { vonMs: 1000, bisMs: 1100 },
        { vonMs: 0, bisMs: 100 },
      ],
      10,
      100,
    );
    expect(plan.zeitpunkte).toEqual([1050, 50]);
  });
});

describe('Die Grenze für gesammelte Gruppen', () => {
  /*
   * Drei Abschnitte zu je einer Sekunde bei 10 Bildern je Sekunde; nur der
   * mittlere trägt eine Maske. Die Speichergrenze von 5 Bildern gilt nur
   * für ihn – früher kürzte sie den ganzen Film auf 5 Bilder.
   */
  const drei = [
    { vonMs: 0, bisMs: 1000 },
    { vonMs: 2000, bisMs: 3000 },
    { vonMs: 4000, bisMs: 5000 },
  ];

  it('lässt Abschnitte ohne Maske in Ruhe', () => {
    const plan = filmZeitpunkte(drei, 10, 600, { gruppeJeStueck: [null, 0, null], max: 10 });
    expect(plan.zeitpunkte).toHaveLength(30);
    expect(plan.gekuerztMs).toBe(0);
    expect(plan.gekuerztWegen).toBeUndefined();
  });

  it('kürzt am Ende der zu langen Gruppe und nicht mitten im Film', () => {
    const plan = filmZeitpunkte(drei, 10, 600, { gruppeJeStueck: [null, 0, null], max: 5 });
    // Der erste ganz, vom zweiten fünf Bilder – und danach nichts mehr.
    expect(plan.zeitpunkte).toHaveLength(15);
    expect(plan.stueckJeBild.filter((stueck) => stueck === 2)).toHaveLength(0);
    expect(plan.gekuerztMs).toBeCloseTo(1500, 5);
    expect(plan.gekuerztWegen).toBe('puffer');
  });

  it('zählt jede Gruppe für sich', () => {
    const plan = filmZeitpunkte(drei, 10, 600, { gruppeJeStueck: [0, null, 1], max: 10 });
    expect(plan.zeitpunkte).toHaveLength(30);
  });

  it('zählt nahtlose Stücke derselben Gruppe zusammen', () => {
    const plan = filmZeitpunkte(
      [
        { vonMs: 0, bisMs: 600 },
        { vonMs: 600, bisMs: 1200 },
      ],
      10,
      600,
      { gruppeJeStueck: [0, 0], max: 10 },
    );
    expect(plan.zeitpunkte).toHaveLength(10);
    expect(plan.gekuerztWegen).toBe('puffer');
  });

  it('fängt nach einem Schnitt neu an zu zählen', () => {
    // Derselbe Gruppenname, aber ein Schnitt dazwischen: Beim Bauen sind das
    // zwei Gruppen, und die Grenze gilt für jede.
    const plan = filmZeitpunkte(
      [
        { vonMs: 0, bisMs: 600 },
        { vonMs: 3000, bisMs: 3600 },
      ],
      10,
      600,
      { gruppeJeStueck: [0, 0], max: 10 },
    );
    expect(plan.zeitpunkte).toHaveLength(12);
  });

  it('nennt die Filmgrenze, wenn die gegriffen hat', () => {
    const plan = filmZeitpunkte(drei, 10, 12, { gruppeJeStueck: [null, 0, null], max: 100 });
    expect(plan.zeitpunkte).toHaveLength(12);
    expect(plan.gekuerztWegen).toBe('gesamt');
  });
});

describe('abtasten', () => {
  it('kürzt über die Stücke hinweg und nicht in jedem einzeln', () => {
    /*
     * Wer die Grenze reisst, verliert das ENDE – nicht aus jedem Stück ein
     * Stückchen. Sonst wäre jedes Stück kürzer als gewählt, und zwar ohne
     * dass irgendwo stünde, warum.
     */
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 500 },
        { vonMs: 2000, bisMs: 2500 },
      ],
      schrittMs: 100,
      maxBilder: 7,
    });
    expect(plan.zeitpunkte).toEqual([0, 100, 200, 300, 400, 2000, 2100]);
    expect(plan.gekuerztMs).toBe(300);
    expect(plan.schnitte).toEqual([5]);
  });

  it('lässt ein Stück ganz weg, wenn die Grenze schon erreicht ist', () => {
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 500 },
        { vonMs: 2000, bisMs: 2500 },
      ],
      schrittMs: 100,
      maxBilder: 5,
    });
    expect(plan.zeitpunkte).toHaveLength(5);
    // Kein Schnitt, weil es das zweite Stück gar nicht in den Film schafft –
    // ein Schlüsselbild an einer Kante, die es nicht gibt, wäre verschenkt.
    expect(plan.schnitte).toEqual([]);
  });

  it('meldet eine NAHTLOSE Grenze nicht als Schnitt', () => {
    /*
     * Der Knopf „Stück hinzufügen" legt das neue Stück dort an, wo das
     * aktive aufhört – das ist der Normalfall. Dort läuft die Szene weiter.
     * Ein gemeldeter Schnitt setzte in `folgeTeile` die Lage auf die Ruhe
     * zurück, und ein Verlauf spränge mitten in einer durchgehenden
     * Einstellung an seine Ausgangsstelle.
     */
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 500 },
        { vonMs: 500, bisMs: 900 },
      ],
      schrittMs: 100,
      maxBilder: 50,
    });
    expect(plan.zeitpunkte).toEqual([0, 100, 200, 300, 400, 500, 600, 700, 800]);
    expect(plan.schnitte).toEqual([]);
  });

  it('meldet einen echten Sprung weiterhin als Schnitt', () => {
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 500 },
        { vonMs: 2000, bisMs: 2300 },
      ],
      schrittMs: 100,
      maxBilder: 50,
    });
    expect(plan.schnitte).toEqual([5]);
  });

  it('erkennt die Naht auch mit dem Versatz in die Bildmitte', () => {
    // Mit `mitte` liegen die Zeitpunkte um einen halben Schritt versetzt –
    // die Nahtprüfung muss denselben Versatz einrechnen, sonst meldet sie bei
    // JEDEM Filmstück einen Schnitt.
    const plan = filmZeitpunkte(
      [
        { vonMs: 0, bisMs: 400 },
        { vonMs: 400, bisMs: 800 },
      ],
      25,
      50,
    );
    expect(plan.schnitte).toEqual([]);
  });

  it('gibt auch ohne jedes Stück ein Bild zurück', () => {
    // `videoSchreiben` wirft bei null Bildern. Ein leerer Plan darf keine
    // Ausnahme auslösen, sondern muss ein Standbild ergeben.
    expect(abtasten({ stuecke: [], schrittMs: 40, maxBilder: 10 }).zeitpunkte).toHaveLength(1);
  });
});

describe('stueckTeilen', () => {
  const stueck = { vonMs: 200, bisMs: 800 };

  it('teilt ein Stück an der Stelle in zwei aufeinanderfolgende', () => {
    expect(stueckTeilen([stueck], 0, 500, 40)).toEqual([
      { vonMs: 200, bisMs: 500 },
      { vonMs: 500, bisMs: 800 },
    ]);
  });

  it('lässt andere Stücke in der Liste unangetastet', () => {
    const davor = { vonMs: 0, bisMs: 100 };
    const danach = { vonMs: 900, bisMs: 1000 };
    expect(stueckTeilen([davor, stueck, danach], 1, 500, 40)).toEqual([
      davor,
      { vonMs: 200, bisMs: 500 },
      { vonMs: 500, bisMs: 800 },
      danach,
    ]);
  });

  it('tut nichts, wenn die Stelle zu nah an einem Ende liegt', () => {
    // Ein Reststück unter `mindestMs` wäre eine Falle: Es liesse sich mit
    // denselben Werkzeugen nicht mehr sauber anfassen. Dieselbe Liste kommt
    // unverändert zurück (auch als Referenz), nicht bloss inhaltsgleich.
    const liste = [stueck];
    expect(stueckTeilen(liste, 0, 230, 40)).toBe(liste);
    expect(stueckTeilen(liste, 0, 770, 40)).toBe(liste);
  });

  it('tut nichts, wenn der Index nicht existiert', () => {
    const liste = [stueck];
    expect(stueckTeilen(liste, 5, 500, 40)).toBe(liste);
  });
});

describe('kannTeilen', () => {
  const stueck = { vonMs: 200, bisMs: 800 };

  it('erlaubt eine Stelle mit vollem Mindestabstand zu beiden Enden', () => {
    expect(kannTeilen(stueck, 240, 40)).toBe(true);
    expect(kannTeilen(stueck, 760, 40)).toBe(true);
  });

  it('lehnt eine Stelle zu nah an einem Ende ab', () => {
    expect(kannTeilen(stueck, 239, 40)).toBe(false);
    expect(kannTeilen(stueck, 761, 40)).toBe(false);
  });

  it('lehnt eine Stelle ausserhalb des Stücks ab', () => {
    expect(kannTeilen(stueck, 100, 40)).toBe(false);
    expect(kannTeilen(stueck, 900, 40)).toBe(false);
  });
});

describe('stueckJeBild', () => {
  it('ordnet jedes Bild seinem Stück zu – auch über eine nahtlose Grenze hinweg', () => {
    // Zwei Stücke, das zweite schliesst nahtlos an: kein Schnitt, aber zwei
    // Stücke mit womöglich verschiedener Bearbeitung.
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 300 },
        { vonMs: 300, bisMs: 500 },
        { vonMs: 1000, bisMs: 1200 },
      ],
      schrittMs: 100,
      maxBilder: 100,
      mitte: true,
    });
    expect(plan.schnitte).toEqual([5]);
    expect(plan.stueckJeBild).toEqual([0, 0, 0, 1, 1, 2, 2]);
  });

  it('lässt ein Stück aus, das wegen der Obergrenze kein Bild bekam', () => {
    const plan = abtasten({
      stuecke: [
        { vonMs: 0, bisMs: 300 },
        { vonMs: 1000, bisMs: 1200 },
      ],
      schrittMs: 100,
      maxBilder: 3,
    });
    expect(plan.stueckJeBild).toEqual([0, 0, 0]);
  });
});
