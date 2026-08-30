/**
 * Hält die Regeln fest, an denen „Hohe Qualität“ nacheinander zerbrochen ist.
 *
 * Die Reihe ist lehrreich, deshalb steht sie hier: Erst wurde `proxy` mitten
 * im Lauf umgelegt (`worker not ready`), dann eine Zahl aus einer
 * Fehlermeldung als Bedarf gelesen (Geräte grundlos abgewiesen), dann ein
 * eigenes `GPUDevice` eingeschleust – und damit ORT der Block übersprungen,
 * der `shader-f16` anfordert (`requires f16 but the device does not support
 * it`). Jedes Mal war die Ursache dieselbe: an der Laufzeit vorbei etwas
 * selbst regeln wollen, was sie besser weiss.
 *
 * Deshalb prüfen die Tests hier vor allem, was NICHT mehr passiert.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

type Env = { wasm: { wasmPaths?: unknown; numThreads?: number; proxy?: boolean } };

const PFADE = { wasm: '/ort.wasm', mjs: '/ort.mjs' };

function env(): Env {
  return { wasm: {} };
}

/** Ein Speicher, den es in der Testumgebung sonst nicht gibt. */
function speicher() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
}

/**
 * Eine Grafikeinheit, die meldet, was ihr mitgegeben wird – und festhält, ob
 * jemand versucht hat, ein eigenes Gerät anzufordern.
 */
function grafik(faehigkeiten: string[] | null) {
  const geraeteVersuche: unknown[] = [];
  return {
    geraeteVersuche,
    gpu: {
      requestAdapter: async () =>
        faehigkeiten === null
          ? null
          : {
              features: { has: (name: string) => faehigkeiten.includes(name) },
              // Wer das hier aufruft, macht den Fehler von damals.
              requestDevice: async (o?: unknown) => {
                geraeteVersuche.push(o);
                return { es: 'ist ein Geraet ohne Faehigkeiten' };
              },
            },
    },
  };
}

let modul: typeof import('./ort-laufzeit.js');

async function laden(gpu?: unknown): Promise<typeof import('./ort-laufzeit.js')> {
  vi.resetModules();
  vi.stubGlobal('localStorage', speicher());
  vi.stubGlobal('navigator', gpu ? { gpu } : {});
  modul = await import('./ort-laufzeit.js');
  return modul;
}

beforeEach(() => {
  vi.unstubAllGlobals();
});

describe('Die Laufzeit macht ihr Gerät selbst', () => {
  it('fordert KEIN eigenes Gerät an', async () => {
    /*
     * Der Fehler der letzten Runde. Ein selbst angefordertes Gerät lässt ORT
     * den Block überspringen, der Fähigkeiten UND Grenzen besorgt
     * (webgpu_context.cc:60). Das Fähigkeitsverzeichnis wird danach trotzdem
     * gefüllt – aus dem mitgebrachten Gerät. Und das hat laut Spezifikation
     * „exactly the specified set of features, and no more or less“: keine.
     */
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);

    await m.ortVorbereiten(env(), PFADE);

    expect(g.geraeteVersuche).toHaveLength(0);
  });

  it('fragt den Adapter nur ein einziges Mal', async () => {
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);
    let gefragt = 0;
    const zaehlend = {
      requestAdapter: async () => {
        gefragt += 1;
        return (await g.gpu.requestAdapter()) as never;
      },
    };
    vi.resetModules();
    vi.stubGlobal('localStorage', speicher());
    vi.stubGlobal('navigator', { gpu: zaehlend });
    const neu = await import('./ort-laufzeit.js');

    await neu.ortVorbereiten(env(), PFADE);
    await neu.ortVorbereiten(env(), PFADE);
    await neu.laufzeitEntscheiden();

    expect(gefragt).toBe(1);
  });
});

