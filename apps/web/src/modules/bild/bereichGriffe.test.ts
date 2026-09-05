import { describe, expect, it } from 'vitest';
import type { Punkt, RadialTeil, VerlaufTeil } from './doc.js';
import {
  griffTreffer,
  griffZiehen,
  griffeVon,
  radialRand,
  verlaufLinien,
  type Griff,
  type Griffname,
  fangBereich,
} from './bereichGriffe.js';

/** Ein Verlauf quer über ein Bild, absichtlich schräg – Achsenparallel deckt zu wenig ab. */
const VERLAUF: VerlaufTeil = { art: 'verlauf', von: { x: 100, y: 200 }, bis: { x: 400, y: 260 } };

/** Eine Ellipse mit UNGLEICHEN Halbachsen und schiefem Winkel. */
const RADIAL: RadialTeil = {
  art: 'radial',
  mitte: { x: 500, y: 400 },
  rx: 200,
  ry: 80,
  winkel: 0.6,
  weichheit: 0.3,
};

function griffMit(teil: VerlaufTeil | RadialTeil, name: Griffname): Griff {
  const griff = griffeVon(teil).find((g) => g.name === name);
  if (!griff) throw new Error(`Griff ${name} gibt es an diesem Teil nicht`);
  return griff;
}

/**
 * Zieht einen Griff auf `ziel` – aufgesetzt wird dort, wo der Griff liegt.
 *
 * Genau so kommt es aus der Zeigerschicht: Man fasst einen Griff an, also ist
 * der Aufsetzpunkt seine Stelle.
 */
function ziehen<T extends VerlaufTeil | RadialTeil>(teil: T, name: Griffname, ziel: Punkt): T {
  const griff = griffMit(teil, name);
  return griffZiehen(teil, name, ziel, { x: griff.x, y: griff.y });
}

function erwarteGriffBei(teil: VerlaufTeil | RadialTeil, name: Griffname, ziel: Punkt): void {
  const griff = griffMit(teil, name);
  expect(griff.x).toBeCloseTo(ziel.x, 9);
  expect(griff.y).toBeCloseTo(ziel.y, 9);
}

describe('griffeVon', () => {
  it('gibt dem Verlauf genau seine drei Griffe', () => {
    // Ein fehlender Griff macht eine Funktion unerreichbar, ohne dass sonst
    // etwas kaputt aussieht. Bricht, sobald einer wegfällt oder doppelt kommt.
    expect(griffeVon(VERLAUF).map((g) => g.name)).toEqual(['von', 'bis', 'achse']);
  });

  it('gibt der Ellipse genau ihre vier Griffe', () => {
    // Bricht, sobald der Drehgriff fehlt – dann liesse sich die Ellipse nur
    // noch aufziehen, nicht mehr drehen.
    expect(griffeVon(RADIAL).map((g) => g.name)).toEqual(['mitte', 'rx', 'ry', 'dreh']);
  });

  it('setzt den Achsengriff auf die Mitte der Strecke', () => {
    // Bricht, sobald er an einem Ende sitzt. Die Umkehrprüfung allein merkt
    // das NICHT: Sie setzt dort auf, wo der Griff liegt, und ist deshalb mit
    // jeder Stelle zufrieden.
    const griff = griffMit(VERLAUF, 'achse');
    expect(griff.x).toBeCloseTo((VERLAUF.von.x + VERLAUF.bis.x) / 2, 9);
    expect(griff.y).toBeCloseTo((VERLAUF.von.y + VERLAUF.bis.y) / 2, 9);
  });

  it('setzt den rx-Griff im Abstand rx auf die Hauptachse', () => {
    // Bricht, sobald der Radius mit dem Winkel verrechnet wird – der Griff
    // sässe dann nicht auf dem Rand, den er verschieben soll.
    const griff = griffMit(RADIAL, 'rx');
    expect(Math.hypot(griff.x - RADIAL.mitte.x, griff.y - RADIAL.mitte.y)).toBeCloseTo(
      RADIAL.rx,
      9,
    );
    expect(Math.atan2(griff.y - RADIAL.mitte.y, griff.x - RADIAL.mitte.x)).toBeCloseTo(
      RADIAL.winkel,
      9,
    );
  });
});

