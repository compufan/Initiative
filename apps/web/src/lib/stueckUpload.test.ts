import { describe, expect, it, vi } from 'vitest';
import type { AttachmentDto } from '@initiative/shared';
import {
  stueckSha256,
  Rate,
  empfangeneBytes,
  offeneStuecke,
  restSekunden,
  restzeitText,
  stueckAnzahl,
  stueckBereich,
  stueckweiseHochladen,
  wartezeitMs,
  wiederholbar,
  type StueckStand,
  type StueckTransport,
} from './stueckUpload.js';

describe('Stückplanung', () => {
  it('teilt eine Datei in Stücke mit kürzerem letztem Stück', () => {
    expect(stueckAnzahl(0, 8)).toBe(0);
    expect(stueckAnzahl(8, 8)).toBe(1);
    expect(stueckAnzahl(17, 8)).toBe(3);
    expect(stueckBereich(2, 17, 8)).toEqual({ start: 16, ende: 17 });
    expect(stueckBereich(0, 17, 8)).toEqual({ start: 0, ende: 8 });
  });

  it('kennt die fehlenden Stücke – auch bei Lücken und Doppelten', () => {
    expect(offeneStuecke(40, 8, [])).toEqual([0, 1, 2, 3, 4]);
    expect(offeneStuecke(40, 8, [3, 0, 3])).toEqual([1, 2, 4]);
    expect(offeneStuecke(40, 8, [0, 1, 2, 3, 4])).toEqual([]);
  });

  it('zählt empfangene Bytes mit dem kurzen letzten Stück richtig', () => {
    expect(empfangeneBytes(17, 8, [0, 2])).toBe(9);
    expect(empfangeneBytes(17, 8, [2, 2])).toBe(1);
  });
});

describe('Wartezeit und Wiederholen', () => {
  it('verdoppelt ab einer Sekunde und deckelt bei dreissig', () => {
    const mitte = () => 0.5;
    expect(wartezeitMs(1, mitte)).toBe(1000);
    expect(wartezeitMs(2, mitte)).toBe(2000);
    expect(wartezeitMs(4, mitte)).toBe(8000);
    expect(wartezeitMs(10, mitte)).toBe(30_000);
    // Streuung: ±25 %
    expect(wartezeitMs(1, () => 0)).toBe(750);
    expect(wartezeitMs(1, () => 1)).toBe(1250);
  });

  it('wiederholt bei Netz und Überlast, nicht bei Unsinn oder voller Platte', () => {
    expect(wiederholbar({ status: 0 })).toBe(true);
    expect(wiederholbar({ status: 503 })).toBe(true);
    expect(wiederholbar({ status: 429 })).toBe(true);
    expect(wiederholbar({ status: 400 })).toBe(false);
    expect(wiederholbar({ status: 404 })).toBe(false);
    expect(wiederholbar({ status: 507 })).toBe(false);
    expect(wiederholbar(new DOMException('weg', 'AbortError'))).toBe(false);
  });
});

describe('Restzeit', () => {
  it('rechnet aus der gemittelten Rate', () => {
    const rate = new Rate();
    rate.melden(0, 0);
    rate.melden(1_000_000, 1000);
    rate.melden(2_000_000, 2000);
    expect(rate.bytesProSekunde()).toBe(1_000_000);
    expect(restSekunden(10_000_000, 2_000_000, rate.bytesProSekunde())).toBe(8);
    expect(restSekunden(10, 0, null)).toBeNull();
    expect(restzeitText(30)).toBe('noch weniger als 1 min');
    expect(restzeitText(150)).toBe('noch 3 min');
    expect(restzeitText(3600 + 120)).toBe('noch 1 h 2 min');
  });
});

