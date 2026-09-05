import { describe, expect, it } from 'vitest';
import {
  MASKEN_KANTE,
  abstandZuStrecke,
  maskeLesen,
  maskeTraegtEtwas,
  maskeUmrastern,
  naechsteMarke,
  radialGewicht,
  radialVorbereiten,
  rasterFuer,
  rasterNachOriginal,
  strichStempeln,
  teilBauen,
  teilSchluessel,
  teileFalten,
  verlaufGewicht,
  verlaufVorbereiten,
  type Raster,
} from './maske.js';
import type { Maskenmodus, Maskenteil, Pinselstrich, Punkt, VerlaufTeil } from './doc.js';

/** Der Verlaufsteil in seiner engen Form – so nimmt ihn auch `verlaufVorbereiten`. */
type VerlaufMaske = { id: string; modus: Maskenmodus; umkehren: boolean } & VerlaufTeil;

/* ---------- Bausteine ---------- */

function verlaufTeil(werte: {
  von?: Punkt;
  bis?: Punkt;
  id?: string;
  modus?: Maskenmodus;
  umkehren?: boolean;
}): VerlaufMaske {
  return {
    id: werte.id ?? 'v1',
    modus: werte.modus ?? 'dazu',
    umkehren: werte.umkehren ?? false,
    art: 'verlauf',
    von: werte.von ?? { x: 0, y: 0 },
    bis: werte.bis ?? { x: 100, y: 0 },
  };
}

function radialVor(werte: {
  mitte?: Punkt;
  rx?: number;
  ry?: number;
  winkel?: number;
  weichheit?: number;
}) {
  return radialVorbereiten({
    art: 'radial',
    mitte: werte.mitte ?? { x: 0, y: 0 },
    rx: werte.rx ?? 40,
    ry: werte.ry ?? 10,
    winkel: werte.winkel ?? 0,
    weichheit: werte.weichheit ?? 1,
  });
}

function pinselTeil(
  werte: {
    id?: string;
    modus?: Maskenmodus;
    umkehren?: boolean;
    punkte?: number[];
    breite?: number;
    haerte?: number;
    abziehen?: boolean;
    striche?: Pinselstrich[];
  } = {},
): Maskenteil {
  const strich: Pinselstrich = {
    punkte: werte.punkte ?? [0, 0, 5, 5],
    breite: werte.breite ?? 20,
    haerte: werte.haerte ?? 0.5,
    abziehen: werte.abziehen ?? false,
  };
  return {
    id: werte.id ?? 'p1',
    modus: werte.modus ?? 'dazu',
    umkehren: werte.umkehren ?? false,
    art: 'pinsel',
    striche: werte.striche ?? [strich],
  };
}

function netzTeil(
  werte: {
    id?: string;
    modus?: Maskenmodus;
    umkehren?: boolean;
    netz?: 'person' | 'object';
    breite?: number;
    hoehe?: number;
    alpha?: Uint8Array;
    marke?: number;
  } = {},
): Maskenteil {
  return {
    id: werte.id ?? 'n1',
    modus: werte.modus ?? 'dazu',
    umkehren: werte.umkehren ?? false,
    art: 'netz',
    netz: werte.netz ?? 'person',
    breite: werte.breite ?? 4,
    hoehe: werte.hoehe ?? 4,
    alpha: werte.alpha ?? new Uint8Array(16).fill(200),
    marke: werte.marke ?? 7,
  };
}

function tiefenTeil(
  werte: {
    id?: string;
    modus?: Maskenmodus;
    umkehren?: boolean;
    breite?: number;
    hoehe?: number;
    karte?: Uint8Array;
    fokus?: number;
    spanne?: number;
    marke?: number;
  } = {},
): Maskenteil {
  return {
    id: werte.id ?? 'd1',
    modus: werte.modus ?? 'dazu',
    umkehren: werte.umkehren ?? false,
    art: 'tiefe',
    breite: werte.breite ?? 4,
    hoehe: werte.hoehe ?? 4,
    // Vorgabe: von hinten (0) nach vorne (255) über die Breite.
    karte:
      werte.karte ?? Uint8Array.from({ length: 16 }, (_wert, i) => Math.round(((i % 4) / 3) * 255)),
    fokus: werte.fokus ?? 1,
    spanne: werte.spanne ?? 0.5,
    marke: werte.marke ?? 11,
  };
}

/** Eine harte Scheibe mit Radius 8 um (x, 20) – im Raster mit Faktor 1. */
function scheibe(id: string, modus: Maskenmodus, x: number): Maskenteil {
  return pinselTeil({ id, modus, punkte: [x, 20], breite: 16, haerte: 1 });
}

/* ---------- das Raster ---------- */

