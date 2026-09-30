import { defineWebModule } from '../types.js';
import { AufDenFernseher } from './AufDenFernseher.js';
import { FernsehBalken } from './FernsehBalken.js';
import './styles.css';

/**
 * Der Fernseher als zweiter Bildschirm.
 *
 * Drei Wege nebeneinander, weil keiner überall geht:
 *
 *   * **Mit einem Tipp** – `streamen.ts` (Remote Playback in Chrome und
 *     Safari, AirPlay) ohne fremden Code, und `cast.ts` (Google Cast) erst
 *     nach ausdrücklicher Zustimmung, weil das Skript von Google kommt. Der 📺
 *     sitzt an jedem Video und ist immer da; findet der Browser keinen
 *     Fernseher, öffnet er „Auf den Fernseher" mit den anderen beiden Wegen
 *     (`FernsehWahl`).
 *   * **Code am Fernseher** – das Blatt unter `/tv`: Fotos, Videos und
 *     Diashows auf jedem Fernseher mit Browser. Der Einstieg liegt an einer
 *     Sammlung (siehe `DateienScreen`), an jedem Video und hier, an der
 *     Nachricht.
 *   * **Telefon spiegeln** – die Bildschirmspiegelung des Betriebssystems
 *     (Smart View, „Übertragen", AirPlay) mit einer eigenen Fernsehansicht in
 *     der App (`Fernsehansicht`, Anleitung in `SpiegelSheet`). Für Fernseher
 *     ohne Browser, die trotzdem gespiegelt werden können: Apple TV,
 *     Chromecast, Roku.
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
