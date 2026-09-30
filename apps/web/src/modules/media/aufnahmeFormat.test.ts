import { afterEach, describe, expect, it, vi } from 'vitest';
import { VIDEO_MIME_CANDIDATES, pickRecorderMime } from './helpers.js';

/**
 * In welchem Format die Kamera der App aufnimmt.
 *
 * Die Reihenfolge ist die ganze Entscheidung: `MediaRecorder` nimmt das erste,
 * das der Browser kann. Stand WebM mit VP9 vorn, bekam auch ein Chrome, der
 * längst MP4 kann, WebM – und AirPlay und ältere Chromecasts zeigten dann
 * „Format nicht unterstützt".
 */
function browserMit(kann: (typ: string) => boolean) {
  vi.stubGlobal('window', { MediaRecorder: class {} });
  vi.stubGlobal('MediaRecorder', { isTypeSupported: kann });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('VIDEO_MIME_CANDIDATES', () => {
  it('nimmt MP4 mit H.264 und AAC zuerst, WebM bleibt Rückfall', () => {
    expect(VIDEO_MIME_CANDIDATES[0]).toBe('video/mp4;codecs=avc1.640028,mp4a.40.2');
    const ersteWebm = VIDEO_MIME_CANDIDATES.findIndex((t) => t.startsWith('video/webm'));
    const letzteMp4 = VIDEO_MIME_CANDIDATES.map((t) => t.startsWith('video/mp4')).lastIndexOf(true);
    expect(letzteMp4).toBeLessThan(ersteWebm);
    expect(VIDEO_MIME_CANDIDATES).toContain('video/webm;codecs=vp9,opus');
    expect(VIDEO_MIME_CANDIDATES).toContain('video/webm');
  });

  it('wählt in einem Chrome mit MP4-Aufnahme das MP4', () => {
    browserMit(() => true);
    expect(pickRecorderMime(VIDEO_MIME_CANDIDATES)).toBe('video/mp4;codecs=avc1.640028,mp4a.40.2');
  });

  it('fällt in einem Browser ohne MP4-Aufnahme auf WebM zurück', () => {
    browserMit((typ) => typ.startsWith('video/webm'));
    expect(pickRecorderMime(VIDEO_MIME_CANDIDATES)).toBe('video/webm;codecs=vp9,opus');
  });

  it('nimmt ein schlichtes MP4, wo nur das angeboten wird (Safari)', () => {
    browserMit((typ) => typ === 'video/mp4');
    expect(pickRecorderMime(VIDEO_MIME_CANDIDATES)).toBe('video/mp4');
  });
});