describe('rasterFuer', () => {
  it('bringt die längste Kante auf die Rasterkante', () => {
    // Mutation: die KÜRZERE Kante begrenzen – dann käme 1365 × 1024 heraus,
    // 78 % mehr Speicher als die Obergrenze zulässt: 1365 x 1024 sind
    // 1 397 760 Bytes gegen 1024 x 768 = 786 432. (Das Drittel gilt fuer
    // die KANTE, nicht fuer die Flaeche.)
    const r = rasterFuer(4000, 3000);
    expect(r.breite).toBe(1024);
    expect(r.hoehe).toBe(768);
    expect(r.faktor).toBeCloseTo(0.256, 12);
  });

  it('vergrössert nie', () => {
    // Mutation: `Math.min(1, …)` weglassen – ein 500 × 400-Bild bekäme ein
    // Raster von 1024 × 819 und damit das Vierfache an Speicher für nichts.
    const r = rasterFuer(500, 400);
    expect(r.breite).toBe(500);
    expect(r.hoehe).toBe(400);
    expect(r.faktor).toBe(1);
  });

  it('rechnet Rasterpunkte auf ihre Mitten um', () => {
    /*
     * Bei Faktor 0,25 deckt ein Rasterpunkt vier Originalpunkte ab; seine
     * Mitte liegt bei 1,5 und die des letzten bei 397,5 – beide gleich weit
     * vom jeweiligen Rand.
     *
     * Mutation: das `+ 0,5 … − 0,5` streichen. Dann steht der erste Punkt auf
     * 0 und der letzte auf 396, die Maske sitzt also um zwei Originalpunkte
     * verschoben und wird zum Rand hin unsymmetrisch.
     */
    const r = rasterFuer(400, 400, 100);
    const erster = rasterNachOriginal(r, 0, 0);
    const letzter = rasterNachOriginal(r, r.breite - 1, r.hoehe - 1);
    expect(erster.x).toBeCloseTo(1.5, 12);
    expect(erster.y).toBeCloseTo(1.5, 12);
    expect(letzter.x).toBeCloseTo(397.5, 12);
  });
});

/* ---------- Verlauf ---------- */

describe('verlaufGewicht', () => {
  it('ist 0 am Anfangsgriff, 1 am Endgriff und 0,5 dazwischen', () => {
    // Mutation: `von` und `bis` vertauschen – dann liegt die 1 am
    // Anfangsgriff, und jeder Verlauf wirkt spiegelverkehrt zu den Griffen.
    const v = verlaufVorbereiten(verlaufTeil({ von: { x: 20, y: 10 }, bis: { x: 120, y: 10 } }));
    expect(verlaufGewicht(v, 20, 10)).toBeCloseTo(0, 12);
    expect(verlaufGewicht(v, 120, 10)).toBeCloseTo(1, 12);
    expect(verlaufGewicht(v, 70, 10)).toBeCloseTo(0.5, 12);
  });

  it('ist auf jeder Senkrechten zur Achse konstant', () => {
    /*
     * Mutation: statt der Projektion den ABSTAND zum Anfangsgriff nehmen. Die
     * Prüfung darüber bliebe grün – auf der Achse selbst sind beide Rechnungen
     * gleich –, hier fielen die drei Werte auseinander, weil aus dem Verlauf
     * ein Ring um den Anfangsgriff geworden wäre.
     */
    const v = verlaufVorbereiten(verlaufTeil({ von: { x: 0, y: 0 }, bis: { x: 100, y: 0 } }));
    const mitte = verlaufGewicht(v, 50, 0);
    expect(verlaufGewicht(v, 50, -30)).toBeCloseTo(mitte, 12);
    expect(verlaufGewicht(v, 50, 70)).toBeCloseTo(mitte, 12);
    expect(mitte).toBeCloseTo(0.5, 12);
  });

  it('gibt bei zusammenfallenden Griffen 1 zurück statt NaN', () => {
    // Mutation: die Abfrage auf `laenge2 === 0` streichen. 0/0 ist NaN,
    // `weich` reicht NaN durch, und `Math.round(NaN * 255)` wird im
    // Uint8Array zu 0 – die Maske wäre im ersten Zeigerschritt schwarz.
    const v = verlaufVorbereiten(verlaufTeil({ von: { x: 7, y: 7 }, bis: { x: 7, y: 7 } }));
    const g = verlaufGewicht(v, 99, -5);
    expect(Number.isNaN(g)).toBe(false);
    expect(g).toBe(1);
  });
});

/* ---------- Ellipse ---------- */

