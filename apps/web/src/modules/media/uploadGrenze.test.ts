import { afterEach, describe, expect, it, vi } from 'vitest';
import { grenzenLaden, grenzenZuruecksetzen } from '../../lib/uploadGrenzen.js';
import { inStuecken } from '../../lib/upload.js';
import { withinUploadLimit } from './helpers.js';

const toasts = vi.hoisted(() => [] as string[]);
vi.mock('../../state/ui.js', async (original) => {
  const echt = await original<typeof import('../../state/ui.js')>();
  return { ...echt, toast: (text: string) => void toasts.push(text) };
});

const MIB = 1024 * 1024;

describe('withinUploadLimit nutzt die Grenze des Servers', () => {
  afterEach(() => {
    grenzenZuruecksetzen();
    toasts.length = 0;
  });

  it('lässt 600 MiB mit der Vorgabe zu, lehnt sie ab, wenn der Server 500 MiB erlaubt', async () => {
    expect(withinUploadLimit('file', 600 * MIB, 'a.bin')).toBe(true);
    await grenzenLaden(async () => ({ maxUploadBytes: { file: 500 * MIB } }));
    toasts.length = 0;
    expect(withinUploadLimit('file', 600 * MIB, 'a.bin')).toBe(false);
    expect(toasts.join(' ')).toMatch(/zu groß/);
    expect(withinUploadLimit('file', 400 * MIB, 'b.bin')).toBe(true);
  });

  it('wählt den Weg in Stücken nach der direkten Grenze des Servers', async () => {
    const anhang = { kind: 'file' } as never;
    expect(inStuecken(anhang, 60 * MIB)).toBe(true); // über stueckUploadAb
    expect(inStuecken(anhang, 10 * MIB)).toBe(false);
    await grenzenLaden(async () => ({ direktUploadMax: { file: 5 * MIB } }));
    expect(inStuecken(anhang, 10 * MIB)).toBe(true);
  });
});
