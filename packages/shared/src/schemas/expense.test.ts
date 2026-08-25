import { describe, expect, it } from 'vitest';
import { formatCents, parseAmount, paypalMeUrl, splitEvenly } from './expense.js';

describe('Betrag aufteilen', () => {
  it('verliert keinen Cent', () => {
    // 10 Euro auf drei: 3,34 + 3,33 + 3,33. Dreimal 3,33 waeren 9,99 - der
    // fehlende Cent taucht spaeter in einem Saldo auf, den niemand erklaeren
    // kann.
    const anteile = splitEvenly(1000, 3);
    expect(anteile).toEqual([334, 333, 333]);
    expect(anteile.reduce((summe, wert) => summe + wert, 0)).toBe(1000);
  });

  it('rechnet wie der Server', () => {
    // Dieselben Faelle wie in services/expenses.rs.
    expect(splitEvenly(900, 3)).toEqual([300, 300, 300]);
    expect(splitEvenly(1, 3)).toEqual([1, 0, 0]);
    expect(splitEvenly(500, 0)).toEqual([]);
  });

  it('bleibt auch bei vielen Beteiligten genau', () => {
    for (const [betrag, anzahl] of [
      [10_000, 7],
      [1_234_567, 13],
      [99, 100],
    ] as const) {
      expect(splitEvenly(betrag, anzahl).reduce((s, w) => s + w, 0)).toBe(betrag);
    }
  });
});

describe('Betrag einlesen', () => {
  it('nimmt Komma und Punkt', () => {
    expect(parseAmount('12,50')).toBe(1250);
    expect(parseAmount('12.50')).toBe(1250);
    expect(parseAmount('7')).toBe(700);
    expect(parseAmount(' 3,4 ')).toBe(340);
  });

  it('rundet nicht durch Fliesskomma daneben', () => {
    // 19.99 * 100 ist in Fliesskomma 1998.9999999999998 - daraus wuerden 1998
    // Cent, und der Betrag waere einen Cent zu klein.
    expect(parseAmount('19,99')).toBe(1999);
    expect(parseAmount('0,07')).toBe(7);
    expect(parseAmount('1234,56')).toBe(123456);
  });

  it('weist Unsinn ab', () => {
    expect(parseAmount('')).toBeNull();
    expect(parseAmount('abc')).toBeNull();
    expect(parseAmount('-5')).toBeNull();
    expect(parseAmount('1,234')).toBeNull();
  });
});

describe('Darstellung', () => {
  it('zeigt Euro mit zwei Stellen', () => {
    // Das geschuetzte Leerzeichen von Intl vereinheitlichen.
    expect(formatCents(1234).replace(/ /g, ' ')).toBe('12,34 €');
    expect(formatCents(0).replace(/ /g, ' ')).toBe('0,00 €');
  });
});

describe('PayPal.Me', () => {
  it('baut den Link mit Betrag', () => {
    expect(paypalMeUrl('maxmuster', 1234)).toBe('https://paypal.me/maxmuster/12.34EUR');
    expect(paypalMeUrl('maxmuster', 500)).toBe('https://paypal.me/maxmuster/5.00EUR');
  });

  it('nimmt auch die ganze Adresse', () => {
    for (const eingabe of [
      '@maxmuster',
      'paypal.me/maxmuster',
      'https://paypal.me/maxmuster',
      'https://www.paypal.me/maxmuster/',
    ]) {
      expect(paypalMeUrl(eingabe, 100)).toBe('https://paypal.me/maxmuster/1.00EUR');
    }
  });

  it('weist unbrauchbare Namen ab', () => {
    // Ohne diese Pruefung liesse sich ueber das Namensfeld eine beliebige
    // Adresse in die App schmuggeln.
    expect(paypalMeUrl(null, 100)).toBeNull();
    expect(paypalMeUrl('', 100)).toBeNull();
    expect(paypalMeUrl('max muster', 100)).toBeNull();
    expect(paypalMeUrl('evil.example/../x', 100)).toBeNull();
    expect(paypalMeUrl('max?a=b', 100)).toBeNull();
  });
});