describe('radialGewicht', () => {
  it('ist 1 in der Mitte und 0 auf und ausserhalb der Ellipse', () => {
    // Mutation: `1 − weich(…)` durch `weich(…)` ersetzen – die Maske wäre
    // überall dort offen, wo die Ellipse gerade NICHT liegt.
    const v = radialVor({ mitte: { x: 100, y: 50 }, rx: 40, ry: 10 });
    expect(radialGewicht(v, 100, 50)).toBeCloseTo(1, 12);
    expect(radialGewicht(v, 140, 50)).toBeCloseTo(0, 12);
    expect(radialGewicht(v, 300, 50)).toBeCloseTo(0, 12);
    expect(radialGewicht(v, 100, 60)).toBeCloseTo(0, 12);
  });

  it('unterscheidet die beiden Halbachsen und fällt auf beiden monoton', () => {
    /*
     * Mutation: `rx` und `ry` in der Normierung vertauschen. Der Punkt 20
     * nach rechts liegt dann bei d = 2 statt d = 0,5 und wäre 0 statt 0,5 –
     * eine liegende Ellipse stünde hochkant.
     */
    const v = radialVor({ rx: 40, ry: 10, weichheit: 1 });
    expect(radialGewicht(v, 20, 0)).toBeCloseTo(0.5, 12);
    expect(radialGewicht(v, 0, 5)).toBeCloseTo(0.5, 12);
    expect(radialGewicht(v, 0, 20)).toBeCloseTo(0, 12);

    let vorher = Infinity;
    for (const t of [0, 0.25, 0.5, 0.75, 1]) {
      const laengs = radialGewicht(v, 40 * t, 0);
      const quer = radialGewicht(v, 0, 10 * t);
      expect(laengs).toBeLessThan(vorher);
      expect(quer).toBeCloseTo(laengs, 12);
      vorher = laengs;
    }
  });

  it('ist um eine Vierteldrehung gedreht dasselbe wie mit getauschten Halbachsen', () => {
    // Mutation: die Drehung ganz weglassen – dann bliebe die Ellipse liegen,
    // während der Winkelgriff sich dreht.
    const gedreht = radialVor({ rx: 40, ry: 10, winkel: Math.PI / 2 });
    const getauscht = radialVor({ rx: 10, ry: 40, winkel: 0 });
    for (const p of [
      [7, 0],
      [0, 13],
      [5, 21],
      [-30, -4],
    ] as const) {
      expect(radialGewicht(gedreht, p[0], p[1])).toBeCloseTo(
        radialGewicht(getauscht, p[0], p[1]),
        12,
      );
    }
  });

  it('dreht den Weltpunkt in das Bezugssystem der Ellipse zurück', () => {
    /*
     * Wer die Ellipse um `winkel` dreht und den Prüfpunkt mit ihr, muss
     * dasselbe Gewicht bekommen wie ohne beides. Das geht nur auf, wenn
     * `radialVorbereiten` mit MINUS dem Winkel rechnet.
     *
     * Mutation: `+winkel` statt `−winkel`. Bei 0 bleibt das unsichtbar,
     * deshalb stehen hier drei Winkel – bei 0,4 dreht die Maske dann um den
     * doppelten Betrag in die falsche Richtung.
     */
    const mitte = { x: 12, y: -5 };
    const versatz = { x: 18, y: 3 };
    const ohne = radialVor({ mitte, rx: 40, ry: 10, winkel: 0 });
    const gerade = radialGewicht(ohne, mitte.x + versatz.x, mitte.y + versatz.y);
    for (const winkel of [0, 0.4, 1.2]) {
      const v = radialVor({ mitte, rx: 40, ry: 10, winkel });
      const c = Math.cos(winkel);
      const s = Math.sin(winkel);
      const x = mitte.x + versatz.x * c - versatz.y * s;
      const y = mitte.y + versatz.x * s + versatz.y * c;
      expect(radialGewicht(v, x, y)).toBeCloseTo(gerade, 12);
    }
    // Ohne diese Zeile wäre der Vergleich beliebig erfüllbar (etwa mit 0).
    expect(gerade).toBeGreaterThan(0.1);
    expect(gerade).toBeLessThan(0.9);
  });

  it('macht aus Weichheit 0,02 eine fast harte Kante', () => {
    /*
     * Der Abfall beginnt bei `innen = 1 − weichheit`, also erst bei 0,98 des
     * Radius: vier Hundertstel vor der Ellipsengrenze noch voll offen, ein
     * Hundertstel dahinter schon zu.
     *
     * Mutation: die Umkehrung vergessen und `innen = weichheit` rechnen. Dann
     * liefe der Abfall von 0,02 bis 1, bei 0,97 stünden noch 2 statt 255 – der
     * Regler täte am Anschlag genau das Gegenteil dessen, was er verspricht.
     */
    const v = radialVor({ rx: 100, ry: 100, weichheit: 0.02 });
    expect(Math.round(radialGewicht(v, 97, 0) * 255)).toBeGreaterThan(240);
    expect(Math.round(radialGewicht(v, 101, 0) * 255)).toBeLessThan(15);
  });

  it('begrenzt die Weichheit nach unten', () => {
    /*
     * Mutation: die untere Grenze von 0,02 auf 0 aufmachen. Ein Regler, der
     * die 0 durchreicht, ergäbe `innen = 1`; `weich` weicht bei gleicher
     * Ober- und Untergrenze auf eine Spanne von 1 aus, und aus der härtesten
     * Kante würde der flachste denkbare Abfall – ein Punkt hinter der Ellipse
     * stünde dann noch auf 255 statt auf 0.
     */
    const v = radialVor({ rx: 100, ry: 100, weichheit: 0 });
    expect(Math.round(radialGewicht(v, 97, 0) * 255)).toBeGreaterThan(240);
    expect(Math.round(radialGewicht(v, 101, 0) * 255)).toBeLessThan(15);
  });
});

/* ---------- Pinsel ---------- */

describe('abstandZuStrecke', () => {
  it('misst zur Strecke und nicht zur Geraden', () => {
    /*
     * Mutation: die Begrenzung von `t` auf 0 … 1 streichen. Der Punkt (−10, 0)
     * bekäme dann den Abstand 0 statt 10, weil er auf der VERLÄNGERUNG liegt –
     * ein Pinselstrich liefe über den Bildrand hinaus weiter.
     */
    expect(abstandZuStrecke(-10, 0, 0, 0, 100, 0)).toBeCloseTo(10, 12);
    expect(abstandZuStrecke(130, 0, 0, 0, 100, 0)).toBeCloseTo(30, 12);
    expect(abstandZuStrecke(50, 8, 0, 0, 100, 0)).toBeCloseTo(8, 12);
    // Entartete Strecke: der blosse Abstand zum Punkt, kein NaN.
    expect(abstandZuStrecke(3, 4, 0, 0, 0, 0)).toBeCloseTo(5, 12);
  });
});

