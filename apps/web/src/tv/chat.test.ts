import { describe, expect, it } from 'vitest';

import { ersatztext, seitentext, uhrzeit, type ChatNachricht } from './chat.js';

function nachricht(werte: Partial<ChatNachricht> = {}): ChatNachricht {
  return {
    id: 'n1',
    art: 'text',
    text: null,
    absender: 'Anna',
    eigen: false,
    zeit: '2026-09-18T14:20:00.000Z',
    bearbeitet: false,
    bilder: [],
    ...werte,
  };
}

describe('uhrzeit', () => {
  it('zeigt nur die Uhrzeit, solange die Nachricht von heute ist', () => {
    /*
     * Auf einem Fernseher im Wohnzimmer ist „14:20" die Auskunft, die jemand
     * sucht, und „18.09.2026, 14:20:33" die, die er überliest.
     */
    const jetzt = new Date('2026-09-18T20:00:00.000Z');
    expect(uhrzeit('2026-09-18T14:20:00.000Z', jetzt)).toMatch(/^\d{2}:\d{2}$/);
  });

  it('nimmt den Tag dazu, sobald sie älter ist', () => {
    // „gestern 14:20" wäre sonst nicht von heute zu unterscheiden – und auf
    // einem Fernseher steht beides untereinander in derselben Liste.
    const jetzt = new Date('2026-09-18T20:00:00.000Z');
    expect(uhrzeit('2026-09-17T14:20:00.000Z', jetzt)).toMatch(/^\d{2}\.\d{2}\.? \d{2}:\d{2}$/);
  });

  it('schweigt bei einem Datum, das keines ist', () => {
    // Eine kaputte Zeit darf keine Zeile mit „Invalid Date" erzeugen. Der
    // Fernseher fragt niemanden – was einmal drinsteht, steht auf dem Schirm.
    expect(uhrzeit('nicht wirklich')).toBe('');
  });
});

describe('ersatztext', () => {
  it('sagt, was da ist, wenn kein Wort dabeisteht', () => {
    // Eine leere Zeile sieht aus wie ein Fehler.
    expect(ersatztext(nachricht({ bilder: [{ id: 'a', art: 'image', url: '/a' }] }))).toBe('Foto');
    expect(ersatztext(nachricht({ bilder: [{ id: 'a', art: 'video', url: '/a' }] }))).toBe('Video');
    expect(
      ersatztext(
        nachricht({
          bilder: [
            { id: 'a', art: 'image', url: '/a' },
            { id: 'b', art: 'image', url: '/b' },
          ],
        }),
      ),
    ).toBe('2 Dateien');
    expect(ersatztext(nachricht({ art: 'poll' }))).toBe('Umfrage');
    expect(ersatztext(nachricht({ art: 'expense' }))).toBe('Ausgabe');
  });

  it('schweigt bei einer Systemnachricht', () => {
    /*
     * „Anna ist beigetreten" hat in der App ihren Platz. Auf dem Fernseher
     * hiesse ein Ersatztext dafür: eine Blase mit dem Wort „Anhang", die auf
     * nichts zeigt.
     */
    expect(ersatztext(nachricht({ art: 'system' }))).toBe('');
  });
});

describe('seitentext', () => {
  it('schweigt, solange es nichts zu blättern gibt', () => {
    // Eine Seitenangabe „1 von 1" ist keine Auskunft, sondern Dekoration –
    // und auf einem Fernseher kostet jede Zeile Platz, den Nachrichten
    // brauchen.
    expect(seitentext(0, 5, 12)).toBe('');
    expect(seitentext(0, 12, 12)).toBe('');
  });

  it('zählt von hinten – Stelle 0 ist die jüngste Seite', () => {
    /*
     * Die Stelle wächst nach HINTEN in den Verlauf; die Anzeige wächst nach
     * vorn. Wer auf der jüngsten Seite steht, soll „3 von 3" lesen und nicht
     * „1 von 3": Das Neueste ist das Ende des Gesprächs, nicht sein Anfang.
     */
    expect(seitentext(0, 30, 12)).toBe('3 von 3');
    expect(seitentext(1, 30, 12)).toBe('2 von 3');
    expect(seitentext(2, 30, 12)).toBe('1 von 3');
  });

  it('rechnet mit einer Seitengrösse von null nicht in die Unendlichkeit', () => {
    // Eine Antwort ohne `proSeite` darf keine Division durch null geben – und
    // erst recht keine Zeichenkette mit „Infinity" auf dem Fernseher.
    expect(seitentext(0, 30, 0)).toBe('30 von 30');
  });
});
