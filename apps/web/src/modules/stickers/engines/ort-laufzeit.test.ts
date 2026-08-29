/**
 * Prüft zwei Regeln, an denen „Hohe Qualität“ nacheinander zerbrochen ist.
 *
 * 1. Die Entscheidung über die Grafikeinheit fällt **einmal**. Die ONNX-
 *    Laufzeit erzeugt ihren Arbeiter genau beim Hochfahren und nur dann, wenn
 *    `env.wasm.proxy` in diesem Augenblick gesetzt ist. Wer sie später
 *    umlegt, schickt sie zu einem Arbeiter, den es nie gegeben hat:
 *    `worker not ready`.
 *
 * 2. Ohne taugliche Grafikeinheit wird gar nicht erst angefangen. Nicht aus
 *    Vorsicht, sondern weil es nachgemessen ist: BiRefNet trägt Gewichte in
 *    halber Genauigkeit, dafür hat der Prozessorpfad keine Rechenwerke, und
 *    ein Bild bei halber Kantenlänge braucht 290 s auf einem Serverprozessor
 *    – gegen 1,7 s für „Beliebiges Objekt“. Ein stiller Rückfall dorthin war
 *    genau das, was der Anwender als „rechnet ewig“ gemeldet hat.
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
const GROSS = 128 * 1024 * 1024;

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
              // Die Bindungsgroesse ist fuer die meisten Faelle nebensaechlich;
              // wer sie pruefen will, gibt sie ausdruecklich an.
              limits: { maxStorageBufferBindingSize: GROSS, ...grenzen },
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
    const g = grafik({ maxStorageBuffersPerShaderStage: 10 });
    const m = await laden(g.gpu);

    const e = env();
    expect(await m.ortVorbereiten(e, PFADE)).toBe(g.geraet);
    expect(e.wasm.proxy).toBe(false);
  });

  it('fängt ohne WebGPU gar nicht erst an', async () => {
    // Der Prozessorpfad war die Falle: 290 s für ein Bild. Lieber ein Satz,
    // der auf „Beliebiges Objekt“ zeigt, als eine Viertelstunde Warten.
    const m = await laden(undefined);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Grafikeinheit/);
    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Beliebiges Objekt/);
  });

  it('nimmt eine Grafikeinheit, die 10 Puffer meldet – das Gerät des Anwenders', async () => {
    /*
     * Der Fall, an dem drei Runden gescheitert sind. Das Samsung Galaxy
     * Z Flip 6 meldet genau 10, und hier stand eine 11 – abgelesen aus der
     * Fehlermeldung „Current: 11, Max is 10“.
     *
     * Die 11 hat nie etwas bedeutet: ORTs Prüfung ist inkrementell und meldet
     * immer „Grenze + 1“. Das Modell braucht 7. Ein Gerät mit 10 hat also
     * reichlich Luft – und wurde trotzdem abgewiesen.
     */
    const g = grafik({ maxStorageBuffersPerShaderStage: 10 });
    const m = await laden(g.gpu);

    expect(await m.ortVorbereiten(env(), PFADE)).toBe(g.geraet);
  });

  it('nimmt auch den Mindestwert der Spezifikation, 8', async () => {
    // 8 ist der Wert, den jede regelkonforme Umsetzung zusichert. Wer den
    // abweist, weist ein Feld ab, das per Spezifikation reicht.
    const g = grafik({ maxStorageBuffersPerShaderStage: 8 });
    const m = await laden(g.gpu);

    expect(await m.ortVorbereiten(env(), PFADE)).toBe(g.geraet);
  });

  it('lehnt erst unterhalb der ausgezählten sieben ab – mit der Zahl', async () => {
    // Unter 7 reicht es wirklich nicht. Die gemeldete Zahl gehört in die
    // Meldung: ohne sie ist aus der Ferne nicht zu klären, woran es liegt.
    const g = grafik({ maxStorageBuffersPerShaderStage: 6 });
    const m = await laden(g.gpu);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/nur 6 Speicherpuffer/);
    expect(g.gefragt).toHaveLength(0);
  });

  it('lehnt ab, wenn kein Tensor am Stück gebunden werden kann', async () => {
    /*
     * Die zweite Grenze, ohne die die erste wertlos ist: Einen Tensor über
     * `maxStorageBufferBindingSize` zerlegt ORT in Segmente, und jedes Segment
     * belegt eine eigene Bindung. Ein Knoten mit 7 Tensoren käme dann auf ein
     * Vielfaches von 7. Genau hieran scheiterte die 1024er Fassung zusätzlich.
     */
    const g = grafik({
      maxStorageBuffersPerShaderStage: 16,
      maxStorageBufferBindingSize: 64 * 1024 * 1024,
    });
    const m = await laden(g.gpu);

    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/64 MiB am Stueck/);
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
  it('fängt beim nächsten Start gar nicht erst wieder an – und nennt den Grund', async () => {
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);
    expect(await m.ortVorbereiten(env(), PFADE)).toBe(g.geraet);

    m.grafikAufgeben('Device lost');

    // Neu geladen – aber derselbe Speicher, wie nach einem Neuladen der Seite.
    const alter = globalThis.localStorage;
    vi.resetModules();
    vi.stubGlobal('localStorage', alter);
    vi.stubGlobal('navigator', { gpu: g.gpu });
    const neu = await import('./ort-laufzeit.js');

    await expect(neu.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Device lost/);
  });

  it('vergisst den Abbruch nach einer Woche von selbst', async () => {
    // Ein Treiber wird erneuert, ein anderes Bild ist kleiner. Ein einziger
    // schlechter Tag darf das Verfahren nicht für immer abschalten.
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);
    m.grafikAufgeben('Device lost');

    const alter = globalThis.localStorage;
    const vorAchtTagen = Date.now() - 8 * 24 * 60 * 60 * 1000;
    alter.setItem(
      'initiative.webgpu.aufgegeben',
      JSON.stringify({ grund: 'Device lost', zeit: vorAchtTagen }),
    );

    vi.resetModules();
    vi.stubGlobal('localStorage', alter);
    vi.stubGlobal('navigator', { gpu: g.gpu });
    const neu = await import('./ort-laufzeit.js');

    expect(await neu.ortVorbereiten(env(), PFADE)).toBe(g.geraet);
  });

  it('lässt sich auf Wunsch sofort wieder versuchen', async () => {
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);
    m.grafikAufgeben('Device lost');
    await expect(m.ortVorbereiten(env(), PFADE)).rejects.toThrow(/Device lost/);

    m.grafikVergessen();
    expect(await m.ortVorbereiten(env(), PFADE)).toBe(g.geraet);
  });
});

describe('Die gemeinsamen Einstellungen', () => {
  it('setzt die Adressen der Laufzeit und einen einzigen Faden', async () => {
    // Mehrere Fäden brauchten COOP/COEP – die Kopfzeilen setzen wir nicht.
    const g = grafik({ maxStorageBuffersPerShaderStage: 20 });
    const m = await laden(g.gpu);
    const e = env();
    await m.ortVorbereiten(e, PFADE);

    expect(e.wasm.wasmPaths).toEqual(PFADE);
    expect(e.wasm.numThreads).toBe(1);
  });
});