describe('strichStempeln', () => {
  it('rechnet den Pinselradius ins Raster um', () => {
    /*
     * Faktor 0,25 und Breite 80 heissen Radius 10 IM RASTER, nicht 40.
     *
     * Mutation: `raster.faktor` beim Radius vergessen. Dann stünde bei
     * (85, 50) noch Farbe, und die Scheibe hätte gut 5000 statt rund 300
     * Rasterpunkte – der Pinsel wäre auf einem grossen Foto viermal zu dick.
     */
    const raster = rasterFuer(400, 400, 100);
    expect(raster.faktor).toBe(0.25);
    const feld = new Uint8Array(raster.breite * raster.hoehe);
    // 201,5 ist genau die Mitte des Rasterpunkts 50.
    strichStempeln(feld, raster, {
      punkte: [201.5, 201.5],
      breite: 80,
      haerte: 1,
      abziehen: false,
    });

    expect(feld[50 * 100 + 50]).toBe(255);
    expect(feld[50 * 100 + 59]).toBe(255);
    expect(feld[50 * 100 + 60]).toBe(0);
    expect(feld[50 * 100 + 85]).toBe(0);

    let gesetzt = 0;
    for (const wert of feld) if (wert > 0) gesetzt += 1;
    // Die Kreisfläche mit Radius 10 sind rund 314 Rasterpunkte.
    expect(gesetzt).toBeGreaterThan(280);
    expect(gesetzt).toBeLessThan(330);
  });

  it('radiert weg, was gemalt wurde, und malt zurück, was radiert wurde', () => {
    // Mutation: `+=` und `−=` statt `max`/`min`. Malen und Radieren träfen
    // sich dann nie bei glatten 0 beziehungsweise 255.
    const raster = rasterFuer(20, 20);
    const malen: Pinselstrich = { punkte: [10, 10], breite: 8, haerte: 1, abziehen: false };
    const radieren: Pinselstrich = { ...malen, abziehen: true };
    const i = 10 * 20 + 10;

    const a = new Uint8Array(400);
    strichStempeln(a, raster, malen);
    strichStempeln(a, raster, radieren);
    expect(a[i]).toBe(0);

    const b = new Uint8Array(400);
    strichStempeln(b, raster, radieren);
    strichStempeln(b, raster, malen);
    expect(b[i]).toBe(255);
  });

  it('senkt mit einem zweiten Strich keinen Wert und übersteigt nie 255', () => {
    /*
     * Mutation: `+=` statt `max`. Ein Uint8Array rechnet modulo 256, aus
     * 200 + 100 würden 44 – die Stelle, an der zwei Striche sich kreuzen,
     * bekäme ein dunkles Loch statt voller Deckung.
     */
    const raster = rasterFuer(30, 30);
    const feld = new Uint8Array(900);
    strichStempeln(feld, raster, {
      punkte: [10, 15, 20, 15],
      breite: 12,
      haerte: 1,
      abziehen: false,
    });
    const vorher = feld.slice();
    strichStempeln(feld, raster, {
      punkte: [15, 8, 15, 22],
      breite: 12,
      haerte: 0,
      abziehen: false,
    });
    for (let k = 0; k < feld.length; k += 1) {
      expect(feld[k]).toBeGreaterThanOrEqual(vorher[k]);
      expect(feld[k]).toBeLessThanOrEqual(255);
    }
    expect(feld[15 * 30 + 15]).toBe(255);
  });

  it('ergibt fortgeschrieben Byte für Byte dasselbe wie in einem Zug', () => {
    /*
     * Mutation: bei `abIndex` statt bei `abIndex − 1` anfangen. Der Abschnitt
     * vom letzten schon gestempelten Punkt zum ersten neuen fehlte dann, und
     * in jeden gemalten Strich risse je Zeigerereignis eine Lücke.
     */
    const raster = rasterFuer(60, 60);
    const punkte = [10, 10, 20, 15, 30, 10, 40, 20, 50, 15];
    const ganz: Pinselstrich = { punkte, breite: 9, haerte: 0.4, abziehen: false };

    const a = new Uint8Array(3600);
    strichStempeln(a, raster, ganz);

    const b = new Uint8Array(3600);
    strichStempeln(b, raster, { ...ganz, punkte: punkte.slice(0, 6) });
    strichStempeln(b, raster, ganz, 3);

    expect(b).toEqual(a);
    expect(maskeTraegtEtwas(a)).toBe(true);
  });
});

/* ---------- Teile falten ---------- */

describe('teileFalten', () => {
  const raster = rasterFuer(40, 40);
  const nurA = 20 * 40 + 10;
  const beide = 20 * 40 + 20;
  const nurB = 20 * 40 + 30;

  it('vereinigt bei „dazu“', () => {
    // Mutation: mit `min` falten – aus der Vereinigung würde der Schnitt, und
    // zwei getrennte Scheiben ergäben gar keine Maske.
    const feld = teileFalten([scheibe('a', 'dazu', 14), scheibe('b', 'dazu', 26)], raster);
    expect(feld[nurA]).toBe(255);
    expect(feld[beide]).toBe(255);
    expect(feld[nurB]).toBe(255);
  });

  it('zieht bei „weg“ ab', () => {
    // Mutation: alles mit `max` falten – die Überschneidung bliebe offen, und
    // „Motiv ohne Schatten“ wäre wieder Motiv mit Schatten.
    const feld = teileFalten([scheibe('a', 'dazu', 14), scheibe('b', 'weg', 26)], raster);
    expect(feld[nurA]).toBe(255);
    expect(feld[beide]).toBe(0);
    expect(feld[nurB]).toBe(0);
  });

  it('schneidet bei „nur“', () => {
    // Mutation: `nur` wie `dazu` behandeln – dann bliebe auch der Teil offen,
    // den der Schnitt gerade wegnehmen soll.
    const feld = teileFalten([scheibe('a', 'dazu', 14), scheibe('b', 'nur', 26)], raster);
    expect(feld[nurA]).toBe(0);
    expect(feld[beide]).toBe(255);
    expect(feld[nurB]).toBe(0);
  });

  it('hängt von der Reihenfolge der Teile ab', () => {
    /*
     * Erst abziehen, dann hinzufügen ist etwas anderes als umgekehrt: Auf dem
     * leeren Feld hat das Abziehen nichts, was es abziehen könnte.
     *
     * Mutation: die Teile vor dem Falten sortieren oder alle mit `max`
     * verrechnen – dann käme zweimal dasselbe heraus.
     */
    const a = scheibe('a', 'dazu', 14);
    const b = scheibe('b', 'weg', 26);
    expect(teileFalten([a, b], raster)[beide]).toBe(0);
    expect(teileFalten([b, a], raster)[beide]).toBe(255);
  });

  it('liefert ohne Teile lauter Nullen', () => {
    // Mutation: mit 255 anfangen – ein frisch angelegter Bereich läge sofort
    // über dem ganzen Bild, bevor der erste Griff gezogen ist.
    const feld = teileFalten([], raster);
    expect(feld.length).toBe(1600);
    expect(maskeTraegtEtwas(feld)).toBe(false);
  });
});

