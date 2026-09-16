/**
 * Ein Video vom Telefon auf den Fernseher schicken – ohne Lizenz, ohne SDK.
 *
 * # Was hier benutzt wird, und warum gerade das
 *
 * Zwei eingebaute Wege, die jeder Browser mitbringt:
 *
 *   * **Remote Playback API** (`video.remote.prompt()`). Chrome und Edge,
 *     auf Android wie auf dem Rechner. Der Browser zeigt SEINE Geräteliste –
 *     Chromecast, Android TV, Google TV, alles, was er kennt – und schickt
 *     die Adresse dorthin.
 *   * **AirPlay** (`webkitShowPlaybackTargetPicker`). Safari, auf dem iPhone
 *     wie auf dem Mac. Dieselbe Sache, anderer Name; die Remote Playback API
 *     gibt es dort nicht.
 *
 * Zusammen ist das so gut wie jeder Fernseher der letzten zehn Jahre, ohne
 * dass ein Zeichen fremden Codes in die App kommt.
 *
 * # Warum NICHT das Google-Cast-SDK
 *
 * Es könnte mehr – Fotos, Warteschlangen – und es kostet auch nichts. Es
 * kostet etwas anderes: `cast_sender.js` liegt auf gstatic.com und müsste
 * dauerhaft in `script-src`. In `CSP.md` steht über genau diese Zeile „Die
 * wichtigste Zeile. Kein fremdes Skript“, und das ist keine Floskel, sondern
 * die zweite Verteidigungslinie dieser App. Ausserdem ginge bei jedem
 * Streamen die IP-Adresse an Google – in einer selbstgehosteten App.
 *
 * Fotos und Diashows gehen deshalb einen anderen Weg (siehe das TV-Blatt);
 * hier geht es um das, was mit einem einzigen Fingertipp funktioniert.
 *
 * # Warum die Adresse getauscht wird
 *
 * Der Fernseher holt die Datei SELBST. Er schickt dabei weder den
 * `Authorization`-Kopf noch den Medien-Keks – beide gehören zum Browser, und
 * der Fernseher ist ein anderes Gerät. Die gewöhnliche Adresse ergäbe dort
 * also eine 401 und ein schwarzes Bild. Deshalb wird vor dem Streamen eine
 * Eintrittskarte geholt (`api.media.fernsehticket`) und die Adresse
 * ausgetauscht; beim Trennen kommt die alte zurück.
 *
 * Getauscht wird erst auf Knopfdruck und nicht vorsorglich: Eine Adresse mit
 * Karte darin soll nicht in jeder Chatblase im Dokument stehen.
 */

import { api } from '../../lib/api.js';

/** Die WebKit-Zusätze, die in `lib.dom` fehlen. */
interface WebkitVideo extends HTMLVideoElement {
  webkitShowPlaybackTargetPicker?: () => void;
  webkitCurrentPlaybackTargetIsWireless?: boolean;
}

/** Welcher der beiden Wege an diesem Gerät zur Verfügung steht. */
export type Weg = 'remote' | 'airplay' | null;

/**
 * Der Weg, den dieses Element gehen kann.
 *
 * Reihenfolge mit Absicht: Wo es beide gibt, ist die Remote Playback API die
 * bessere Wahl, weil sie den Zustand meldet (verbunden, getrennt) und AirPlay
 * nur einen Wähler öffnet.
 */
export function wegFuer(video: HTMLVideoElement | null | undefined): Weg {
  if (!video) return null;
  if (typeof (video as WebkitVideo).remote?.prompt === 'function') return 'remote';
  if (typeof (video as WebkitVideo).webkitShowPlaybackTargetPicker === 'function') return 'airplay';
  return null;
}

/**
 * Ist überhaupt ein Gerät in Reichweite?
 *
 * Meldet `false`, bis der Browser etwas gefunden hat, und ruft danach erneut.
 * Der Rückgabewert hängt die Überwachung wieder ab.
 *
 * # Der Sonderfall, der hier wichtig ist
 *
 * `watchAvailability` ist an einigen Stellen nicht umgesetzt und wirft dann
 * `NotSupportedError` – obwohl `prompt()` daneben tadellos arbeitet. Wer das
 * als „kein Gerät“ liest, versteckt den Knopf auf genau den Geräten, auf
 * denen er gebraucht wird. Deshalb heisst ein Fehler hier: JA, anbieten. Ein
 * Knopf, der nachher „kein Gerät gefunden“ sagt, ist besser als gar keiner.
 */
