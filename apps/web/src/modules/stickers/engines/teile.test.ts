import { describe, expect, it } from 'vitest';
import { maskeAus, teilAn, teileFinden } from './teile.js';

/** Eine Maske aus einer Funktion bauen – ohne Browser. */
function maske(breite: number, hoehe: number, drin: (x: number, y: number) => boolean): Uint8Array {
  const alpha = new Uint8Array(breite * hoehe);
  for (let y = 0; y < hoehe; y += 1) {
    for (let x = 0; x < breite; x += 1) {
      alpha[y * breite + x] = drin(x, y) ? 255 : 0;
    }
  }
  return alpha;
}

describe('Eine Maske in antippbare Teile zerlegen', () => {
  it('trennt zwei Flächen, die sich nicht berühren', () => {
    // Genau der Fall: links die Flasche, rechts die Person.
    const alpha = maske(100, 100, (x, y) => (x < 30 || x > 60) && y > 10 && y < 90);
    const teile = teileFinden(alpha, 100, 100);

    expect(teile.anzahl).toBe(2);
    // Antippen links trifft das eine, rechts das andere.
    const links = teilAn(teile, 15, 50);
    const rechts = teilAn(teile, 80, 50);
    expect(links).toBeGreaterThan(0);
    expect(rechts).toBeGreaterThan(0);
    expect(links).not.toBe(rechts);
  });

  it('lässt Berührendes zusammen – und behauptet nichts anderes', () => {
    // Hält die Person die Flasche, sind sie über den Arm verbunden. Die
    // Zerlegung kennt keine Gegenstände; sie weiss nur, was zusammenhängt.
    const alpha = maske(100, 100, (x, y) => y > 10 && y < 90 && (x < 30 || x > 60 || y === 50));
    const teile = teileFinden(alpha, 100, 100);
    expect(teile.anzahl).toBe(1);
  });

  it('wirft Sprenkel weg', () => {
    // Modelle setzen an Kanten gern einzelne Punkte. Als antippbare Teile
    // waeren sie nutzlos – man traefe sie nicht.
    const alpha = maske(200, 200, (x, y) => x > 50 && x < 150 && y > 50 && y < 150);
    alpha[3 * 200 + 3] = 255; // ein einzelner Punkt weit weg
    alpha[3 * 200 + 4] = 255;

    const teile = teileFinden(alpha, 200, 200);
    expect(teile.anzahl).toBe(1);
    expect(teilAn(teile, 3, 3, 0)).toBe(0);
  });

  it('findet das Teil auch, wenn man danebentippt', () => {
    // Ein Finger ist breiter als eine Kontur. Ohne Umkreissuche muesste man
    // eine duenne Flasche punktgenau treffen.
    const alpha = maske(100, 100, (x, y) => x >= 48 && x <= 52 && y > 20 && y < 80);
    const teile = teileFinden(alpha, 100, 100);
    expect(teile.anzahl).toBe(1);

    expect(teilAn(teile, 44, 50)).toBe(1);
    // Aber nicht beliebig weit – sonst waehlt ein Tipp ins Leere etwas aus.
    expect(teilAn(teile, 10, 50)).toBe(0);
  });

  it('reicht ohne Auswahl die ganze Maske durch', () => {
    // Solange niemand tippt, verhaelt sich das Modell wie bisher.
    const alpha = maske(50, 50, (x) => x < 25);
    const teile = teileFinden(alpha, 50, 50);
    expect(maskeAus(alpha, teile, [])).toBe(alpha);
  });

  it('behält nur die gewählten Teile', () => {
    const alpha = maske(100, 100, (x, y) => (x < 30 || x > 60) && y > 10 && y < 90);
    const teile = teileFinden(alpha, 100, 100);
    const links = teilAn(teile, 15, 50);

    const nur = maskeAus(alpha, teile, [links]);
    expect(nur[50 * 100 + 15]).toBe(255);
    expect(nur[50 * 100 + 80]).toBe(0);

    // Und mit beiden ist wieder alles da.
    const beide = maskeAus(alpha, teile, [1, 2]);
    expect(beide[50 * 100 + 15]).toBe(255);
    expect(beide[50 * 100 + 80]).toBe(255);
  });

  it('kommt mit einer leeren Maske zurecht', () => {
    const teile = teileFinden(new Uint8Array(100), 10, 10);
    expect(teile.anzahl).toBe(0);
    expect(teilAn(teile, 5, 5)).toBe(0);
  });
});

