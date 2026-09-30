import { fileURLToPath } from 'node:url';
import { build, transformWithEsbuild, type Rollup } from 'vite';
import { describe, expect, it } from 'vitest';
import {
  FERNSEH_ZIEL,
  fernsehblattFuerAlteGeraete,
  fernsehSkriptSenken,
  fernsehStilSenken,
  stueckeDesBlatts,
} from './fernsehblatt.js';

/**
 * Versteht ein Chromium 63 diesen Code?
 *
 * Gemessen, nicht geraten: esbuild druckt denselben Baum einmal für
 * `chrome63` und einmal ohne jede Grenze. Steht nichts darin, was älter als
 * Chromium 63 nicht kennt, sind beide Ausgaben gleich – jede neuere
 * Schreibweise (`??`, `?.`, `catch {}` …) würde für `chrome63` umgeschrieben
 * und machte den Unterschied. Das ist genauer als jede Suche nach Zeichen:
 * Ein `?.` in einer Zeichenkette ist keine optionale Verkettung.
 */
async function verstehtChromium63(code: string): Promise<boolean> {
  const alt = await transformWithEsbuild(code, 'probe.js', { target: FERNSEH_ZIEL, format: 'esm' });
  const neu = await transformWithEsbuild(code, 'probe.js', { target: 'esnext', format: 'esm' });
  return alt.code === neu.code;
}

describe('fernsehblatt – Absenken für ältere Fernseher', () => {
  it('senkt ab, was der Verkleinerer für ES2022 hineinschreibt', async () => {
    /*
     * Genau das tut esbuild beim Bau der App: Aus einem von Hand „alt"
     * geschriebenen `a != null ? a : b` wird `a ?? b`. Die Absenkung muss es
     * wieder herausnehmen.
     */
    const neu = 'export const f = (a, b) => { try { g(); } catch { h(); } return a?.x ?? b; };';
    expect(await verstehtChromium63(neu)).toBe(false);
    const { code } = await fernsehSkriptSenken(neu, 'tv.js');
    expect(await verstehtChromium63(code)).toBe(true);
    expect(code).not.toContain('??');
  });

  it('senkt `inset` im Stilblatt auf die vier Einzelwerte ab', async () => {
    const css = await fernsehStilSenken('.buehne{position:absolute;inset:0}', 'tv.css');
    expect(css).not.toMatch(/inset\s*:/);
    expect(css).toMatch(/top:0/);
    expect(css).toMatch(/left:0/);
  });

  it('nimmt den Einstieg und alles, was er lädt – und nichts von der App', () => {
    const stuecke = {
      'assets/tv-a.js': { isEntry: true, name: 'tv', imports: ['assets/mischen-b.js'] },
      'assets/mischen-b.js': { isEntry: false, name: 'mischen', imports: [] },
      'assets/index-c.js': {
        isEntry: true,
        name: 'index',
        imports: ['assets/mischen-b.js', 'assets/react-d.js'],
      },
      'assets/react-d.js': { isEntry: false, name: 'react', imports: [] },
    };
    expect([...stueckeDesBlatts(stuecke)].sort()).toEqual([
      'assets/mischen-b.js',
      'assets/tv-a.js',
    ]);
  });

  /*
   * Und der ganze Weg: `tv.html` wirklich bauen, mit demselben Ziel wie die
   * App (`es2022`), und nachsehen, was herauskommt.
   *
   * Ohne das Absenken fällt diese Prüfung – nachgemessen: Das gebaute Blatt
   * trug `??` und `catch{}`, das Stilblatt `inset:0`.
   */
  it('das gebaute Fernsehblatt versteht ein Chromium 63', async () => {
    const wurzel = fileURLToPath(new URL('..', import.meta.url));
    const ausgabe = (await build({
      configFile: false,
      root: wurzel,
      logLevel: 'silent',
      plugins: [fernsehblattFuerAlteGeraete()],
      build: {
        write: false,
        target: 'es2022',
        minify: true,
        sourcemap: false,
        copyPublicDir: false,
        rollupOptions: { input: { tv: `${wurzel}tv.html` } },
      },
    })) as Rollup.RollupOutput;

    const skripte = ausgabe.output.filter((d): d is Rollup.OutputChunk => d.type === 'chunk');
    const stile = ausgabe.output.filter(
      (d): d is Rollup.OutputAsset => d.type === 'asset' && d.fileName.endsWith('.css'),
    );
    expect(skripte.length).toBeGreaterThan(0);
    expect(stile.length).toBeGreaterThan(0);

    for (const skript of skripte) {
      expect(await verstehtChromium63(skript.code), `${skript.fileName} ist zu neu`).toBe(true);
      // Eine Methode, die der Bau nicht nachrüsten kann – siehe `leeren`.
      expect(skript.code, `${skript.fileName} ruft replaceChildren`).not.toContain(
        'replaceChildren',
      );
    }
    for (const stil of stile) {
      const text = String(stil.source);
      expect(text, `${stil.fileName} benutzt inset`).not.toMatch(/(^|[;{])inset\s*:/);
    }
  }, 60_000);
});