describe('griffeVon und griffZiehen sind zueinander invers', () => {
  it('legt den Griff „von“ genau dorthin, wohin er gezogen wurde', () => {
    // Bricht, sobald „von“ statt `von` das Feld `bis` setzt oder um die
    // Differenz verschiebt statt auf das Ziel zu springen.
    const ziel = { x: 130, y: 95 };
    erwarteGriffBei(ziehen(VERLAUF, 'von', ziel), 'von', ziel);
  });

  it('legt den Griff „bis“ genau dorthin, wohin er gezogen wurde', () => {
    // Bricht, sobald „bis“ auf `von` schreibt.
    const ziel = { x: 620, y: 410 };
    erwarteGriffBei(ziehen(VERLAUF, 'bis', ziel), 'bis', ziel);
  });

  it('legt den Griff „achse“ genau dorthin, wohin er gezogen wurde', () => {
    // Der Achsengriff ist die Mitte der Strecke. Bricht, sobald das Verschieben
    // nur ein Ende mitnimmt – dann wandert die Mitte nur um die halbe Differenz.
    const ziel = { x: 260, y: 500 };
    erwarteGriffBei(ziehen(VERLAUF, 'achse', ziel), 'achse', ziel);
  });

  it('legt den Griff „mitte“ genau dorthin, wohin er gezogen wurde', () => {
    // Bricht, sobald „mitte“ die Differenz zweimal addiert oder das Vorzeichen dreht.
    const ziel = { x: 320, y: 640 };
    erwarteGriffBei(ziehen(RADIAL, 'mitte', ziel), 'mitte', ziel);
  });

  it('legt den Griff „rx“ genau dorthin, wohin er gezogen wurde', () => {
    /*
     * Die Prüfung auf das Zurückspringen: Das Ziel liegt bewusst NEBEN der
     * heutigen Hauptachse. Setzt `griffZiehen` nur `rx` und lässt `winkel`
     * stehen, landet der Griff auf der alten Achse im Abstand des neuen
     * Radius – also irgendwo, nur nicht unter dem Finger.
     */
    const ziel = { x: RADIAL.mitte.x - 90, y: RADIAL.mitte.y + 150 };
    erwarteGriffBei(ziehen(RADIAL, 'rx', ziel), 'rx', ziel);
  });

  it('legt den Griff „ry“ genau dorthin, wohin er gezogen wurde', () => {
    // Der ry-Griff kann seine Achse nicht verlassen, deshalb liegt das Ziel
    // auf der Nebenachse – dort und nur dort ist der Zug umkehrbar. Bricht,
    // sobald „ry“ zusätzlich den Winkel setzt (die Achse kippte dann weg)
    // oder auf `rx` schreibt.
    const abstand = 140;
    const ziel = {
      x: RADIAL.mitte.x - abstand * Math.sin(RADIAL.winkel),
      y: RADIAL.mitte.y + abstand * Math.cos(RADIAL.winkel),
    };
    erwarteGriffBei(ziehen(RADIAL, 'ry', ziel), 'ry', ziel);
  });

  it('legt den Griff „dreh“ genau dorthin, wohin er gezogen wurde', () => {
    // Der Drehgriff hat einen festen Abstand (rx · 1,25), also liegt das Ziel
    // auf diesem Kreis. Bricht, sobald „dreh“ nebenbei `rx` auf den
    // Fingerabstand setzt – der Griff wanderte dann auf das 1,25-fache hinaus.
    const neu = 2;
    const weite = RADIAL.rx * 1.25;
    const ziel = {
      x: RADIAL.mitte.x + weite * Math.cos(neu),
      y: RADIAL.mitte.y + weite * Math.sin(neu),
    };
    erwarteGriffBei(ziehen(RADIAL, 'dreh', ziel), 'dreh', ziel);
  });
});

