import { beforeEach, describe, expect, it, vi } from 'vitest';
import { LIMITS } from '@initiative/shared';
import {
  direktMaxFuer,
  grenzenAusAntwort,
  grenzenLaden,
  grenzenZuruecksetzen,
  maxUploadBytesFuer,
} from './uploadGrenzen.js';

const GIB = 1024 * 1024 * 1024;

describe('Upload-Grenzen vom Server', () => {
  beforeEach(() => grenzenZuruecksetzen());

  it('gelten vor dem Laden als Konstanten aus dem gemeinsamen Paket', () => {
    expect(maxUploadBytesFuer('video')).toBe(LIMITS.maxUploadBytes.video);
    expect(direktMaxFuer('file')).toBe(LIMITS.direktUploadMax.file);
  });

  it('übernehmen die Zahlen des Servers (UPLOAD_MAX_BYTES gesenkt)', async () => {
    const holen = vi.fn().mockResolvedValue({
      maxUploadBytes: { video: 1 * GIB, file: 1 * GIB },
      direktUploadMax: { file: 50 * 1024 * 1024 },
      stueckGroesse: 8 * 1024 * 1024,
    });
    await grenzenLaden(holen);
    expect(maxUploadBytesFuer('video')).toBe(1 * GIB);
    expect(maxUploadBytesFuer('file')).toBe(1 * GIB);
    // Nicht genannte Arten fallen auf die Konstante zurück.
    expect(maxUploadBytesFuer('image')).toBe(LIMITS.maxUploadBytes.image);
    expect(direktMaxFuer('file')).toBe(50 * 1024 * 1024);
  });

  it('fragen nur einmal je Sitzung, auch bei gleichzeitigen Aufrufen', async () => {
    const holen = vi.fn().mockResolvedValue({ maxUploadBytes: { video: 2 * GIB } });
    await Promise.all([grenzenLaden(holen), grenzenLaden(holen)]);
    await grenzenLaden(holen);
    expect(holen).toHaveBeenCalledTimes(1);
    grenzenZuruecksetzen();
    await grenzenLaden(holen);
    expect(holen).toHaveBeenCalledTimes(2);
  });

  it('fallen bei einem Fehler auf die Konstanten zurück und versuchen es später neu', async () => {
    const kaputt = vi.fn().mockRejectedValue(new Error('offline'));
    await grenzenLaden(kaputt);
    expect(maxUploadBytesFuer('video')).toBe(LIMITS.maxUploadBytes.video);
    const gut = vi.fn().mockResolvedValue({ maxUploadBytes: { video: 3 * GIB } });
    await grenzenLaden(gut);
    expect(maxUploadBytesFuer('video')).toBe(3 * GIB);
  });

  it('ignorieren unbrauchbare Werte einer Antwort', () => {
    const g = grenzenAusAntwort({
      maxUploadBytes: { video: -5, file: Number.NaN, audio: 0 },
    } as never);
    expect(g.maxUploadBytes.video).toBe(LIMITS.maxUploadBytes.video);
    expect(g.maxUploadBytes.file).toBe(LIMITS.maxUploadBytes.file);
    expect(g.maxUploadBytes.audio).toBe(LIMITS.maxUploadBytes.audio);
    expect(grenzenAusAntwort(null).stueckGroesse).toBe(LIMITS.stueckGroesse);
  });
});
