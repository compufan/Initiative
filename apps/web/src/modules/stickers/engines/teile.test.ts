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
