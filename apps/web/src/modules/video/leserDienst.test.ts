import { getEventListeners } from 'node:events';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { AbbruchError } from '../stickers/engines/index.js';
import type { VideoLeser } from './bilderLesen.js';
import { KODIERUNGEN_MAX, LEERLAUF_MS, leserDienst, type KleinWunsch } from './leserDienst.js';

/**
 * Der geteilte Leser: Reihenfolge, Vorfahrt, ein Auftrag für voll und grau,
 * das kleine Bild und der Mitschnitt, Schliessen nach Ruhe.
 *
 * Der Ersatz für `VideoLeser` springt nicht wirklich; er schreibt mit, was
 * verlangt wurde, zählt die Sprünge (eine neue Stelle) und lässt sich von
 * Hand anhalten – auch die Kodierung kleiner Bilder.
 */

interface Aufruf {
  ms: number;
  klein: boolean;
}

const WUNSCH: KleinWunsch = { kante: 48, typ: 'image/webp', guete: 0.75 };

function ersatz() {
  const aufrufe: Aufruf[] = [];
  const kleine: number[] = [];
  const spruenge: number[] = [];
  let stelle: number | null = null;
  let geoeffnet = 0;
  let geschlossen = 0;
  let halten: Promise<void> | null = null;
  let loslassen: () => void = () => {};
  /** Die Kodierungen, die noch auf ihr Ende warten – `kodierenFertig` löst sie. */
  let kodierungHalten = false;
  const offeneKodierungen: Array<() => void> = [];
  const springen = (ms: number) => {
    if (stelle === ms) return;
    stelle = ms;
    spruenge.push(ms);
  };
  const oeffnen = async (): Promise<VideoLeser> => {
    geoeffnet += 1;
    return {
      breite: 96,
      hoehe: 54,
      quellBreite: 1920,
      quellHoehe: 1080,
      dauerMs: 5000,
      async kleinAn(ms, _wunsch, abbruch) {
        springen(ms);
        if (halten) await halten;
        if (abbruch?.aborted) throw new AbbruchError();
        kleine.push(ms);
        const kodiert = new Promise<Blob | null>((fertig) => {
          const ende = () => fertig(new Blob([String(ms)]));
          if (kodierungHalten) offeneKodierungen.push(ende);
          else ende();
        });
        return { kodiert };
      },
      async bildAn(ms, abbruch, groesse) {
        aufrufe.push({ ms, klein: groesse !== undefined });
        springen(ms);
        if (halten) await halten;
        if (abbruch?.aborted) throw new AbbruchError();
        const b = groesse?.b ?? 96;
        const h = groesse?.h ?? 54;
        return {
          data: new Uint8ClampedArray(b * h * 4).fill(ms % 256),
          width: b,
          height: h,
        } as ImageData;
      },
      schliessen() {
        geschlossen += 1;
      },
    };
  };
  return {
    oeffnen,
    aufrufe,
    kleine,
    spruenge,
    kodierungHalten(an: boolean) {
      kodierungHalten = an;
    },
    kodierenFertig() {
      for (const ende of offeneKodierungen.splice(0)) ende();
    },
    get geoeffnet() {
      return geoeffnet;
    },
    get geschlossen() {
      return geschlossen;
    },
    anhalten() {
      halten = new Promise((weiter) => {
        loslassen = () => {
          halten = null;
          weiter();
        };
      });
    },
    weiter() {
      loslassen();
    },
  };
}

const DATEI = new Blob([]);
const ruhe = async () => {
  for (let i = 0; i < 20; i += 1) await Promise.resolve();
};

afterEach(() => {
  vi.useRealTimers();
});