describe('Womit gerechnet wird', () => {
  it('lässt zu, wenn der Adapter halbe Genauigkeit kann', async () => {
    const g = grafik(['shader-f16', 'timestamp-query']);
    const m = await laden(g.gpu);

    const e = env();
    await expect(m.ortVorbereiten(e, PFADE)).resolves.toBeUndefined();
    expect((await m.laufzeitEntscheiden()).taugt).toBe(true);
  });

  it('lehnt ab, wenn dem Adapter shader-f16 fehlt – und sagt es', async () => {
    /*
     * Alle 437 Gewichtstensoren liegen in halber Genauigkeit. Ohne
     * `shader-f16` bricht ORT vor dem ersten Shader ab. Das gehört vor den
     * Download von 78 MB, nicht danach.
     */
    const g = grafik(['timestamp-query']);
    const m = await laden(g.gpu);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/shader-f16/);
    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/halber Genauigkeit/);
  });

  it('fängt ohne WebGPU gar nicht erst an', async () => {
    // Der Prozessorpfad war die Falle: 295 s für ein Bild gegen 1,7 s bei
    // „Niedrige Qualität“. Lieber ein Satz, der dorthin zeigt.
    const m = await laden(undefined);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/WebGPU/);
    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Niedrige Qualität/);
  });

  it('lehnt ab, wenn gar kein Adapter zu bekommen ist', async () => {
    const g = grafik(null);
    const m = await laden(g.gpu);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/keine Grafikeinheit/i);
  });
});

describe('Nach einem Abbruch mitten im Rechnen', () => {
  it('fängt beim nächsten Start gar nicht erst wieder an – und nennt den Grund', async () => {
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);
    await m.ortVorbereiten(env(), PFADE);

    m.grafikAufgeben('Device lost');

    // Neu geladen – aber derselbe Speicher, wie nach einem Neuladen der Seite.
    const alter = globalThis.localStorage;
    vi.resetModules();
    vi.stubGlobal('localStorage', alter);
    vi.stubGlobal('navigator', { gpu: g.gpu });
    const neu = await import('./ort-laufzeit.js');

    await expect(neu.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Device lost/);
    expect((await neu.laufzeitEntscheiden()).gemerkt).toBe(true);
  });

  it('vergisst den Abbruch nach einer Woche von selbst', async () => {
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);
    m.grafikAufgeben('Device lost');

    const alter = globalThis.localStorage;
    alter.setItem(
      'initiative.webgpu.aufgegeben',
      JSON.stringify({ grund: 'Device lost', zeit: Date.now() - 8 * 24 * 60 * 60 * 1000 }),
    );

    vi.resetModules();
    vi.stubGlobal('localStorage', alter);
    vi.stubGlobal('navigator', { gpu: g.gpu });
    const neu = await import('./ort-laufzeit.js');

    await expect(neu.ortVorbereiten(env(), PFADE)).resolves.toBeUndefined();
  });

  it('lässt sich auf Wunsch sofort wieder versuchen', async () => {
    // Ohne diesen Weg sperrt ein einmaliger Fehler das Verfahren sieben Tage
    // lang unwiderruflich aus. Am Knopf haengt `grafikVergessen`.
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);
    m.grafikAufgeben('Device lost');
    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Device lost/);

    m.grafikVergessen();
    await expect(m.ortVorbereiten(env(), PFADE)).resolves.toBeUndefined();
  });
});

describe('Die gemeinsamen Einstellungen', () => {
  it('setzt die Adressen der Laufzeit und einen einzigen Faden', async () => {
    // Mehrere Fäden brauchten COOP/COEP – die Kopfzeilen setzen wir nicht.
    const g = grafik(['shader-f16']);
    const m = await laden(g.gpu);
    const e = env();
    await m.ortVorbereiten(e, PFADE);

    expect(e.wasm.wasmPaths).toEqual(PFADE);
    expect(e.wasm.numThreads).toBe(1);
    expect(e.wasm.proxy).toBe(false);
  });
});