/** Ein Server im Speicher – mit Schaltern für Ausfälle. */
function attrappe(stueckGroesse = 4) {
  const sitzungen = new Map<string, { groesse: number; daten: Uint8Array; da: Set<number> }>();
  let naechste = 1;
  const ausfall = { vorSenden: 0, offlineAb: Infinity, gesendet: 0 };
  const anlegen = vi.fn(async ({ size }: { size: number }) => {
    const id = `s${naechste++}`;
    sitzungen.set(id, { groesse: size, daten: new Uint8Array(size), da: new Set() });
    return stand(id);
  });
  function stand(id: string): StueckStand {
    const s = sitzungen.get(id)!;
    return {
      sitzungId: id,
      attachmentId: `a-${id}`,
      groesse: s.groesse,
      stueckGroesse,
      anzahl: stueckAnzahl(s.groesse, stueckGroesse),
      empfangen: [...s.da],
      empfangenBytes: empfangeneBytes(s.groesse, stueckGroesse, s.da),
      status: 'offen',
      ablaufAt: '',
    };
  }
  const transport: StueckTransport = {
    anlegen,
    stand: async (id) => (sitzungen.has(id) ? stand(id) : null),
    async senden(id, start, stueck) {
      if (ausfall.vorSenden > 0) {
        ausfall.vorSenden -= 1;
        throw { status: 0 };
      }
      if (ausfall.gesendet >= ausfall.offlineAb) throw { status: 0 };
      ausfall.gesendet += 1;
      const s = sitzungen.get(id)!;
      s.daten.set(new Uint8Array(await stueck.arrayBuffer()), start);
      s.da.add(start / stueckGroesse);
    },
    async abschliessen(id) {
      const s = sitzungen.get(id)!;
      if (s.da.size !== stueckAnzahl(s.groesse, stueckGroesse)) throw { status: 409 };
      return { id: `a-${id}`, size: s.groesse } as unknown as AttachmentDto;
    },
    abbrechen: vi.fn(async (id: string) => void sitzungen.delete(id)),
  };
  return { transport, sitzungen, ausfall, anlegen };
}

const sofort = async () => {};
const inhalt = (n: number) => new Blob([Uint8Array.from({ length: n }, (_, i) => i % 251)]);