describe('teilBauen', () => {
  it('kehrt bei `umkehren` jeden Wert um', () => {
    // Mutation: `umkehren` erst NACH dem Falten anwenden statt je Teil – ein
    // umgekehrter Teil im Modus `weg` wirkte dann genau verkehrt herum.
    const raster = rasterFuer(10, 1);
    const gerade = teilBauen(verlaufTeil({ bis: { x: 10, y: 0 } }), raster);
    const gekehrt = teilBauen(verlaufTeil({ bis: { x: 10, y: 0 }, umkehren: true }), raster);
    for (let i = 0; i < gerade.length; i += 1) expect(gerade[i] + gekehrt[i]).toBe(255);
    expect(gerade[0]).toBeLessThan(gerade[9]);
  });

  it('bringt eine Netzmaske auf das Raster', () => {
    // Mutation: das Netzfeld ungerastert durchreichen – die Länge passte
    // nicht zum Raster, und der Rest der Maske bliebe stumm auf 0.
    const raster = rasterFuer(20, 20);
    const feld = teilBauen(netzTeil({ breite: 4, hoehe: 4 }), raster);
    expect(feld.length).toBe(400);
    expect(feld[0]).toBe(200);
  });
});

/* ---------- Umrastern und Lesen ---------- */

describe('maskeUmrastern', () => {
  it('lässt ein gleichmässiges Feld gleichmässig', () => {
    // Mutation: über den Rand hinaus lesen statt zu begrenzen – `undefined`
    // wird zu NaN und im Uint8Array zu 0, also ein dunkler Saum rundherum.
    const quelle = new Uint8Array(3 * 5).fill(140);
    const ziel = maskeUmrastern(quelle, 3, 5, 7, 11);
    expect(ziel.length).toBe(77);
    for (const wert of ziel) expect(wert).toBe(140);
  });

  it('rechnet beim Vergrössern auf Punktmitten', () => {
    /*
     * Eine 2 × 2-Maske mit dunkler linker und heller rechter Spalte, auf 8 × 8
     * gezogen: Die beiden äusseren Spalten liegen ausserhalb der Quellmitten
     * und werden begrenzt, dazwischen läuft die Rampe symmetrisch durch.
     *
     * Mutation: das `+ 0,5 … − 0,5` streichen. Dann stünde in Spalte 1 schon
     * 64 statt 0, die Rampe wäre um einen halben Quellpunkt nach links
     * verschoben und die Symmetrie dahin.
     */
    const quelle = new Uint8Array([0, 255, 0, 255]);
    const ziel = maskeUmrastern(quelle, 2, 2, 8, 8);
    const zeile = Array.from(ziel.slice(0, 8));
    expect(zeile[0]).toBe(0);
    expect(zeile[1]).toBe(0);
    expect(zeile[6]).toBe(255);
    expect(zeile[7]).toBe(255);
    for (let i = 0; i < 8; i += 1) expect(zeile[i] + zeile[7 - i]).toBe(255);
    for (let i = 1; i < 8; i += 1) expect(zeile[i]).toBeGreaterThanOrEqual(zeile[i - 1]);
    // Jede Zeile ist dieselbe – die Achsen werden getrennt gerechnet.
    expect(Array.from(ziel.slice(24, 32))).toEqual(zeile);
  });
});

describe('maskeLesen', () => {
  const raster: Raster = { breite: 2, hoehe: 2, faktor: 1 };
  const feld = new Uint8Array([0, 100, 200, 255]);

  it('trifft auf den Punktmitten genau die Feldwerte', () => {
    // Mutation: das `− 0,5` weglassen – bei u = 0,25 läse man dann zwischen
    // zwei Punkten. Nachgerechnet mit Feld [0,100,200,255] auf 2x2:
    // Ohne das "− 0,5" liest man bei 0,5/0,5 und bekommt 138,75 statt 0.
    expect(maskeLesen(feld, raster, 0.25, 0.25)).toBeCloseTo(0, 12);
    expect(maskeLesen(feld, raster, 0.75, 0.25)).toBeCloseTo(100, 12);
    expect(maskeLesen(feld, raster, 0.25, 0.75)).toBeCloseTo(200, 12);
    expect(maskeLesen(feld, raster, 0.75, 0.75)).toBeCloseTo(255, 12);
  });

  it('mischt zwischen den Punktmitten linear und hält am Rand', () => {
    // Mutation: nächster Nachbar statt bilinear – in der Mitte käme 0 oder
    // 100 heraus statt 50, und die Maske bekäme auf dem Bildschirm Treppen.
    expect(maskeLesen(feld, raster, 0.5, 0.25)).toBeCloseTo(50, 12);
    expect(maskeLesen(feld, raster, 0.25, 0.5)).toBeCloseTo(100, 12);
    // Ausserhalb der äussersten Mitten wird gehalten, nicht extrapoliert.
    expect(maskeLesen(feld, raster, 0, 0)).toBeCloseTo(0, 12);
    expect(maskeLesen(feld, raster, 1, 1)).toBeCloseTo(255, 12);
  });
});

/* ---------- Kennungen ---------- */