describe('leserDienst', () => {
  it('liefert voll und grau aus EINEM Auftrag an derselben Stelle', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const lesung = await dienst.holen(100, 'hinten', { voll: true, grau: true });
    expect(lesung.voll?.width).toBe(96);
    expect(lesung.grau?.breite).toBe(96);
    expect(e.aufrufe).toEqual([
      { ms: 100, klein: false },
      { ms: 100, klein: true },
    ]);
    // Ohne Angabe: das volle Bild, und nur das.
    const nurVoll = await dienst.holen(140, 'vorn');
    expect(nurVoll.grau).toBeNull();
    expect(nurVoll.voll).not.toBeNull();
    expect(e.geoeffnet).toBe(1);
    dienst.schliessen();
  });

  it("lässt 'vorn' vor jedem wartenden 'hinten' – einen Auftrag zur Zeit", async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const erste = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const zweite = dienst.holen(40, 'hinten', { grau: true });
    const editor = dienst.holen(2000, 'vorn');
    await ruhe();
    // Der laufende Sprung läuft allein.
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0]);
    e.weiter();
    await Promise.all([erste, editor, zweite]);
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0, 2000, 40]);
    dienst.schliessen();
  });

  it('nimmt einen abgebrochenen wartenden Auftrag heraus', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const erste = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const steuer = new AbortController();
    const zweite = dienst.holen(40, 'hinten', { grau: true, abbruch: steuer.signal });
    steuer.abort();
    await expect(zweite).rejects.toBeInstanceOf(AbbruchError);
    e.weiter();
    await erste;
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0]);
    dienst.schliessen();
  });

  it('schliesst nach Ruhe und öffnet beim nächsten Auftrag wieder', async () => {
    vi.useFakeTimers();
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    await dienst.holen(0, 'vorn');
    expect(dienst.offen).toBe(true);
    await vi.advanceTimersByTimeAsync(LEERLAUF_MS - 1000);
    expect(e.geschlossen).toBe(0);
    // Ein Auftrag setzt die Ruhe zurück.
    await dienst.holen(40, 'hinten', { grau: true });
    await vi.advanceTimersByTimeAsync(LEERLAUF_MS - 1000);
    expect(e.geschlossen).toBe(0);
    await vi.advanceTimersByTimeAsync(2000);
    expect(e.geschlossen).toBe(1);
    expect(dienst.offen).toBe(false);
    await dienst.holen(80, 'vorn');
    expect(e.geoeffnet).toBe(2);
    dienst.schliessen();
  });

  it('lässt beim Schliessen alle Wartenden scheitern und bricht den laufenden Sprung ab', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const laufend = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const wartend = dienst.holen(40, 'vorn');
    dienst.schliessen();
    e.weiter();
    await expect(wartend).rejects.toBeInstanceOf(AbbruchError);
    await expect(laufend).rejects.toBeInstanceOf(AbbruchError);
    expect(e.geschlossen).toBe(1);
    // Und danach geht es weiter – der Dienst gehört der Sitzung.
    expect((await dienst.holen(80, 'vorn')).voll).not.toBeNull();
    dienst.schliessen();
  });

  it('lässt nach einer Lesung keinen Horcher zurück – weder an der Sitzung noch am Auftrag', async () => {
    /*
     * Die Verfolgung reicht bei jeder Lesung ihr Fenstersignal herein. Ohne
     * Abmelden hing je Lesung ein Horcher mehr am Signal der Sitzung, das so
     * lange lebt wie das Blatt – nach tausenden Lesungen Megabyte, und jede
     * neue Anmeldung langsamer.
     */
    const e = ersatz();
    let sitzung: AbortSignal | undefined;
    const oeffnen: typeof e.oeffnen = async (...argumente: unknown[]) => {
      sitzung = (argumente[1] as { abbruch?: AbortSignal }).abbruch;
      return e.oeffnen();
    };
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen });
    const fenster = new AbortController();
    for (let i = 0; i < 300; i += 1) {
      await dienst.holen(i * 40, 'hinten', { grau: true, abbruch: fenster.signal });
    }
    expect(sitzung).toBeDefined();
    expect(getEventListeners(sitzung as AbortSignal, 'abort')).toHaveLength(0);
    expect(getEventListeners(fenster.signal, 'abort')).toHaveLength(0);
    dienst.schliessen();
  });

  it("lässt 'mitte' vor 'hinten', aber nach 'vorn' – und liefert jedem das Seine", async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    e.anhalten();
    const erste = dienst.holen(0, 'hinten', { grau: true });
    await ruhe();
    const hinten = dienst.holen(40, 'hinten', { grau: true });
    const mitte = dienst.holen(80, 'mitte', { voll: true });
    const vorn = dienst.holen(120, 'vorn');
    const mitte2 = dienst.holen(160, 'mitte', { voll: true });
    await ruhe();
    e.weiter();
    await Promise.all([erste, hinten, mitte, vorn, mitte2]);
    expect(e.aufrufe.map((a) => a.ms)).toEqual([0, 120, 80, 160, 40]);
    dienst.schliessen();
  });

  it('liefert ein kleines Bild, ohne auf die Kodierung zu warten', async () => {
    const e = ersatz();
    e.kodierungHalten(true);
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const lesung = await dienst.holen(140, 'mitte', { klein: WUNSCH });
    // Kein volles Bild, kein Grau – und der Dekodierer war frei, ohne dass kodiert war.
    expect(lesung.voll).toBeNull();
    expect(lesung.grau).toBeNull();
    expect(e.aufrufe).toEqual([]);
    expect(e.kleine).toEqual([140]);
    let fertig = false;
    const blob = lesung.klein?.then((b) => {
      fertig = true;
      return b;
    });
    await ruhe();
    expect(fertig).toBe(false);
    e.kodierenFertig();
    expect((await blob)?.size).toBe(3);
    dienst.schliessen();
  });

  it('schneidet mit, was der Speicher braucht – ohne einen zweiten Sprung', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const abgelegt: number[] = [];
    // Der Speicher hat k = 3 schon, k = 5 fehlt.
    dienst.mitschnittSetzen({
      wunsch: WUNSCH,
      braucht: (k) => k === 5,
      ablegen: (k) => abgelegt.push(k),
    });
    await dienst.holen(3.5 * 40, 'hinten', { grau: true });
    await dienst.holen(5.5 * 40, 'hinten', { grau: true });
    await ruhe();
    // Nur für k = 5, und das kleine Bild kam aus dem Sprung des Auftrags.
    expect(e.kleine).toEqual([220]);
    expect(e.spruenge).toEqual([140, 220]);
    expect(abgelegt).toEqual([5]);
    // Der Standbild-Auftrag des Editors schneidet ebenso mit.
    await dienst.holen(5.5 * 40, 'vorn');
    expect(e.kleine).toEqual([220, 220]);
    dienst.schliessen();
  });

  it('schneidet nicht an einer Stelle mit, die keine Rastermitte ist', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const gefragt: number[] = [];
    dienst.mitschnittSetzen({
      wunsch: WUNSCH,
      braucht: (k) => {
        gefragt.push(k);
        return true;
      },
      ablegen: () => undefined,
    });
    // 110 ms liegt im Rasterbild 2, aber nicht in dessen Mitte (100 ms).
    await dienst.holen(110, 'vorn');
    expect(gefragt).toEqual([]);
    expect(e.kleine).toEqual([]);
    dienst.schliessen();
  });

  it('schneidet nicht mehr mit, wenn der Mitschnitt zurückgenommen ist – und nie für einen kleinen Auftrag', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    let gefragt = 0;
    dienst.mitschnittSetzen({
      wunsch: WUNSCH,
      braucht: () => {
        gefragt += 1;
        return true;
      },
      ablegen: () => undefined,
    });
    // Ein Auftrag, der selbst ein kleines Bild holt, schneidet nicht noch eines mit.
    await dienst.holen(100, 'mitte', { klein: WUNSCH });
    expect(gefragt).toBe(0);
    expect(e.kleine).toEqual([100]);
    dienst.mitschnittSetzen(null);
    await dienst.holen(140, 'hinten', { grau: true });
    expect(gefragt).toBe(0);
    expect(e.kleine).toEqual([100]);
    dienst.schliessen();
  });

  it(`lässt höchstens ${KODIERUNGEN_MAX} Kodierungen offen – ein kleiner Auftrag wartet, ein anderer nicht`, async () => {
    const e = ersatz();
    e.kodierungHalten(true);
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    const a = dienst.holen(100, 'mitte', { klein: WUNSCH });
    const b = dienst.holen(140, 'mitte', { klein: WUNSCH });
    const c = dienst.holen(180, 'mitte', { klein: WUNSCH });
    await ruhe();
    await Promise.all([a, b]);
    // Der dritte wartet, bis eine Kodierung fertig ist.
    expect(e.kleine).toEqual([100, 140]);
    // Ein Auftrag mit vollem Bild überholt ihn.
    await dienst.holen(500, 'hinten');
    expect(e.aufrufe.map((x) => x.ms)).toEqual([500]);
    expect(e.kleine).toEqual([100, 140]);
    e.kodierenFertig();
    await c;
    expect(e.kleine).toEqual([100, 140, 180]);
    e.kodierenFertig();
    dienst.schliessen();
  });

  it('nimmt einen wartenden kleinen Auftrag bei Abbruch heraus', async () => {
    const e = ersatz();
    e.kodierungHalten(true);
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    await Promise.all([
      dienst.holen(100, 'mitte', { klein: WUNSCH }),
      dienst.holen(140, 'mitte', { klein: WUNSCH }),
    ]);
    const steuer = new AbortController();
    const wartend = dienst.holen(180, 'mitte', { klein: WUNSCH, abbruch: steuer.signal });
    steuer.abort();
    await expect(wartend).rejects.toBeInstanceOf(AbbruchError);
    e.kodierenFertig();
    await ruhe();
    expect(e.kleine).toEqual([100, 140]);
    dienst.schliessen();
  });

  it('meldet die Masse des Videos', async () => {
    const e = ersatz();
    const dienst = leserDienst(DATEI, 96, 40, { oeffnen: e.oeffnen });
    expect(await dienst.masse()).toEqual({
      breite: 96,
      hoehe: 54,
      quellBreite: 1920,
      quellHoehe: 1080,
      dauerMs: 5000,
    });
    dienst.schliessen();
  });
});