describe('griffZiehen', () => {
  it('verschiebt mit „achse“ beide Enden um genau die Differenz', () => {
    // Aufgesetzt wird ABSEITS des Achsengriffs, hier am Anfangspunkt. Bricht,
    // sobald ein Ende auf das Ziel gesetzt statt verschoben wird – der Verlauf
    // spränge dann beim Aufsetzen unter den Finger.
    const start = { x: VERLAUF.von.x, y: VERLAUF.von.y };
    const ziel = { x: start.x + 70, y: start.y - 25 };
    const neu = griffZiehen(VERLAUF, 'achse', ziel, start);
    expect(neu.von.x).toBeCloseTo(VERLAUF.von.x + 70, 9);
    expect(neu.von.y).toBeCloseTo(VERLAUF.von.y - 25, 9);
    expect(neu.bis.x).toBeCloseTo(VERLAUF.bis.x + 70, 9);
    expect(neu.bis.y).toBeCloseTo(VERLAUF.bis.y - 25, 9);
  });

  it('verschiebt „mitte“ um die Differenz, auch wenn abseits der Mitte aufgesetzt wurde', () => {
    // Eine Ellipse fasst man auf ihrer ganzen Fläche an, nicht im Mittelpunkt.
    // Bricht, sobald „mitte“ auf `ziel` gesetzt statt verschoben wird – die
    // Ellipse spränge dann im Moment des Aufsetzens unter den Finger.
    const start = { x: RADIAL.mitte.x + 150, y: RADIAL.mitte.y - 40 };
    const ziel = { x: start.x + 25, y: start.y + 60 };
    const neu = griffZiehen(RADIAL, 'mitte', ziel, start);
    expect(neu.mitte.x).toBeCloseTo(RADIAL.mitte.x + 25, 9);
    expect(neu.mitte.y).toBeCloseTo(RADIAL.mitte.y + 60, 9);
  });

  it('lässt „achse“ Länge und Richtung der Achse unberührt', () => {
    // Das eigentliche Versprechen des Schiebegriffs: Der Verlauf wird
    // verschoben, nicht neu gezogen. Bricht, sobald nur ein Ende mitwandert –
    // dann ändern sich Länge und Richtung beide.
    const ziel = { x: 1000, y: -300 };
    const neu = ziehen(VERLAUF, 'achse', ziel);
    const alt = { x: VERLAUF.bis.x - VERLAUF.von.x, y: VERLAUF.bis.y - VERLAUF.von.y };
    expect(neu.bis.x - neu.von.x).toBeCloseTo(alt.x, 9);
    expect(neu.bis.y - neu.von.y).toBeCloseTo(alt.y, 9);
  });

  it('ändert den übergebenen Verlauf nicht', () => {
    // Bricht bei jedem `start.von.x += dx` statt einer Kopie.
    const vorher = JSON.stringify(VERLAUF);
    const neu = ziehen(VERLAUF, 'achse', { x: 42, y: 43 });
    expect(JSON.stringify(VERLAUF)).toBe(vorher);
    expect(neu).not.toBe(VERLAUF);
    expect(neu.von).not.toBe(VERLAUF.von);
  });

  it('ändert die übergebene Ellipse nicht', () => {
    // Bricht, sobald `mitte` an Ort und Stelle verschoben oder `rx` gesetzt wird.
    const vorher = JSON.stringify(RADIAL);
    for (const name of ['mitte', 'rx', 'ry', 'dreh'] as const) {
      const neu = ziehen(RADIAL, name, { x: 700, y: 120 });
      expect(neu).not.toBe(RADIAL);
    }
    expect(JSON.stringify(RADIAL)).toBe(vorher);
  });

  it('behält die Felder, die der Zug gar nichts angeht', () => {
    // `weichheit` gehört zu keinem Griff. Bricht, sobald `griffZiehen` ein
    // frisches Teil aus den Griffwerten baut statt zu kopieren – die Weiche
    // spränge dann bei jedem Anfassen auf einen Vorgabewert zurück.
    const neu = ziehen(RADIAL, 'dreh', { x: 300, y: 300 });
    expect(neu.weichheit).toBe(RADIAL.weichheit);
    expect(neu.art).toBe('radial');
  });

  it('gibt einen Verlauf unverändert zurück, wenn der Griffname nicht zu ihm gehört', () => {
    // „dreh“ gibt es am Verlauf nicht. Bricht, sobald der Zweig durchfällt und
    // etwa `winkel` an einen Verlauf schreibt.
    expect(griffZiehen(VERLAUF, 'dreh', { x: 5, y: 5 }, { x: 0, y: 0 })).toBe(VERLAUF);
  });

  it('gibt eine Ellipse unverändert zurück, wenn der Griffname nicht zu ihr gehört', () => {
    // Bricht, sobald „von“ auch am Radialteil etwas setzt.
    expect(griffZiehen(RADIAL, 'von', { x: 5, y: 5 }, { x: 0, y: 0 })).toBe(RADIAL);
  });

  it('hält rx bei mindestens 1, wenn der Griff auf die Mitte gezogen wird', () => {
    // Bricht ohne die Begrenzung: rx wäre 0, die Ellipse hätte keine Fläche
    // und keinen Griff mehr, an dem man sie wieder aufziehen könnte.
    const neu = ziehen(RADIAL, 'rx', { ...RADIAL.mitte });
    expect(neu.rx).toBe(1);
  });

  it('hält ry bei mindestens 1, wenn der Griff auf die Mitte gezogen wird', () => {
    // Bricht ohne die Begrenzung – siehe rx.
    const neu = ziehen(RADIAL, 'ry', { ...RADIAL.mitte });
    expect(neu.ry).toBe(1);
  });
});

