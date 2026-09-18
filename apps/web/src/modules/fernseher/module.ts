import { defineWebModule } from '../types.js';
import { AufDenFernseher } from './AufDenFernseher.js';
import { FernsehBalken } from './FernsehBalken.js';
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
  /*
   * Der Balken, der die Fernbedienung zurückholt.
   *
   * Als Overlay des Moduls und nicht als Teil eines Bildschirms: Wer eine
   * Diashow laufen lässt, sitzt danach im Chat, nicht in der Sammlung. Ein
   * Weg zurück, den man erst suchen muss, ist für diesen Moment keiner.
   */
  overlay: FernsehBalken,
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
