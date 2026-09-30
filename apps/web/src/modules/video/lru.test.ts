import { describe, expect, it } from 'vitest';

import { BytesLru } from './lru.js';

describe('BytesLru', () => {
  it('vergisst das am längsten nicht Gebrauchte zuerst – nach Bytes', () => {
    const weg: string[] = [];
    const lru = new BytesLru<string, number>(100, (schluessel) => weg.push(schluessel));
    lru.ablegen('a', 1, 40);
    lru.ablegen('b', 2, 40);
    expect(lru.holen('a')).toBe(1); // a ist jetzt das jüngste
    lru.ablegen('c', 3, 40);
    expect(weg).toEqual(['b']);
    expect(lru.hat('a')).toBe(true);
    expect(lru.hat('b')).toBe(false);
    expect(lru.bytes).toBe(80);
  });

  it('verdrängt mehrere kleine für einen grossen', () => {
    const lru = new BytesLru<string, number>(100);
    for (let i = 0; i < 10; i += 1) lru.ablegen(`k${i}`, i, 10);
    lru.ablegen('gross', 99, 75);
    expect(lru.anzahl).toBe(3);
    expect(lru.bytes).toBe(95);
    expect(lru.hat('k9')).toBe(true);
  });

  it('legt nichts ab, das allein schon zu gross ist', () => {
    const lru = new BytesLru<string, number>(100);
    lru.ablegen('a', 1, 50);
    lru.ablegen('riesig', 2, 101);
    expect(lru.hat('riesig')).toBe(false);
    expect(lru.hat('a')).toBe(true);
  });

  it('ersetzt einen Eintrag unter demselben Schlüssel und zählt richtig', () => {
    const lru = new BytesLru<string, number>(100);
    lru.ablegen('a', 1, 50);
    lru.ablegen('a', 2, 30);
    expect(lru.bytes).toBe(30);
    expect(lru.holen('a')).toBe(2);
    lru.loeschen('a');
    expect(lru.bytes).toBe(0);
    lru.ablegen('b', 3, 10);
    lru.leeren();
    expect(lru.anzahl).toBe(0);
  });
});