describe('griffTreffer', () => {
  it('nimmt den nächsten Griff, nicht den ersten in der Liste', () => {
    /*
     * rx und dreh liegen auf demselben Strahl, rx steht in der Liste VORNE
     * und ist hier der WEITER entfernte. Der Finger sitzt 240 Punkte von der
     * Mitte entfernt: 40 vom rx-Griff (bei 200), 10 vom Drehgriff (bei 250).
     * Beide liegen innerhalb von 60. Bricht, sobald der erste Treffer gewinnt.
     */
    const finger = {
      x: RADIAL.mitte.x + 240 * Math.cos(RADIAL.winkel),
      y: RADIAL.mitte.y + 240 * Math.sin(RADIAL.winkel),
    };
    const griffe = griffeVon(RADIAL);
    expect(griffe.findIndex((g) => g.name === 'rx')).toBeLessThan(
      griffe.findIndex((g) => g.name === 'dreh'),
    );
    expect(griffTreffer(griffe, finger, 60)).toBe('dreh');
  });

  it('gibt null zurück, wenn kein Griff innerhalb von nah liegt', () => {
    // Bricht, sobald der Abstand ungeprüft bleibt und immer der nächste Griff
    // zurückkommt – dann fasste jede Berührung des Bildes einen Griff an.
    expect(griffTreffer(griffeVon(RADIAL), { x: -900, y: -900 }, 60)).toBe(null);
  });

  it('trifft einen Griff, auf dem der Finger genau steht', () => {
    // Bricht bei einem Abstandsvergleich, der die Wurzel vergisst und rohe
    // Quadrate gegen `nah` hält – dann wäre der Radius in Wahrheit √nah.
    const griff = griffMit(VERLAUF, 'bis');
    expect(griffTreffer(griffeVon(VERLAUF), { x: griff.x, y: griff.y }, 0.5)).toBe('bis');
  });
});

describe('radialRand', () => {
  it('legt jeden Punkt auf den Rand der Ellipse', () => {
    /*
     * Zurückgerechnet: in den Ellipsenrahmen drehen und auf die Halbachsen
     * normieren – dann muss überall 1 herauskommen. Bricht, sobald rx und ry
     * beim Abtasten vertauscht sind (die Halbachsen sind hier 200 und 80) oder
     * das Vorzeichen der Drehung kippt.
     */
    const cos = Math.cos(RADIAL.winkel);
    const sin = Math.sin(RADIAL.winkel);
    for (const p of radialRand(RADIAL)) {
      const dx = p.x - RADIAL.mitte.x;
      const dy = p.y - RADIAL.mitte.y;
      const u = dx * cos + dy * sin;
      const v = -dx * sin + dy * cos;
      expect((u / RADIAL.rx) ** 2 + (v / RADIAL.ry) ** 2).toBeCloseTo(1, 9);
    }
  });

  it('liefert vorgabegemäss 48 Punkte und keinen doppelten Schluss', () => {
    // Bricht bei `i / (anzahl − 1)`: Der letzte Punkt fiele auf den ersten.
    const rand = radialRand(RADIAL);
    expect(rand.length).toBe(48);
    expect(Math.hypot(rand[47].x - rand[0].x, rand[47].y - rand[0].y)).toBeGreaterThan(1);
  });
});

