import { defineWebModule } from '../types.js';
import { AufDenFernseher } from './AufDenFernseher.js';
import './styles.css';

/**
 * Der Fernseher als zweiter Bildschirm.
 *
 * Zwei Wege nebeneinander, beide ohne fremden Code:
 *
 *   * `streamen.ts` – ein Video mit einem Fingertipp auf einen Chromecast oder
 *     per AirPlay. Der Knopf sitzt an der Videoblase und erscheint nur, wenn
 *     der Browser ein Gerät gefunden hat.
 *   * Das Blatt unter `/tv` – Fotos, Videos und Diashows auf jedem Fernseher
 *     mit Browser, also auf so gut wie jedem. Der Einstieg dorthin liegt an
 *     einer Sammlung (siehe `DateienScreen`) und hier, an der Nachricht.
 *
 * Das Modul hat keinen eigenen Eintrag in der Leiste unten: „Fernseher“ ist
 * kein Ort, an den man geht, sondern etwas, das man mit einem Foto tut.
 */
export default defineWebModule({
  key: 'fernseher',
  title: 'Fernseher',
  description: 'Fotos, Videos und Diashows auf einen Fernseher – ohne Zusatzgerät und ohne SDK.',
  messageActions: [
    {
      key: 'auf-den-fernseher',
      label: 'Auf den Fernseher',
      icon: '📺',
      order: 35,
      applies: (message) =>
        !message.deletedAt &&
        message.attachments.some((anhang) => anhang.kind === 'image' || anhang.kind === 'video'),
      render: AufDenFernseher,
    },
  ],
});
