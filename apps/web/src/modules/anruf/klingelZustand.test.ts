import { describe, expect, it } from 'vitest';
import {
  RUHE,
  endeText,
  istBelegt,
  qualitaet,
  uebergang,
  type AnrufZustand,
} from './klingelZustand.js';
import { periodeMs, tonfolge } from './klingelton.js';

const eingehend = (z: AnrufZustand = RUHE) =>
  uebergang(z, { typ: 'angebot', anrufId: 'a1', conversationId: 'c', von: 'bob', video: true });

describe('Klingel-Zustandsmaschine', () => {
  it('ausgehend: wählen → klingeln → verbinden → verbunden → vorbei → Ruhe', () => {
    let z = uebergang(RUHE, {
      typ: 'anrufen',
      anrufId: 'x',
      conversationId: 'c',
      gegenueber: 'bob',
      video: false,
    });
    expect(z.phase).toBe('waehlt');
    expect(z.richtung).toBe('aus');
    z = uebergang(z, { typ: 'gesendet', anrufId: 'x' });
    expect(z.phase).toBe('klingelt_aus');
    z = uebergang(z, { typ: 'antwort', anrufId: 'x' });
    expect(z.phase).toBe('verbindet');
    z = uebergang(z, { typ: 'verbunden', anrufId: 'x', jetzt: 1000 });
    expect(z.phase).toBe('verbunden');
    expect(z.verbundenSeit).toBe(1000);
    z = uebergang(z, { typ: 'ende', anrufId: 'x', grund: 'aufgelegt' });
    expect(z.phase).toBe('vorbei');
    expect(z.grund).toBe('aufgelegt');
    expect(uebergang(z, { typ: 'aufraeumen' })).toEqual(RUHE);
  });

  it('eingehend: klingeln → annehmen → verbindet', () => {
    let z = eingehend();
    expect(z.phase).toBe('klingelt_ein');
    expect(z.gegenueber).toBe('bob');
    expect(z.video).toBe(true);
    z = uebergang(z, { typ: 'annehmen', anrufId: 'a1' });
    expect(z.phase).toBe('verbindet');
  });

  it('angenommen auf einem anderen Gerät beendet nur das Klingeln', () => {
    const klingelt = eingehend();
    const anderswo = uebergang(klingelt, { typ: 'angenommen_anderswo', anrufId: 'a1' });
    expect(anderswo.phase).toBe('vorbei');
    expect(anderswo.grund).toBe('anderswo');
    // Das Gerät, das selbst angenommen hat, bleibt im Gespräch.
    const selbst = uebergang(klingelt, { typ: 'annehmen', anrufId: 'a1' });
    expect(uebergang(selbst, { typ: 'angenommen_anderswo', anrufId: 'a1' })).toBe(selbst);
  });

  it('ein zweites Angebot übernimmt kein laufendes Gespräch', () => {
    const z = uebergang(eingehend(), { typ: 'annehmen', anrufId: 'a1' });
    const zweites = uebergang(z, {
      typ: 'angebot',
      anrufId: 'a2',
      conversationId: 'd',
      von: 'eve',
      video: false,
    });
    expect(zweites).toBe(z);
    expect(istBelegt(z)).toBe(true);
  });

  it('Ereignisse eines anderen Anrufs ändern nichts', () => {
    const z = eingehend();
    expect(uebergang(z, { typ: 'ende', anrufId: 'alt', grund: 'zeitlimit' })).toBe(z);
    expect(uebergang(z, { typ: 'annehmen', anrufId: 'alt' })).toBe(z);
    expect(uebergang(z, { typ: 'verbunden', anrufId: 'a1', jetzt: 1 })).toBe(z);
  });

  it('ende ohne Kennung gilt dem laufenden, in Ruhe nichts', () => {
    const z = uebergang(eingehend(), { typ: 'ende', anrufId: null, grund: 'fehler', hinweis: 'x' });
    expect(z.phase).toBe('vorbei');
    expect(z.hinweis).toBe('x');
    expect(uebergang(RUHE, { typ: 'ende', anrufId: null, grund: 'fehler' })).toBe(RUHE);
  });

  it('nach dem Ende darf wieder ein Anruf kommen', () => {
    const vorbei = uebergang(eingehend(), { typ: 'ende', anrufId: 'a1', grund: 'zeitlimit' });
    expect(istBelegt(vorbei)).toBe(false);
    expect(eingehend(vorbei).phase).toBe('klingelt_ein');
  });

  it('sagt das Ende aus der richtigen Sicht', () => {
    expect(endeText('zeitlimit', 'aus')).toBe('Keine Antwort');
    expect(endeText('zeitlimit', 'ein')).toBe('Verpasster Anruf');
    expect(endeText('besetzt', 'aus')).toBe('Besetzt');
  });

  it('schätzt die Qualität', () => {
    expect(qualitaet(null, null)).toBeNull();
    expect(qualitaet(80, 0)).toBe('gut');
    expect(qualitaet(300, 0)).toBe('mittel');
    expect(qualitaet(80, 0.2)).toBe('schlecht');
  });
});

describe('Tonfolge', () => {
  it('Freizeichen: eine Sekunde 425 Hz, vier Sekunden Ruhe', () => {
    const folge = tonfolge('ausgehend');
    expect(folge[0]).toEqual({ hz: 425, ms: 1000 });
    expect(periodeMs(folge)).toBe(5000);
  });

  it('Klingeln hat Töne und eine Pause und wiederholt sich unter drei Sekunden', () => {
    const folge = tonfolge('eingehend');
    expect(folge.some((ton) => ton.hz === 0)).toBe(true);
    expect(folge.filter((ton) => ton.hz > 0).length).toBeGreaterThanOrEqual(2);
    expect(periodeMs(folge)).toBeLessThan(3000);
  });
});