describe('verlaufLinien', () => {
  it('stellt beide Linien senkrecht auf die Achse', () => {
    // Bricht, sobald die Senkrechte (−ay, ax) zu (ax, ay) wird – die Linien
    // lägen dann auf der Achse statt quer dazu.
    const achse = { x: VERLAUF.bis.x - VERLAUF.von.x, y: VERLAUF.bis.y - VERLAUF.von.y };
    for (const [a, b] of verlaufLinien(VERLAUF)) {
      expect((b.x - a.x) * achse.x + (b.y - a.y) * achse.y).toBeCloseTo(0, 9);
    }
  });

  it('legt die Mitte jeder Linie auf ihren Punkt', () => {
    // Bricht, sobald eine Linie an ihrem Punkt beginnt statt um ihn herum zu
    // liegen – der Verlauf sähe dann einseitig aus.
    const [erste, zweite] = verlaufLinien(VERLAUF);
    expect((erste[0].x + erste[1].x) / 2).toBeCloseTo(VERLAUF.von.x, 9);
    expect((erste[0].y + erste[1].y) / 2).toBeCloseTo(VERLAUF.von.y, 9);
    expect((zweite[0].x + zweite[1].x) / 2).toBeCloseTo(VERLAUF.bis.x, 9);
    expect((zweite[0].y + zweite[1].y) / 2).toBeCloseTo(VERLAUF.bis.y, 9);
  });

  it('macht die Linien ohne Angabe so lang wie die Achse', () => {
    // Bricht bei einer festen Vorgabelänge – die sähe an einem 4000er Foto
    // wie ein Strich aus.
    const achse = Math.hypot(VERLAUF.bis.x - VERLAUF.von.x, VERLAUF.bis.y - VERLAUF.von.y);
    for (const [a, b] of verlaufLinien(VERLAUF)) {
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(achse, 9);
    }
  });

  it('nimmt eine ausdrücklich angegebene Länge', () => {
    // Bricht, sobald die halbe statt der ganzen Länge herauskommt.
    for (const [a, b] of verlaufLinien(VERLAUF, 250)) {
      expect(Math.hypot(b.x - a.x, b.y - a.y)).toBeCloseTo(250, 9);
    }
  });
});

/*
 * Nachgereicht aus einer Gegenprüfung. Fünf der behaupteten Mutationen
 * überlebten die ganze Reihe – nicht weil die Rechnung falsch war, sondern
 * weil die Prüfungen sie nicht berührten.
 */