describe('teilSchluessel', () => {
  it('ändert sich bei jedem bildwirksamen Feld', () => {
    /*
     * Mutation: irgendeines der aufgezählten Felder aus dem Schlüssel
     * streichen. Der Zwischenspeicher gäbe dann nach dieser Änderung die alte
     * Maske heraus – ohne Fehler, nur mit dem falschen Bild.
     */
    const teile: Maskenteil[] = [
      verlaufTeil({}),
      verlaufTeil({ id: 'v2' }),
      verlaufTeil({ modus: 'weg' }),
      verlaufTeil({ umkehren: true }),
      verlaufTeil({ von: { x: 1, y: 0 } }),
      verlaufTeil({ bis: { x: 100, y: 1 } }),
      pinselTeil(),
      pinselTeil({ breite: 21 }),
      pinselTeil({ haerte: 0.6 }),
      pinselTeil({ abziehen: true }),
      pinselTeil({ punkte: [0, 0, 5, 5, 9, 9] }),
      pinselTeil({
        striche: [
          { punkte: [0, 0, 5, 5], breite: 20, haerte: 0.5, abziehen: false },
          { punkte: [1, 1], breite: 20, haerte: 0.5, abziehen: false },
        ],
      }),
      netzTeil(),
      netzTeil({ marke: 8 }),
      netzTeil({ netz: 'object' }),
      netzTeil({ breite: 5, hoehe: 3 }),
    ];
    const schluessel = teile.map(teilSchluessel);
    expect(new Set(schluessel).size).toBe(teile.length);
  });

  it('bleibt für eine gleich aufgebaute Kopie derselbe', () => {
    // Mutation: eine laufende Nummer oder `Date.now()` einmischen – dann
    // wäre jeder Schlüssel neu und der Zwischenspeicher nie ein Treffer.
    expect(teilSchluessel(pinselTeil())).toBe(teilSchluessel(pinselTeil()));
    expect(teilSchluessel(netzTeil())).toBe(teilSchluessel(netzTeil()));
  });

  it('schreibt für ein Netzteil die Marke und nie das Feld selbst', () => {
    /*
     * Mutation: `alpha` in die Schablone setzen. Es würde klaglos zu
     * `[object Uint8Array]`, wäre für JEDE Netzmaske dasselbe, und der
     * Zwischenspeicher lieferte nach einem neuen Netzlauf die alte Maske.
     */
    const schluessel = teilSchluessel(netzTeil({ marke: 42 }));
    expect(schluessel).not.toContain('[object');
    expect(schluessel).toContain('42');
    const anderes = netzTeil({ marke: 43, alpha: new Uint8Array(16).fill(200) });
    expect(teilSchluessel(anderes)).not.toBe(schluessel);
  });
});

describe('maskeTraegtEtwas', () => {
  it('unterscheidet die leere Maske von jeder anderen', () => {
    // Mutation: `> 0` zu `> 128` – eine schwach, aber überall wirkende Maske
    // fiele unter den Tisch, und der Bereich würde stumm übersprungen.
    expect(maskeTraegtEtwas(new Uint8Array(16))).toBe(false);
    const kaum = new Uint8Array(16);
    kaum[9] = 1;
    expect(maskeTraegtEtwas(kaum)).toBe(true);
  });
});

describe('naechsteMarke', () => {
  it('steigt über 1000 Aufrufe streng', () => {
    // Mutation: den Zähler zurücksetzen oder eine Zufallszahl liefern – zwei
    // Netzmasken bekämen dieselbe Ersatzidentität, und der Zwischenspeicher
    // hielte sie für dieselbe Maske.
    let vorher = naechsteMarke();
    for (let i = 0; i < 1000; i += 1) {
      const jetzt = naechsteMarke();
      expect(jetzt).toBeGreaterThan(vorher);
      vorher = jetzt;
    }
  });
});

/*
 * Nachgereichte Prüfungen.
 *
 * Sie stammen aus einer Gegenprüfung, die die behaupteten Mutationen wirklich
 * ausgeführt hat – und dabei fand, dass fünfzehn davon gar nicht rot wurden.
 * Die Rechnung war jedes Mal richtig; geprüft war sie nicht. Das ist die
 * gefährlichere Hälfte: Eine Prüfung, die nicht fallen kann, sieht im
 * Testbericht genauso grün aus wie eine, die etwas beweist.
 */