describe('Der weiche Saum bleibt beim Antippen erhalten', () => {
  /**
   * Eine Fläche mit Verlaufsrand, wie sie ein Modell wirklich liefert:
   * innen voll, aussen ein paar Punkte breit ausklingend.
   */
  function mitSaum(breite: number, hoehe: number, mitte: number, kern: number, saum: number) {
    const alpha = new Uint8Array(breite * hoehe);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const d = Math.abs(x - mitte);
        let wert = 0;
        if (d <= kern) wert = 255;
        else if (d <= kern + saum) wert = Math.round(255 * (1 - (d - kern) / (saum + 1)));
        alpha[y * breite + x] = wert;
      }
    }
    return alpha;
  }

  it('behält die ausklingenden Werte, statt sie auf null zu setzen', () => {
    const alpha = mitSaum(80, 20, 40, 8, 6);
    const teile = teileFinden(alpha, 80, 20);
    expect(teile.anzahl).toBe(1);

    const gewaehlt = maskeAus(alpha, teile, [1]);

    /*
     * Der Punkt: Genau die Werte zwischen 1 und 127 waren vorher weg.
     * `teileFinden` vergibt seine Nummern erst ab 128 – der ganze
     * Übergangsbereich trug die Null und fiel bei der Auswahl heraus.
     */
    let saumpunkte = 0;
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] > 0 && alpha[i] < 128) {
        saumpunkte += 1;
        expect(gewaehlt[i]).toBe(alpha[i]);
      }
    }
    expect(saumpunkte).toBeGreaterThan(0);
  });

  it('gibt nichts heraus, wo auch vorher nichts war', () => {
    const alpha = mitSaum(80, 20, 40, 8, 6);
    const teile = teileFinden(alpha, 80, 20);
    const gewaehlt = maskeAus(alpha, teile, [1]);
    for (let i = 0; i < alpha.length; i += 1) {
      if (alpha[i] === 0) expect(gewaehlt[i]).toBe(0);
    }
  });

  /*
   * Zwei Flächen mit je eigenem Saum: Der Saum darf nicht zum falschen Teil
   * wandern, sonst brächte das Antippen der einen Flasche den Rand der
   * anderen mit.
   */
  it('schlägt jeden Saumpunkt dem näheren Teil zu', () => {
    const breite = 120;
    const alpha = new Uint8Array(breite * 10);
    for (let y = 0; y < 10; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        const dLinks = Math.abs(x - 25);
        const dRechts = Math.abs(x - 95);
        const d = Math.min(dLinks, dRechts);
        let wert = 0;
        if (d <= 10) wert = 255;
        else if (d <= 16) wert = Math.round(255 * (1 - (d - 10) / 7));
        alpha[y * breite + x] = wert;
      }
    }
    const teile = teileFinden(alpha, breite, 10);
    expect(teile.anzahl).toBe(2);

    const linkesTeil = teilAn(teile, 25, 5);
    const nurLinks = maskeAus(alpha, teile, [linkesTeil]);

    // Ein Saumpunkt dicht am rechten Kern gehört nicht zur linken Auswahl.
    const rechterSaum = 5 * breite + 95 + 15;
    expect(alpha[rechterSaum]).toBeGreaterThan(0);
    expect(alpha[rechterSaum]).toBeLessThan(128);
    expect(nurLinks[rechterSaum]).toBe(0);

    // Und einer dicht am linken Kern schon.
    const linkerSaum = 5 * breite + 25 + 15;
    expect(alpha[linkerSaum]).toBeGreaterThan(0);
    expect(alpha[linkerSaum]).toBeLessThan(128);
    expect(nurLinks[linkerSaum]).toBe(alpha[linkerSaum]);
  });

  /*
   * Der Fall, auf den es ankommt: Zwei Flächen so dicht beieinander, dass
   * sich ihre Säume BERÜHREN. Erst dort entscheidet sich, ob ein Saumpunkt
   * dem näheren Teil zufällt – liegen die Säume getrennt, gewinnt ohnehin
   * der einzige Nachbar, und die Behauptung „der nähere gewinnt" bliebe
   * ungeprüft. (Genau so war es: Eine Tiefensuche statt der Breitensuche
   * kam durch die erste Fassung dieser Reihe glatt hindurch.)
   */
  it('lässt bei sich berührenden Säumen den näheren gewinnen', () => {
    const breite = 80;
    const hoehe = 6;
    const linkeMitte = 25;
    const rechteMitte = 55;
    const KERN = 6;
    const SAUM = 10;

    const rampe = (d: number) => {
      if (d <= KERN) return 255;
      if (d <= KERN + SAUM) return Math.round(255 * (1 - (d - KERN) / (SAUM + 1)));
      return 0;
    };

    const alpha = new Uint8Array(breite * hoehe);
    for (let y = 0; y < hoehe; y += 1) {
      for (let x = 0; x < breite; x += 1) {
        alpha[y * breite + x] = Math.max(
          rampe(Math.abs(x - linkeMitte)),
          rampe(Math.abs(x - rechteMitte)),
        );
      }
    }

    const teile = teileFinden(alpha, breite, hoehe);
    expect(teile.anzahl).toBe(2);
    const links = teilAn(teile, linkeMitte, 3);
    const rechts = teilAn(teile, rechteMitte, 3);
    expect(links).not.toBe(rechts);

    const nurLinks = maskeAus(alpha, teile, [links]);
    let strittige = 0;
    for (let x = 0; x < breite; x += 1) {
      const i = 3 * breite + x;
      if (alpha[i] === 0 || alpha[i] >= 128) continue;
      const dLinks = Math.abs(x - linkeMitte);
      const dRechts = Math.abs(x - rechteMitte);
      if (dLinks === dRechts) continue;
      strittige += 1;
      if (dLinks < dRechts) expect(nurLinks[i]).toBe(alpha[i]);
      else expect(nurLinks[i]).toBe(0);
    }
    // Die Säume müssen sich wirklich treffen, sonst prüft die Reihe nichts.
    const mitte = 3 * breite + Math.round((linkeMitte + rechteMitte) / 2);
    expect(alpha[mitte]).toBeGreaterThan(0);
    expect(strittige).toBeGreaterThan(8);
  });

  it('trifft beim Antippen auch den Saum selbst', () => {
    const alpha = mitSaum(80, 20, 40, 8, 6);
    const teile = teileFinden(alpha, 80, 20);
    // Ein Punkt im ausklingenden Rand, weit genug vom Kern für die Umkreissuche.
    expect(teilAn(teile, 52, 10, 0)).toBe(1);
  });
});
