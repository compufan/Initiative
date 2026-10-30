import type { ComponentProps, ComponentType, JSXElementConstructor } from 'react';
import { nachladbar } from '../components/Nachladen.js';
// Nur Typen: `import type` verschwindet beim Bauen und zieht den Code NICHT
// ins Start-Stück – genau das, was diese Datei verhindern soll.
import type { BildEditor as BildEditorOriginal } from './bild/BildEditor.js';
import type { StickerStudio as StickerStudioOriginal } from './stickers/StickerStudio.js';
import type { VideoEditorSheet as VideoEditorOriginal } from './video/VideoEditorSheet.js';
import type { VideoGifSheet as VideoGifOriginal } from './video/VideoGifSheet.js';
import type { SavePackSheet as SavePackOriginal } from './stickers/SavePackSheet.js';

/**
 * Die grossen Werkstätten – erst geholt, wenn jemand sie öffnet.
 *
 * WARUM an einer Stelle: Dieselbe Werkstatt wird von mehreren Orten geöffnet
 * (Chat, Sammlungen, Profil, Kamera). Stünde der `import()` an jeder
 * Aufrufstelle, wäre der Weg dorthin leicht einmal doch wieder statisch – und
 * das Start-Stück wüchse still um 150 kB. Hier steht jeder Weg genau einmal.
 *
 * Was die Teile tun, steht in ihren eigenen Dateien.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any -- dieselbe Schranke wie `ComponentProps` selbst
type Wie<T extends JSXElementConstructor<any>> = ComponentType<ComponentProps<T>>;

export const BildEditor: Wie<typeof BildEditorOriginal> = nachladbar(() =>
  import('./bild/BildEditor.js').then((m) => m.BildEditor),
);
export const StickerStudio: Wie<typeof StickerStudioOriginal> = nachladbar(() =>
  import('./stickers/StickerStudio.js').then((m) => m.StickerStudio),
);
export const VideoEditorSheet: Wie<typeof VideoEditorOriginal> = nachladbar(() =>
  import('./video/VideoEditorSheet.js').then((m) => m.VideoEditorSheet),
);
export const VideoGifSheet: Wie<typeof VideoGifOriginal> = nachladbar(() =>
  import('./video/VideoGifSheet.js').then((m) => m.VideoGifSheet),
);
export const SavePackSheet: Wie<typeof SavePackOriginal> = nachladbar(
  () => import('./stickers/SavePackSheet.js').then((m) => m.SavePackSheet),
  'blatt',
);