describe('stueckweiseHochladen', () => {
  it('lädt alle Stücke hoch und meldet Fortschritt bis 100 %', async () => {
    const { transport, sitzungen } = attrappe();
    const meldungen: number[] = [];
    const datei = inhalt(18);
    const fertig = await stueckweiseHochladen({
      datei,
      kind: 'file',
      mime: 'application/octet-stream',
      metadaten: {},
      transport,
      schlafen: sofort,
      onFortschritt: (f) => meldungen.push(f.geladen),
    });
    expect(fertig.id).toBe('a-s1');
    expect(meldungen.at(-1)).toBe(18);
    expect([...sitzungen.get('s1')!.daten]).toEqual([...new Uint8Array(await datei.arrayBuffer())]);
  });

  it('wiederholt ein abgerissenes Stück mit Pause', async () => {
    const { transport, ausfall } = attrappe();
    ausfall.vorSenden = 2;
    const schlafen = vi.fn(sofort);
    await stueckweiseHochladen({
      datei: inhalt(8),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen,
      parallel: 1,
    });
    expect(schlafen).toHaveBeenCalledTimes(2);
  });

  it('setzt nach einem Abriss mit derselben Sitzung fort, ohne Empfangenes neu zu senden', async () => {
    const { transport, ausfall, anlegen } = attrappe();
    let sitzung: string | null = null;
    ausfall.offlineAb = 2; // nach zwei Stücken ist das Netz weg
    const datei = inhalt(20); // 5 Stücke
    await expect(
      stueckweiseHochladen({
        datei,
        kind: 'file',
        mime: 'x/y',
        metadaten: {},
        transport,
        schlafen: sofort,
        parallel: 1,
        maxVersuche: 2,
        onSitzung: (id) => void (sitzung = id),
      }),
    ).rejects.toEqual({ status: 0 });
    expect(sitzung).toBe('s1');

    // Netz wieder da – zweiter Anlauf mit der gemerkten Sitzung.
    ausfall.offlineAb = Infinity;
    const vorher = ausfall.gesendet;
    const meldungen: number[] = [];
    const fertig = await stueckweiseHochladen({
      datei,
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      sitzungId: sitzung,
      onFortschritt: (f) => meldungen.push(f.geladen),
    });
    expect(fertig.id).toBe('a-s1');
    expect(anlegen).toHaveBeenCalledTimes(1);
    expect(ausfall.gesendet - vorher).toBe(3);
    // Der Fortschritt fängt beim Stand des Servers an, nicht bei null.
    expect(meldungen[0]).toBe(8);
  });

  it('legt neu an, wenn die gemerkte Sitzung weg ist oder nicht zur Datei passt', async () => {
    const { transport, anlegen } = attrappe();
    await stueckweiseHochladen({
      datei: inhalt(4),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      sitzungId: 'gibts-nicht',
    });
    expect(anlegen).toHaveBeenCalledTimes(1);

    const alt = await transport.anlegen({ kind: 'file', mime: 'x/y', size: 99 });
    await stueckweiseHochladen({
      datei: inhalt(4),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      sitzungId: alt.sitzungId,
    });
    expect(transport.abbrechen).toHaveBeenCalledWith(alt.sitzungId);
  });

  it('hält höchstens `parallel` Stücke gleichzeitig in der Luft', async () => {
    const { transport } = attrappe(1);
    let gleichzeitig = 0;
    let hoechstens = 0;
    const senden = transport.senden;
    transport.senden = async (...args) => {
      gleichzeitig += 1;
      hoechstens = Math.max(hoechstens, gleichzeitig);
      await new Promise((r) => setTimeout(r, 1));
      await senden(...args);
      gleichzeitig -= 1;
    };
    await stueckweiseHochladen({
      datei: inhalt(12),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      parallel: 3,
    });
    expect(hoechstens).toBe(3);
  });

  it('bricht auf Wunsch ab, ohne weiter zu senden', async () => {
    const { transport, ausfall } = attrappe();
    const abbruch = new AbortController();
    const senden = transport.senden;
    transport.senden = async (...args) => {
      await senden(...args);
      abbruch.abort();
    };
    await expect(
      stueckweiseHochladen({
        datei: inhalt(40),
        kind: 'file',
        mime: 'x/y',
        metadaten: {},
        transport,
        schlafen: sofort,
        parallel: 1,
        signal: abbruch.signal,
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });
    expect(ausfall.gesendet).toBe(1);
  });
});

describe('Prüfsumme je Stück', () => {
  it('berechnet SHA-256 über genau das Stück (bekannter Wert)', async () => {
    // SHA-256("abc")
    expect(await stueckSha256(new Blob(['abc']))).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(await stueckSha256(new Blob([]))).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
  });

  it('schickt zu jedem Stück die Summe genau dieses Stücks mit', async () => {
    const { transport } = attrappe();
    const gesehen: { start: number; sha?: string; laenge: number }[] = [];
    const senden = transport.senden;
    transport.senden = async (id, start, stueck, gesamt, signal, sha) => {
      gesehen.push({ start, sha, laenge: stueck.size });
      await senden(id, start, stueck, gesamt, signal, sha);
    };
    const datei = inhalt(10);
    await stueckweiseHochladen({
      datei,
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      parallel: 1,
    });
    expect(gesehen.map((g) => g.start)).toEqual([0, 4, 8]);
    for (const g of gesehen) {
      const erwartet = await stueckSha256(datei.slice(g.start, g.start + g.laenge));
      expect(g.sha).toBe(erwartet);
    }
  });

  it('wiederholt ein Stück bei 422 (Summe stimmt am Server nicht) mit derselben Summe', async () => {
    const { transport } = attrappe();
    const senden = transport.senden;
    const versuche: (string | undefined)[] = [];
    let abgewiesen = false;
    transport.senden = async (id, start, stueck, gesamt, signal, sha) => {
      if (start === 4) {
        versuche.push(sha);
        if (!abgewiesen) {
          abgewiesen = true;
          throw { status: 422 };
        }
      }
      await senden(id, start, stueck, gesamt, signal, sha);
    };
    const fertig = await stueckweiseHochladen({
      datei: inhalt(10),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      parallel: 1,
    });
    expect(fertig.size).toBe(10);
    expect(versuche).toHaveLength(2);
    expect(versuche[0]).toBe(versuche[1]);
  });

  it('gibt nach zu vielen 422 auf, statt endlos zu wiederholen', async () => {
    const { transport } = attrappe();
    transport.senden = async () => {
      throw { status: 422 };
    };
    await expect(
      stueckweiseHochladen({
        datei: inhalt(10),
        kind: 'file',
        mime: 'x/y',
        metadaten: {},
        transport,
        schlafen: sofort,
        parallel: 1,
        maxVersuche: 3,
      }),
    ).rejects.toMatchObject({ status: 422 });
  });

  it('lädt ohne Summe hoch, wo WebCrypto fehlt', async () => {
    const { transport } = attrappe();
    const gesehen: (string | undefined)[] = [];
    const senden = transport.senden;
    transport.senden = async (id, start, stueck, gesamt, signal, sha) => {
      gesehen.push(sha);
      await senden(id, start, stueck, gesamt, signal, sha);
    };
    await stueckweiseHochladen({
      datei: inhalt(6),
      kind: 'file',
      mime: 'x/y',
      metadaten: {},
      transport,
      schlafen: sofort,
      stueckSumme: async () => undefined,
    });
    expect(gesehen).toEqual([undefined, undefined]);
  });
});
