import { defineWebModule } from '../types.js';
import { AudioBubble } from './AudioBubble.js';
import { CameraSheet } from './CameraSheet.js';
import { FileBubble } from './FileBubble.js';
import { FileSheet } from './FileSheet.js';
import { GallerySheet } from './GallerySheet.js';
import { ImageBubble } from './ImageBubble.js';
import { VideoBubble } from './VideoBubble.js';
import { VoiceSheet } from './VoiceSheet.js';
import './styles.css';

/**
 * Media module – camera, gallery, voice messages and files.
 *
 * It owns no screen of its own: it only contributes the composer actions that
 * capture media and the chat bubbles that render them.
 */
export default defineWebModule({
  key: 'media',
  title: 'Medien',
  description: 'Kamera, Fotos, Videos, Sprachnachrichten und Dateien im Chat.',
  messageRenderers: {
    image: ImageBubble,
    video: VideoBubble,
    audio: AudioBubble,
    file: FileBubble,
  },
  composerActions: [
    { key: 'camera', label: 'Kamera', icon: '📷', order: 10, render: CameraSheet },
    { key: 'gallery', label: 'Foto/Video', icon: '🖼️', order: 20, render: GallerySheet },
    { key: 'voice', label: 'Sprachnachricht', icon: '🎤', order: 30, render: VoiceSheet },
    { key: 'file', label: 'Datei', icon: '📎', order: 40, render: FileSheet },
  ],
});
