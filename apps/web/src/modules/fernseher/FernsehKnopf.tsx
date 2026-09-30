import { useCallback, useEffect, useRef, useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import { toast } from '../../state/ui.js';
import { FernsehWahl } from './FernsehWahl.js';
import {
  KARTE_GEWECHSELT,
  KARTE_IM_TELEFON_MS,
  geraeteBeobachten,
  geraeteWaehlen,
  istVorbereitet,
  karteEinsetzen,
  karteEntfernen,
  streamFehler,
  verbindungBeobachten,
  vorbereitetSeit,
  type Verfuegbarkeit,
} from './streamen.js';

/**
 * Der 📺 an einem Video – „Auf den Fernseher".
 *
 * # Warum er jetzt immer da ist
 *
 * Er erschien früher nur, wenn der Browser ein Gerät gefunden hatte – mit der
 * Begründung, ein Knopf, der am Schreibtisch ohne Chromecast immer „kein
 * Gerät gefunden" sagt, werde nach zweimal nicht mehr gedrückt. Die Folge war
 * schlimmer: Wer einen Fernseher ohne Google Cast hat, und Chrome bei jedem
 * Video bis 15 Sekunden, sah an seinen Videos NICHTS – keinen Knopf und keinen
 * Hinweis, dass es zwei andere Wege gibt.
 *
 * Jetzt gilt:
 *
 *   * **Ist ein Fernseher in Reichweite** und die Karte schon im Element,
 *     öffnet ein Tipp sofort die Geräteliste. Das ist der Weg mit EINEM Tipp.
 *   * **Sonst** öffnet er „Auf den Fernseher" (`FernsehWahl`) mit allen Wegen –
 *     und der Erklärung, warum keiner gefunden wurde.
 *
 * # Warum er die Karte vorher einsetzt
 *
 * Siehe `streamen.ts`: Die Liste muss synchron im Klick aufgehen, und die
 * eingebauten Knöpfe der Videosteuerung (Chromes Cast-Symbol, Safaris
 * AirPlay) schicken die Adresse, die gerade im Element steht. Sobald der
 * Browser einen Fernseher meldet, kommt deshalb die Karte hinein.
 *
 * # Warum er sie nach fünf Stunden wieder herausnimmt
 *
 * Die Karte gilt sechs Stunden. Bliebe sie stehen, liefe im Chat irgendwann
 * eine Adresse, deren Karte abgelaufen ist, und das Video wäre beim nächsten
 * Abspielen kaputt. Also: nach fünf Stunden die alte Adresse zurück (und,
 * wenn noch ein Fernseher da ist, gleich eine frische Karte). Läuft gerade
 * etwas auf dem Fernseher, wird nicht getauscht – das würde es abreissen.
 *
 * # Warum er je Datei neu entsteht
 *
 * Im Dateibetrachter kann dasselbe `<video>` beim Blättern bleiben und nur
 * seine Adresse wechseln. Der Zustand dieses Knopfs – „Karte eingesetzt um",
 * „war im Bild", „ist gescheitert" – gehörte dann noch zur vorigen Datei: Die
 * neue bekam keine Karte, obwohl ein Fernseher gemeldet war, und Chromes bzw.
 * Safaris eigener Knopf schickte wieder eine Adresse ohne Karte (401). Der
 * Schlüssel `anhang.id` legt den Zustand je Datei frisch an.
 */
export function FernsehKnopf(eigenschaften: {
  video: HTMLVideoElement | null;
  anhang: AttachmentDto;
  className?: string;
}) {
  return <FernsehKnopfFuerDatei key={eigenschaften.anhang.id} {...eigenschaften} />;
}

function FernsehKnopfFuerDatei({
  video,
  anhang,
  className,
}: {
  video: HTMLVideoElement | null;
  anhang: AttachmentDto;
  className?: string;
}) {
  const [geraet, setGeraet] = useState<Verfuegbarkeit>('nein');
  const [verbunden, setVerbunden] = useState(false);
  const verbundenJetzt = useRef(false);
  verbundenJetzt.current = verbunden;
  /**
   * Wann die Karte eingesetzt wurde – `null`: keine im Element.
   *
   * Gelesen aus `streamen.ts`, nicht selbst gesetzt: Die Karte kann auch das
   * Blatt „Auf den Fernseher" einsetzen, und zwar noch, nachdem es schon zu
   * ist. Dann lief hier nie eine Uhr, und die Karte blieb über ihre sechs
   * Stunden hinaus in der Seite. Massgeblich ist der Zeitpunkt, zu dem sie
   * WIRKLICH ins Element kam – nicht der, zu dem jemand hier davon erfuhr.
   */
  const [vorbereitetUm, setVorbereitetUm] = useState<number | null>(() => vorbereitetSeit(video));
  /** Nach einem Ladefehler mit Karte nicht von selbst wieder einsetzen. */
  const gescheitert = useRef(false);
  const [nochmal, setNochmal] = useState(0);
  const [wahl, setWahl] = useState(false);
  const [meldung, setMeldung] = useState('');
  /*
   * War das Video schon einmal im Bild?
   *
   * Erst dann lohnt die Karte. Ein Chat mit fünfzig Videos und einem
   * Chromecast im WLAN holte sonst beim Öffnen fünfzig Karten und lüde die
   * Kopfdaten von fünfzig Videos neu – für Knöpfe, die man nur an dem Video
   * drückt, das man gerade sieht. Einmal im Bild, bleibt es dabei; ein Hin
   * und Her beim Rollen wäre nur neuer Aufwand.
   */
  const [imBild, setImBild] = useState(false);

  useEffect(() => {
    if (!video || imBild) return undefined;
    if (typeof IntersectionObserver === 'undefined') {
      setImBild(true);
      return undefined;
    }
    const beobachter = new IntersectionObserver((eintraege) => {
      if (!eintraege.some((eintrag) => eintrag.isIntersecting)) return;
      setImBild(true);
      beobachter.disconnect();
    });
    beobachter.observe(video);
    return () => beobachter.disconnect();
  }, [video, imBild]);

  useEffect(() => {
    if (!video) return undefined;
    return geraeteBeobachten(video, setGeraet);
  }, [video]);

  useEffect(() => {
    if (!video) return undefined;
    return verbindungBeobachten(video, setVerbunden);
  }, [video]);

  useEffect(() => {
    if (!video) return undefined;
    const abgleichen = () => {
      const seit = vorbereitetSeit(video);
      // Eine frisch eingesetzte Karte ist ein neuer Versuch – das Scheitern davor zählt nicht mehr.
      if (seit !== null) gescheitert.current = false;
      setVorbereitetUm(seit);
    };
    abgleichen();
    video.addEventListener(KARTE_GEWECHSELT, abgleichen);
    return () => video.removeEventListener(KARTE_GEWECHSELT, abgleichen);
  }, [video]);

  const vorbereiten = useCallback(() => {
    if (!video) return;
    karteEinsetzen(video, anhang.id).catch(() => undefined);
  }, [video, anhang.id]);

  /*
   * Die Karte einsetzen, sobald ein Fernseher gemeldet ist – nur bei `ja`.
   *
   * Nicht bei `unbekannt`: Dort weiss der Browser es nicht, und eine Karte in
   * jeder Videoblase auf jedem solchen Gerät wäre der Preis ohne den Nutzen.
   * Und nie ZURÜCK bei `nein`: Chrome meldet nach dem Tausch der Adresse
   * kurz „kein Gerät", weil die Dauer neu gelesen wird. Wer darauf
   * zurücktauschte, tauschte im Kreis.
   */
  useEffect(() => {
    if (geraet !== 'ja' || !imBild || vorbereitetUm !== null || gescheitert.current) return;
    vorbereiten();
  }, [geraet, imBild, vorbereitetUm, vorbereiten]);

  // Nach fünf Stunden zurück – ausser es läuft gerade etwas (dann später noch einmal).
  useEffect(() => {
    if (vorbereitetUm === null || !video) return undefined;
    const bis = vorbereitetUm + KARTE_IM_TELEFON_MS - Date.now();
    const uhr = window.setTimeout(
      () => {
        if (verbundenJetzt.current) {
          setNochmal((zahl) => zahl + 1);
          return;
        }
        karteEntfernen(video);
      },
      Math.max(bis, nochmal > 0 ? 10 * 60_000 : 0),
    );
    return () => window.clearTimeout(uhr);
  }, [vorbereitetUm, video, nochmal]);

  /*
   * Lädt das Video mit Karte nicht – abgelaufen, weil das Telefon Stunden
   * geschlafen hat und keine Uhr lief, oder der Zugang ist weg –, kommt die
   * alte Adresse zurück. In der App läuft es dann wie immer.
   */
  useEffect(() => {
    if (!video) return undefined;
    const beiFehler = () => {
      if (!istVorbereitet(video) || verbundenJetzt.current) return;
      gescheitert.current = true;
      karteEntfernen(video);
    };
    video.addEventListener('error', beiFehler);
    return () => video.removeEventListener('error', beiFehler);
  }, [video]);

  if (!video) return null;

  return (
    <>
      <button
        type="button"
        className={className ?? 'media-tv-btn'}
        data-verbunden={verbunden ? 'ja' : 'nein'}
        data-geraet={geraet}
        aria-label={verbunden ? 'Läuft auf dem Fernseher' : 'Auf den Fernseher'}
        title={verbunden ? 'Läuft auf dem Fernseher' : 'Auf den Fernseher'}
        onClick={(ereignis) => {
          // Der Knopf liegt über dem Video; ohne das hier hielte der Klick
          // zugleich das Abspielen an.
          ereignis.stopPropagation();
          ereignis.preventDefault();
          /*
           * Sofort die Liste – oder das Blatt mit allen Wegen.
           *
           * Sofort nur, wenn es klappen KANN: Fernseher gemeldet, Karte im
           * Element, Kopfdaten da. Sonst öffnete sich eine leere Liste oder
           * gar keine, und das ist genau die Stille, die hier fort soll.
           * (Läuft schon etwas, öffnet dieselbe Liste das Trennen.)
           */
          const sofort =
            verbunden || (geraet === 'ja' && istVorbereitet(video) && video.readyState >= 1);
          if (!sofort) {
            setMeldung('');
            setWahl(true);
            return;
          }
          const beginn = performance.now();
          geraeteWaehlen(video).catch((fehler: unknown) => {
            const auskunft = streamFehler(fehler, performance.now() - beginn);
            if (auskunft.andereWege) {
              setMeldung(auskunft.text);
              setWahl(true);
            } else if (auskunft.text) {
              toast(auskunft.text, 'error');
            }
          });
        }}
      >
        📺
      </button>
      {wahl && (
        <FernsehWahl
          open
          onClose={() => setWahl(false)}
          video={video}
          anhang={anhang}
          geraet={geraet}
          meldungVorher={meldung}
        />
      )}
    </>
  );
}