describe('nachgereicht: die senkrechte Achse', () => {
  it('rechnet einen SENKRECHTEN Verlauf richtig', () => {
    /*
     * Die grösste Lücke von allen. Alle bisherigen Verlaufsprüfungen liefen
     * waagerecht (`von` und `bis` mit gleichem y), damit war `dy` immer null.
     * Nachgemessen: Streicht man den ganzen dy-Term aus der Projektion,
     * bleiben alle 33 Prüfungen grün – und ein Verlauf von oben nach unten,
     * also der häufigste überhaupt (Himmel abdunkeln), wäre überall 0 und
     * täte gar nichts.
     */
    const v = verlaufVorbereiten({ art: 'verlauf', von: { x: 0, y: 0 }, bis: { x: 0, y: 100 } });
    expect(verlaufGewicht(v, 0, 0)).toBeCloseTo(0, 9);
    expect(verlaufGewicht(v, 0, 50)).toBeCloseTo(0.5, 9);
    expect(verlaufGewicht(v, 0, 100)).toBeCloseTo(1, 9);
    // Und quer zur Achse ändert sich nichts.
    expect(verlaufGewicht(v, 900, 50)).toBeCloseTo(0.5, 9);
  });

  it('rechnet einen schrägen Verlauf in beiden Achsen', () => {
    // Diagonal von (0,0) nach (100,100): Der Punkt (100,0) liegt auf halber
    // Strecke, weil nur die Projektion auf die Achse zählt.
    const v = verlaufVorbereiten({ art: 'verlauf', von: { x: 0, y: 0 }, bis: { x: 100, y: 100 } });
    expect(verlaufGewicht(v, 100, 0)).toBeCloseTo(0.5, 9);
    expect(verlaufGewicht(v, 0, 100)).toBeCloseTo(0.5, 9);
    expect(verlaufGewicht(v, 100, 100)).toBeCloseTo(1, 9);
  });

  it('rechnet auch die y-Achse eines Rasterpunkts auf ihre Mitte um', () => {
    // Nachgemessen: `y` aus `gx` zu rechnen liess alle 33 Prüfungen grün.
    // Bei einem 4000×3000-Foto bekäme damit jede Zeile denselben
    // Originalwert – jeder Verlauf und jede Ellipse verlören ihre ganze
    // senkrechte Ausdehnung, die Maske wäre ein senkrechter Streifen.
    const r = rasterFuer(800, 400, 100);
    expect(r.breite).toBe(100);
    expect(r.hoehe).toBe(50);
    const oben = rasterNachOriginal(r, 10, 0);
    const unten = rasterNachOriginal(r, 10, 49);
    expect(oben.x).toBeCloseTo(unten.x, 9);
    expect(oben.y).toBeLessThan(unten.y);
    expect(unten.y - oben.y).toBeCloseTo(49 / r.faktor, 6);
  });

  it('zieht eine Netzmaske senkrecht richtig auf, ohne sie zu spiegeln', () => {
    /*
     * Auch hier liessen zwei Mutationen alle Prüfungen grün: die Punktmitten
     * der y-Achse streichen und das Ziel senkrecht spiegeln. Die zweite ist
     * die teure – eine freigestellte Person stünde auf dem Kopf.
     *
     * Die bisherigen Prüfungen nahmen ein konstantes Feld und eines, dessen
     * beide Zeilen gleich waren; da liefert jede y-Behandlung dasselbe.
     */
    const quelle = new Uint8Array([0, 0, 255, 255]); // obere Zeile 0, untere 255
    const raus = maskeUmrastern(quelle, 2, 2, 4, 8);
    expect(raus).toHaveLength(32);
    // Oben dunkel, unten hell – nicht umgekehrt.
    expect(raus[0]).toBe(0);
    expect(raus[31]).toBe(255);
    expect(raus[0]).toBeLessThan(raus[31]);
    // Und dazwischen steigt es monoton.
    for (let j = 1; j < 8; j += 1) {
      expect(raus[j * 4]).toBeGreaterThanOrEqual(raus[(j - 1) * 4]);
    }
    /*
     * Und zwar an den richtigen Stellen. Der Quellpunkt zu Zielzeile j ist
     * `(j + 0,5)·2/8 − 0,5`, also 0,25·j − 0,375. Für j = 3 sind das 0,375,
     * und zwischen den Quellzeilen 0 und 255 ergibt das rund 96.
     *
     * Ohne die Punktmitten läse man bei 0,25·j = 0,75 und bekäme 191. Die
     * Monotonie allein sieht das nicht; deshalb ein fester Wert.
     */
    expect(raus[3 * 4]).toBeGreaterThan(88);
    expect(raus[3 * 4]).toBeLessThan(104);
  });
});

describe('nachgereicht: teilBauen deckt alle vier Arten', () => {
  const raster = { breite: 40, hoehe: 30, faktor: 0.1 };

  it('füllt das Feld für eine Ellipse wirklich', () => {
    // Nachgemessen: `radialFeld` durch lauter Nullen zu ersetzen liess alle
    // 33 Prüfungen grün. `radialGewicht` allein beweist nichts darüber, ob
    // das Feld je damit gefüllt wird – jede Ellipsenmaske wäre leer gewesen,
    // der Bereich wirkte nirgends.
    const feld = teilBauen(
      {
        id: 'r',
        modus: 'dazu',
        umkehren: false,
        art: 'radial',
        mitte: { x: 200, y: 150 },
        rx: 100,
        ry: 100,
        winkel: 0,
        weichheit: 0.5,
      },
      raster,
    );
    // In der Mitte voll, in der Ecke nichts.
    expect(feld[15 * 40 + 20]).toBeGreaterThan(240);
    expect(feld[0]).toBe(0);
    expect(maskeTraegtEtwas(feld)).toBe(true);
  });

  it('kehrt auch einen Pinsel- und einen Netzteil um, nicht nur einen Verlauf', () => {
    // Nachgemessen: `if (teil.umkehren && teil.art === 'verlauf')` liess alle
    // 33 Prüfungen grün. „Alles ausser der Person“ hätte dann die Person
    // ergeben.
    const netz = {
      id: 'n',
      modus: 'dazu' as const,
      umkehren: true,
      art: 'netz' as const,
      netz: 'object' as const,
      breite: 2,
      hoehe: 2,
      alpha: new Uint8Array([255, 255, 255, 255]),
      marke: 1,
    };
    const feld = teilBauen(netz, raster);
    expect(feld[0]).toBe(0);
    expect(feld[feld.length - 1]).toBe(0);

    const pinsel = {
      id: 'p',
      modus: 'dazu' as const,
      umkehren: true,
      art: 'pinsel' as const,
      striche: [{ punkte: [200, 150], breite: 400, haerte: 1, abziehen: false }],
    };
    const gemalt = teilBauen(pinsel, raster);
    // Wo der Pinsel voll deckte, ist nach dem Umkehren nichts.
    expect(gemalt[15 * 40 + 20]).toBe(0);
  });
});