describe('nachgereicht: Griffe', () => {
  const VERLAUF: VerlaufTeil = {
    art: 'verlauf',
    von: { x: 100, y: 100 },
    bis: { x: 300, y: 100 },
  };
  const RADIAL: RadialTeil = {
    art: 'radial',
    mitte: { x: 500, y: 400 },
    rx: 200,
    ry: 120,
    winkel: 0.6,
    weichheit: 0.5,
  };

  it('springt mit einem Endgriff auf den Zeiger, statt ihn zu verschieben', () => {
    /*
     * Die bisherige Umkehrprüfung setzte `startZiel` auf die Griffstelle
     * selbst – dann ist „um die Differenz verschieben“ zufällig dasselbe wie
     * „auf das Ziel springen“, und die Mutation, die der Kommentar nennt,
     * überlebte.
     *
     * Ein echter Finger fasst nie exakt die Mitte eines Griffes an. Wäre der
     * Endgriff ein Schiebegriff, zöge er das Ende um genau diesen
     * Anfassversatz daneben.
     */
    const daneben = { x: VERLAUF.von.x + 17, y: VERLAUF.von.y - 9 };
    const ziel = { x: 40, y: 55 };
    const neu = griffZiehen(VERLAUF, 'von', ziel, daneben);
    expect(neu.von.x).toBeCloseTo(ziel.x, 9);
    expect(neu.von.y).toBeCloseTo(ziel.y, 9);
    expect(neu.bis).toEqual(VERLAUF.bis);

    const neu2 = griffZiehen(VERLAUF, 'bis', ziel, daneben);
    expect(neu2.bis.x).toBeCloseTo(ziel.x, 9);
    expect(neu2.bis.y).toBeCloseTo(ziel.y, 9);
  });

  it('verschiebt die Ellipse mit dem Mittengriff, statt sie unter den Finger zu setzen', () => {
    // Die Gegenrichtung derselben Verwechslung: Der Mittengriff MUSS
    // verschieben. Springt die Ellipse beim Aufsetzen unter den Finger,
    // ruckt sie bei jedem Anfassen.
    const daneben = { x: RADIAL.mitte.x + 30, y: RADIAL.mitte.y + 20 };
    const ziel = { x: daneben.x + 100, y: daneben.y - 50 };
    const neu = griffZiehen(RADIAL, 'mitte', ziel, daneben);
    expect(neu.mitte.x).toBeCloseTo(RADIAL.mitte.x + 100, 9);
    expect(neu.mitte.y).toBeCloseTo(RADIAL.mitte.y - 50, 9);
  });

  it('vergleicht den Fangabstand als Länge und nicht als Quadrat', () => {
    /*
     * Die bisherige Prüfung setzte den Finger EXAKT auf den Griff – Abstand
     * null besteht jede nichtnegative Schwelle. Vergässe der Code die Wurzel
     * und hielte rohe Quadrate gegen `nah`, träfe man in Wahrheit nur noch im
     * Radius √60 ≈ 7,7 statt 60.
     */
    const griffe: Griff[] = [{ name: 'mitte', x: 100, y: 100 }];
    expect(griffTreffer(griffe, { x: 130, y: 100 }, 40)).toBe('mitte');
    expect(griffTreffer(griffe, { x: 150, y: 100 }, 40)).toBeNull();
  });

  it('greift bei einer unbrauchbaren Koordinate ins Leere', () => {
    /*
     * `if (abstand > grenze) continue` ist bei NaN falsch – der Ausschluss
     * griff nicht, und der erste Griff der Liste wurde angenommen.
     * Nachgemessen lieferte ein Tipp mit NaN „mitte“.
     *
     * NaN entsteht eine Schicht höher, sobald durch eine Leinwandbreite 0
     * geteilt wird; ein Fingerdruck während eines Grössenwechsels reicht. Die
     * Folge wäre ein Antippen ohne Koordinate, das die ganze Maske verschiebt.
     */
    const griffe = griffeVon(RADIAL);
    expect(griffTreffer(griffe, { x: Number.NaN, y: Number.NaN }, 60)).toBeNull();
    expect(griffTreffer(griffe, RADIAL.mitte, Number.NaN)).toBeNull();
    // Ein negatives `nah` darf nicht wie sein Betrag wirken.
    expect(griffTreffer(griffe, RADIAL.mitte, -60)).toBeNull();
  });

  it('lässt die Ellipse stehen, wenn der rx-Griff auf die Mitte gezogen wird', () => {
    /*
     * `Math.atan2(0, 0)` ist 0: Wer den Griff auf die Mitte zieht, stellte
     * die Ellipse damit schlagartig achsenparallel – und einen Bildpunkt
     * daneben spränge sie auf 45°. Nachgemessen wurde aus Winkel 0,6 beim Zug
     * auf die Mitte { rx: 1, winkel: 0 }.
     */
    const neu = griffZiehen(RADIAL, 'rx', RADIAL.mitte, { x: 700, y: 400 });
    expect(neu.winkel).toBeCloseTo(RADIAL.winkel, 9);
    expect(neu.rx).toBeGreaterThan(0);
    // Weit genug draussen dreht er sehr wohl mit.
    const weit = griffZiehen(RADIAL, 'rx', { x: 500, y: 600 }, { x: 700, y: 400 });
    expect(weit.winkel).toBeCloseTo(Math.PI / 2, 9);
  });

  it('gibt auch bei unbrauchbarer Punktzahl einen zeichenbaren Rand', () => {
    // `Math.max(3, NaN)` ist NaN, und die Schleife liefe null Mal – der
    // Zeichner bekäme eine leere Kette und zeigte gar keinen Rand.
    expect(radialRand(RADIAL, Number.NaN).length).toBeGreaterThanOrEqual(3);
    expect(radialRand(RADIAL, 0).length).toBeGreaterThanOrEqual(3);
    expect(radialRand(RADIAL, 1).length).toBeGreaterThanOrEqual(3);
  });

  it('liefert für einen entarteten Verlauf zeichenbare Linien statt NaN', () => {
    // von === bis: Die Achse hat keine Richtung. Ohne Schutz kämen vier
    // NaN-Punkte zurück und der Zeichenweg zeigte gar nichts mehr.
    const linien = verlaufLinien(
      { art: 'verlauf', von: { x: 10, y: 10 }, bis: { x: 10, y: 10 } },
      100,
    );
    for (const [a, b] of linien) {
      for (const wert of [a.x, a.y, b.x, b.y]) expect(Number.isFinite(wert)).toBe(true);
    }
  });
});

describe('fangBereich', () => {
  it('hält den Fangkreis unter dem Finger gleich gross', () => {
    // 22 Leinwandpunkte, in Originalpunkte umgerechnet. Bei einem 4000er
    // Foto in einer 1200er Ansicht (Faktor 0,3) sind das 73 Originalpunkte,
    // bei achtfacher Lupe (Faktor 2,4) noch gut 9.
    expect(fangBereich(1)).toBeCloseTo(22, 9);
    expect(fangBereich(0.3)).toBeCloseTo(73.33, 2);
    expect(fangBereich(2.4)).toBeCloseTo(9.17, 2);
    // Und er wird mit wachsendem Zoom kleiner, nicht grösser.
    expect(fangBereich(4)).toBeLessThan(fangBereich(1));
  });

  it('teilt nicht durch null', () => {
    expect(Number.isFinite(fangBereich(0))).toBe(true);
    expect(fangBereich(0)).toBeGreaterThan(0);
  });
});