export function geraeteBeobachten(
  video: HTMLVideoElement,
  melden: (da: boolean) => void,
): () => void {
  const weg = wegFuer(video);
  if (weg === null) {
    melden(false);
    return () => undefined;
  }

  if (weg === 'airplay') {
    const beiAenderung = (ereignis: Event) => {
      const wert = (ereignis as Event & { availability?: string }).availability;
      melden(wert !== 'not-available');
    };
    video.addEventListener('webkitplaybacktargetavailabilitychanged', beiAenderung);
    return () => video.removeEventListener('webkitplaybacktargetavailabilitychanged', beiAenderung);
  }

  let gilt = true;
  let nummer: number | null = null;
  video.remote
    .watchAvailability((da) => {
      if (gilt) melden(da);
    })
    .then((id) => {
      if (gilt) nummer = id;
      else void video.remote.cancelWatchAvailability(id).catch(() => undefined);
    })
    .catch(() => {
      // Siehe oben: nicht umgesetzt heisst nicht „kein Gerät“.
      if (gilt) melden(true);
    });

  return () => {
    gilt = false;
    if (nummer !== null) void video.remote.cancelWatchAvailability(nummer).catch(() => undefined);
  };
}

/** Was beim Streamen schiefgehen kann, in Worten statt in Fehlernamen. */
export function streamFehler(fehler: unknown): string {
  const name = fehler instanceof Error ? fehler.name : '';
  switch (name) {
    case 'NotFoundError':
      return 'Kein Fernseher gefunden. Er muss im selben WLAN sein und eingeschaltet.';
    case 'NotAllowedError':
      // Auch das Schliessen der Geräteliste landet hier – dann ist es kein
      // Fehler, sondern eine Entscheidung.
      return '';
    case 'InvalidStateError':
      return 'Die Verbindung wird gerade schon aufgebaut.';
    case 'NotSupportedError':
      return 'Dieser Browser kann nicht auf einen Fernseher streamen.';
    default:
      return fehler instanceof Error && fehler.message
        ? fehler.message
        : 'Das Streamen hat nicht geklappt.';
  }
}

/**
 * Die Adresse mit Eintrittskarte einsetzen und die Geräteliste öffnen.
 *
 * Gibt zurück, wie die alte Adresse wiederhergestellt wird – aufzurufen, wenn
 * die Verbindung endet oder gar nicht erst zustande kommt.
 *
 * Die Stelle im Video bleibt erhalten: Ein Tausch der Adresse setzt das
 * Element zurück, und wer bei Minute zwölf auf den Knopf drückt, will nicht
 * wieder am Anfang anfangen.
 */
export async function streamen(video: HTMLVideoElement, attachmentId: string): Promise<() => void> {
  const weg = wegFuer(video);
  if (weg === null) throw Object.assign(new Error(''), { name: 'NotSupportedError' });

  const alteQuelle = video.currentSrc || video.src;
  const stelle = video.currentTime;
  const karte = await api.media.fernsehticket(attachmentId);

  const zurueck = () => {
    if (!alteQuelle || video.src === alteQuelle) return;
    const wieder = video.currentTime;
    video.src = alteQuelle;
    video.addEventListener(
      'loadedmetadata',
      () => {
        try {
          video.currentTime = wieder;
        } catch {
          /* Dann eben von vorn. */
        }
      },
      { once: true },
    );
  };

  video.src = karte.url;
  await new Promise<void>((auf) => {
    video.addEventListener(
      'loadedmetadata',
      () => {
        try {
          video.currentTime = stelle;
        } catch {
          /* Dann eben von vorn. */
        }
        auf();
      },
      { once: true },
    );
    // Wer nicht lädt, soll den Knopf trotzdem nicht aufhalten: Die
    // Geräteliste darf auch aufgehen, bevor die Kopfdaten da sind.
    setTimeout(auf, 2500);
  });

  try {
    if (weg === 'airplay') (video as WebkitVideo).webkitShowPlaybackTargetPicker?.();
    else await video.remote.prompt();
  } catch (fehler) {
    zurueck();
    throw fehler;
  }
  return zurueck;
}
