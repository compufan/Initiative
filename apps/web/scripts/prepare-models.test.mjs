import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { afterEach, describe, expect, it } from 'vitest';

import { MODELLE, laden, vorkomprimieren } from './prepare-models.mjs';

/** Lizenzen, unter denen ein Modell mit der App ausgeliefert werden darf. */
const ERLAUBT = new Set(['MIT', 'Apache-2.0', 'BSD-2-Clause', 'BSD-3-Clause']);

describe('MODELLE', () => {
  it.each(MODELLE.map((m) => [m.name, m]))('%s ist festgenagelt und geprüft', (_, modell) => {
    // Eine Prüfsumme für JEDEN Download: Auch eine Adresse mit Fassungsnummer
    // im Pfad lässt sich auf dem Server neu belegen.
    expect(modell.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(ERLAUBT.has(modell.lizenz)).toBe(true);
    expect(modell.url.startsWith('https://')).toBe(true);
    // Kein beweglicher Verweis: `main`, `latest` oder ein Zweig statt eines Commits.
    expect(modell.url).not.toMatch(/\/(main|master|latest)\//);
    if (modell.url.includes('huggingface.co')) {
      expect(modell.url).toMatch(/\/resolve\/[0-9a-f]{40}\//);
    }
  });
});

const ordner = [];
async function frischerOrdner() {
  const pfad = await mkdtemp(join(tmpdir(), 'modelle-'));
  ordner.push(pfad);
  return pfad;
}

afterEach(async () => {
  for (const pfad of ordner.splice(0)) await rm(pfad, { recursive: true, force: true });
});

const gibtEs = (pfad) =>
  stat(pfad).then(
    () => true,
    () => false,
  );

describe('vorkomprimieren', () => {
  it('ersetzt eine alte .gz durch die der aktuellen Datei', async () => {
    const pfad = join(await frischerOrdner(), 'm.onnx');
    const inhalt = Buffer.alloc(1024 * 1024 + 7, 3);
    await writeFile(pfad, inhalt);
    await writeFile(`${pfad}.gz`, 'alt');
    await vorkomprimieren(pfad, inhalt.length);
    expect(gunzipSync(await readFile(`${pfad}.gz`)).equals(inhalt)).toBe(true);
    expect(await gibtEs(`${pfad}.gz.teil`)).toBe(false);
  });

  it('lässt nach einem Fehlschlag keine .gz zurück, die Caddy ausliefern würde', async () => {
    const pfad = join(await frischerOrdner(), 'fehlt.onnx');
    await writeFile(`${pfad}.gz`, 'alt');
    await vorkomprimieren(pfad, 2 * 1024 * 1024);
    expect(await gibtEs(`${pfad}.gz`)).toBe(false);
    expect(await gibtEs(`${pfad}.gz.teil`)).toBe(false);
  });
});

describe('laden', () => {
  it('lässt nach einem abgerissenen Download keine halbe Datei liegen', async () => {
    const server = createServer((_, antwort) => {
      antwort.writeHead(200, { 'content-length': '1000000' });
      antwort.write(Buffer.alloc(1000, 1));
      setTimeout(() => antwort.destroy(), 20);
    });
    await new Promise((fertig) => server.listen(0, '127.0.0.1', fertig));
    try {
      const { port } = server.address();
      const pfad = join(await frischerOrdner(), 'halb.onnx');
      await expect(laden(`http://127.0.0.1:${port}/m`, pfad)).rejects.toThrow();
      expect(await gibtEs(pfad)).toBe(false);
    } finally {
      server.close();
    }
  });
});
