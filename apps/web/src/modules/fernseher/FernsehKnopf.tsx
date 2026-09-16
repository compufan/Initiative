import { useEffect, useState } from 'react';
import { toast } from '../../state/ui.js';
import { geraeteBeobachten, streamFehler, streamen, wegFuer } from './streamen.js';

/**
 * Der Knopf, der ein Video auf den Fernseher schickt.
 *
 * # Warum er nicht immer da ist
 *
 * Er erscheint erst, wenn der Browser wirklich ein Gerät gefunden hat. Ein
 * Fernsehknopf an jedem Video, der am Schreibtisch ohne Chromecast immer
 * „kein Gerät gefunden“ sagt, ist ein Knopf, den man nach zweimal nicht mehr
 * drückt. Die Ausnahme steht in `geraeteBeobachten`: Wo der Browser die
 * Auskunft gar nicht gibt, wird der Knopf gezeigt – dort ist „vielleicht“
 * besser als „nein“.
 *
 * # Warum er das Zurückstellen selbst übernimmt
 *
 * Zum Streamen bekommt das Video eine andere Adresse (mit Eintrittskarte).
 * Bleibt die stehen, wenn die Verbindung endet, läuft im Telefon weiter eine
 * Adresse, deren Karte irgendwann abläuft – und dann ist das Video im Chat
 * plötzlich kaputt. Also: Verbindung zu Ende, alte Adresse zurück.
 */
export function FernsehKnopf({
  video,
  attachmentId,
  className,
}: {
  video: HTMLVideoElement | null;
  attachmentId: string;
  className?: string;
}) {
  const [da, setDa] = useState(false);
  const [laeuft, setLaeuft] = useState(false);
  const [verbunden, setVerbunden] = useState(false);
  const [zurueck, setZurueck] = useState<{ tun: () => void } | null>(null);

  useEffect(() => {
    if (!video) return undefined;
    return geraeteBeobachten(video, setDa);
  }, [video]);

  useEffect(() => {
    if (!video) return undefined;
    const weg = wegFuer(video);
    if (weg === 'airplay') {
      const beiWechsel = () => {
        const drahtlos = Boolean(
          (video as HTMLVideoElement & { webkitCurrentPlaybackTargetIsWireless?: boolean })
            .webkitCurrentPlaybackTargetIsWireless,
        );
        setVerbunden(drahtlos);
        if (!drahtlos) {
          zurueck?.tun();
          setZurueck(null);
        }
      };
      video.addEventListener('webkitcurrentplaybacktargetiswirelesschanged', beiWechsel);
      return () =>
        video.removeEventListener('webkitcurrentplaybacktargetiswirelesschanged', beiWechsel);
    }
    if (weg !== 'remote') return undefined;
    const beiVerbinden = () => setVerbunden(true);
    const beiTrennen = () => {
      setVerbunden(false);
      zurueck?.tun();
      setZurueck(null);
    };
    video.remote.addEventListener('connect', beiVerbinden);
    video.remote.addEventListener('disconnect', beiTrennen);
    return () => {
      video.remote.removeEventListener('connect', beiVerbinden);
      video.remote.removeEventListener('disconnect', beiTrennen);
    };
  }, [video, zurueck]);

  /*
   * Solange etwas LÄUFT, bleibt der Knopf – auch wenn der Browser gerade
   * meldet, es sei kein Gerät zu finden.
   *
   * Hier stand nur `!da`, und das hatte eine unangenehme Folge: Meldet der
   * Browser die Verfügbarkeit während einer laufenden Verbindung neu (ein
   * kurzer Aussetzer im WLAN genügt), verschwand der Knopf mitten im
   * Streamen. Damit war die einzige Stelle weg, über die man wieder trennen
   * kann – und das Video lief auf dem Fernseher weiter, mit einer Adresse,
   * deren Eintrittskarte irgendwann abläuft.
   *
   * Der Anfangsfall bleibt, wie er war: Wer noch nichts getan hat und kein
   * Gerät in Reichweite hat, sieht keinen Knopf. Ein Knopf, der zuverlässig
   * „nichts gefunden" sagt, wird nach zweimal nicht mehr gedrückt. Aber was
   * nach einer Handlung verschwindet, ist etwas anderes als was nie da war.
   */
  if (!video || (!da && !verbunden)) return null;

  return (
    <button
      type="button"
      className={className ?? 'media-tv-btn'}
      data-verbunden={verbunden ? 'ja' : 'nein'}
      disabled={laeuft}
      aria-label={verbunden ? 'Läuft auf dem Fernseher' : 'Auf den Fernseher'}
      title={verbunden ? 'Läuft auf dem Fernseher' : 'Auf den Fernseher'}
      onClick={async (ereignis) => {
        // Der Knopf liegt über dem Video; ohne das hier hielte der Klick
        // zugleich das Abspielen an.
        ereignis.stopPropagation();
        ereignis.preventDefault();
        setLaeuft(true);
        try {
          const tun = await streamen(video, attachmentId);
          setZurueck({ tun });
        } catch (fehler) {
          const text = streamFehler(fehler);
          // Leer heisst: Die Geräteliste wurde geschlossen. Das ist kein
          // Fehler und braucht keine Meldung.
          if (text) toast(text, 'error');
        } finally {
          setLaeuft(false);
        }
      }}
    >
      📺
    </button>
  );
}