describe('nachgereicht: der weiche Radierer', () => {
  it('malt am weichen Rand nicht, statt zu radieren', () => {
    /*
     * Nachgemessen: Ersetzt man im Radiererzweig die Wache durch ein
     * schlichtes Zuweisen, bleiben alle 33 Prüfungen grün. Sie benutzten nur
     * Härte 1, und dort ist der Wert innerhalb der Scheibe immer 255 –
     * 255−255 ist zufällig dasselbe wie die richtige Rechnung.
     *
     * Mit Härte 0,5 geht der Wert am Rand gegen 0, und ohne Wache SCHRIEBE
     * der Radierer dort 255: Er malte einen hellen Ring, statt zu radieren.
     */
    const raster = { breite: 60, hoehe: 60, faktor: 1 };
    const feld = new Uint8Array(60 * 60);
    strichStempeln(feld, raster, {
      punkte: [30, 30],
      breite: 40,
      haerte: 0.5,
      abziehen: true,
    });
    // Auf einem leeren Feld darf ein Radierer nirgends etwas hinterlassen.
    expect(Math.max(...feld)).toBe(0);
  });

  it('radiert eine weiche Kante aus einer vollen Fläche sauber heraus', () => {
    const raster = { breite: 60, hoehe: 60, faktor: 1 };
    const feld = new Uint8Array(60 * 60).fill(255);
    strichStempeln(feld, raster, {
      punkte: [30, 30],
      breite: 40,
      haerte: 0.5,
      abziehen: true,
    });
    // In der Mitte ganz weg, am Rand des Bildes unangetastet, dazwischen weich.
    expect(feld[30 * 60 + 30]).toBe(0);
    expect(feld[0]).toBe(255);
    const rand = feld[30 * 60 + 15];
    expect(rand).toBeGreaterThan(0);
    expect(rand).toBeLessThan(255);
  });
});

describe('das Tiefenteil', () => {
  it('wird über Fokus und Spanne zur Maske, nicht direkt übernommen', () => {
    /*
     * Die Karte ist die ENTFERNUNG, nicht die Maske. Bei Fokus ganz vorne
     * (1) bleibt der nahe Rand (255) scharf und der ferne (0) wird unscharf –
     * die Maske ist also die UMKEHRUNG der Karte. Wer die Karte direkt als
     * Maske nimmt, bekommt genau das Gegenteil, und zwar ohne Fehlermeldung.
     */
    const raster = { breite: 8, hoehe: 8, faktor: 1, versatzX: 0, versatzY: 0 };
    const feld = teilBauen(tiefenTeil({ fokus: 1, spanne: 1 }), raster);
    const links = feld[0];
    const rechts = feld[7];
    expect(links).toBeGreaterThan(200);
    expect(rechts).toBeLessThan(55);
  });

  it('dreht sich mit dem Fokus um', () => {
    const raster = { breite: 8, hoehe: 8, faktor: 1, versatzX: 0, versatzY: 0 };
    const vorn = teilBauen(tiefenTeil({ fokus: 1, spanne: 1 }), raster);
    const hinten = teilBauen(tiefenTeil({ fokus: 0, spanne: 1 }), raster);
    expect(vorn[0]).toBeGreaterThan(vorn[7]);
    expect(hinten[0]).toBeLessThan(hinten[7]);
  });

  it('lässt bei kleiner Spanne mehr unscharf werden', () => {
    const raster = { breite: 8, hoehe: 8, faktor: 1, versatzX: 0, versatzY: 0 };
    const weit = teilBauen(tiefenTeil({ fokus: 1, spanne: 1 }), raster);
    const eng = teilBauen(tiefenTeil({ fokus: 1, spanne: 0.25 }), raster);
    // In der Mitte des Bildes: mit enger Spanne schon voll unscharf.
    expect(eng[4]).toBeGreaterThan(weit[4]);
  });

  it('achtet auf „umkehren“ wie jedes andere Teil', () => {
    const raster = { breite: 8, hoehe: 8, faktor: 1, versatzX: 0, versatzY: 0 };
    const normal = teilBauen(tiefenTeil({ fokus: 1, spanne: 1 }), raster);
    const gekehrt = teilBauen(tiefenTeil({ fokus: 1, spanne: 1, umkehren: true }), raster);
    expect(gekehrt[0]).toBe(255 - normal[0]);
  });
});

describe('teilSchluessel für das Tiefenteil', () => {
  it('ändert sich, wenn der Fokus wandert', () => {
    /*
     * Der eigentliche Grund für diesen Test: Fokus und Spanne ändern die
     * Maske, ohne die Karte anzufassen. Stünden sie nicht im Schlüssel,
     * bliebe der Zwischenspeicher am alten Bild kleben – der Regler sähe aus,
     * als täte er nichts.
     */
    const a = teilSchluessel(tiefenTeil({ fokus: 0.5 }));
    const b = teilSchluessel(tiefenTeil({ fokus: 0.6 }));
    expect(a).not.toBe(b);
  });

  it('ändert sich, wenn die Spanne wandert', () => {
    const a = teilSchluessel(tiefenTeil({ spanne: 0.5 }));
    const b = teilSchluessel(tiefenTeil({ spanne: 0.4 }));
    expect(a).not.toBe(b);
  });

  it('unterscheidet zwei Karten über die Marke', () => {
    const a = teilSchluessel(tiefenTeil({ marke: 1 }));
    const b = teilSchluessel(tiefenTeil({ marke: 2 }));
    expect(a).not.toBe(b);
  });

  it('enthält die Karte selbst nicht – sie würde zu [object Uint8Array]', () => {
    expect(teilSchluessel(tiefenTeil())).not.toContain('object');
  });
});
