/**
 * Prüft die eine Regel, an der „Hohe Qualität“ zerbrochen ist:
 *
 *     no available backend found. ERR: [wasm] Error: worker not ready
 *
 * Die ONNX-Laufzeit erzeugt ihren Arbeiter genau einmal, beim Hochfahren, und
 * nur dann, wenn `env.wasm.proxy` in diesem Augenblick gesetzt ist. Danach
 * liest sie die Einstellung zwar bei jedem Aufruf neu – nur entsteht kein
 * Arbeiter mehr. Wer sie nachträglich umlegt, schickt die Laufzeit zu einem
 * Arbeiter, den es nie gegeben hat.
 *
 * Die Tests hier halten deshalb fest, dass die Entscheidung **einmal** fällt
 * und für jede Umgebung, die danach danach fragt, dieselbe ist.
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
 * Eine Grafikeinheit, die meldet, was ihr mitgegeben wird – und festhält,
 * womit das Gerät angefordert wurde.
 */
function grafik(grenzen: Record<string, number> | null) {
  const gefragt: Record<string, number>[] = [];
  const geraet = { es: 'ist das eigene Geraet' };
  return {
    gefragt,
    geraet,
    gpu: {
      requestAdapter: async () =>
        grenzen === null
          ? null
          : {
              limits: grenzen,
              requestDevice: async (o?: { requiredLimits?: Record<string, number> }) => {
                gefragt.push(o?.requiredLimits ?? {});
                return geraet;
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

describe('Der Arbeiter wird einmal entschieden', () => {
  it('legt „proxy“ nicht mehr um, egal wie oft gefragt wird', async () => {
    // Das ist der eigentliche Fehler gewesen: erst ohne Arbeiter starten,
    // dann für den Rückfall den Arbeiter wollen.
    const g = grafik({ maxStorageBuffersPerShaderStage: 20, maxBufferSize: 1 << 30 });
    const m = await laden(g.gpu);

    const erste = env();
    const zweite = env();
    await m.ortVorbereiten(erste, PFADE);
    await m.ortVorbereiten(zweite, PFADE);

    expect(erste.wasm.proxy).toBe(zweite.wasm.proxy);
  });

  it('fragt die Grafikeinheit nur ein einziges Mal', async () => {
    // Ein zweiter `requestDevice`-Aufruf gäbe ein zweites Gerät – und die
    // Sitzung liefe dann auf einem anderen als dem geprüften.
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);

    await m.ortVorbereiten(env(), PFADE);
    await m.ortVorbereiten(env(), PFADE);
    await m.laufzeitEntscheiden();

    expect(g.gefragt).toHaveLength(1);
  });
});

describe('Womit gerechnet wird', () => {
  it('nimmt die Grafikeinheit ohne Arbeiter, wenn die Puffer reichen', async () => {
    // Ein eigenes GPU-Gerät lässt sich nicht in einen Arbeiter reichen.
    const g = grafik({ maxStorageBuffersPerShaderStage: 12 });
    const m = await laden(g.gpu);

    const e = env();
    const laufzeit = await m.ortVorbereiten(e, PFADE);

    expect(laufzeit.geraet).toBe(g.geraet);
    expect(e.wasm.proxy).toBe(false);
  });

  it('nimmt den Arbeiter, wenn es kein WebGPU gibt', async () => {
    // Ohne Grafikeinheit dauert das Netz Minuten; im Hauptfaden stünde die
    // App so lange still.
    const m = await laden(undefined);

    const e = env();
    const laufzeit = await m.ortVorbereiten(e, PFADE);

    expect(laufzeit.geraet).toBeNull();
    expect(e.wasm.proxy).toBe(true);
    expect(laufzeit.grund).toMatch(/WebGPU/);
  });

  it('geht gar nicht erst auf die Grafikeinheit, wenn zu wenige Puffer gemeldet sind', async () => {
    // „Too many storage buffers in shader. Current: 11, Max is 10“ – das kam
    // erst mitten im Rechnen, und dann war der Arbeiter nicht mehr zu haben.
    const g = grafik({ maxStorageBuffersPerShaderStage: 10 });
    const m = await laden(g.gpu);

    const e = env();
    const laufzeit = await m.ortVorbereiten(e, PFADE);

    expect(laufzeit.geraet).toBeNull();
    expect(e.wasm.proxy).toBe(true);
    expect(laufzeit.grund).toContain('10');
    expect(g.gefragt).toHaveLength(0);
  });

  it('fordert die Grenzen an, die der Adapter meldet – nicht die Mindestwerte', async () => {
    // `requestDevice()` ohne `requiredLimits` gibt die Mindestwerte der
    // Spezifikation zurück, nicht das, was das Gerät kann. Genau daran ist es
    // auf dem Z Flip 6 gescheitert.
    const g = grafik({
      maxStorageBuffersPerShaderStage: 30,
      maxStorageBufferBindingSize: 2 ** 31,
      maxBufferSize: 2 ** 31,
      maxComputeInvocationsPerWorkgroup: 1024,
      maxComputeWorkgroupStorageSize: 32768,
    });
    const m = await laden(g.gpu);

    await m.ortVorbereiten(env(), PFADE);

    expect(g.gefragt[0]).toMatchObject({
      maxStorageBuffersPerShaderStage: 30,
      maxStorageBufferBindingSize: 2 ** 31,
      maxBufferSize: 2 ** 31,
    });
  });
});

describe('Nach einem Abbruch mitten im Rechnen', () => {
  it('nimmt beim nächsten Start den Prozessor', async () => {
    // Das Versprechen der Fehlermeldung lautet „lade neu, dann rechnet der
    // Prozessor“. Ohne Merkposten wäre das eine Lüge: die App liefe wieder in
    // denselben Abbruch.
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);
    expect((await m.ortVorbereiten(env(), PFADE)).geraet).toBe(g.geraet);

    m.grafikAufgeben('Device lost');

    // Neu geladen – aber derselbe Speicher, wie nach einem Neuladen der Seite.
    const alter = globalThis.localStorage;
    vi.resetModules();
    vi.stubGlobal('localStorage', alter);
    vi.stubGlobal('navigator', { gpu: g.gpu });
    const neu = await import('./ort-laufzeit.js');

    const e = env();
    const laufzeit = await neu.ortVorbereiten(e, PFADE);
    expect(laufzeit.geraet).toBeNull();
    expect(e.wasm.proxy).toBe(true);
    expect(laufzeit.grund).toContain('Device lost');
  });
});

describe('Die gemeinsamen Einstellungen', () => {
  it('setzt die Adressen der Laufzeit und einen einzigen Faden', async () => {
    // Mehrere Fäden brauchten COOP/COEP – die Kopfzeilen setzen wir nicht.
    const m = await laden(undefined);
    const e = env();
    await m.ortVorbereiten(e, PFADE);

    expect(e.wasm.wasmPaths).toEqual(PFADE);
    expect(e.wasm.numThreads).toBe(1);
  });
});
