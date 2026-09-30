import { useEffect, useState } from 'react';
import type { AttachmentDto } from '@initiative/shared';
import { Sheet } from '../../components/Sheet.js';
import { errorMessage } from '../media/helpers.js';
import { castGrund } from './cast.js';
import { CastKnopf } from './CastKnopf.js';
import { FernsehSheet } from './FernsehSheet.js';
import { SpiegelSheet } from './SpiegelSheet.js';
import {
  geraeteWaehlen,
  istVorbereitet,
  karteEinsetzen,
  kurzesVideoInChrome,
  streamFehler,
  wegFuer,
  type Verfuegbarkeit,
} from './streamen.js';

/**
 * „Auf den Fernseher" an einem Video – alle Wege auf einem Blatt.
 *
 * # Warum es dieses Blatt gibt
 *
 * Der 📺 an der Videoblase erschien nur, wenn der Browser einen Fernseher
 * gefunden hatte. Wer ein Android-Telefon und einen Fernseher ohne Google Cast
 * hat – das häufigste Wohnzimmer –, sah an seinen Videos nichts: keinen Knopf,
 * keinen Satz, keinen Hinweis auf den Code-Weg. Und Chrome sucht bei Videos
 * bis 15 Sekunden gar nicht erst, also fehlte der Knopf ausgerechnet an den
 * meisten Chat-Videos.
 *
 * Jetzt steht der 📺 immer da, und wo er nicht sofort streamen kann, öffnet er
 * dieses Blatt: der Weg mit einem Tipp (wenn es ihn gibt), der Code am
 * Fernseher, die Spiegelung des Telefons – und die Antwort auf „warum finde
 * ich meinen Fernseher nicht?".
 *
 * # Warum das Blatt beim Öffnen die Karte holt
 *
 * `prompt()` muss synchron im Klick laufen (siehe `streamen.ts`). Das Öffnen
 * dieses Blattes ist der Moment, in dem jemand „ich will auf den Fernseher"
 * sagt – also wird hier die Eintrittskarte geholt und eingesetzt, und der
 * Knopf „Fernseher wählen" darunter öffnet die Liste dann ohne Umweg.
 */
export function FernsehWahl({
  open,
  onClose,
  video,
  anhang,
  geraet,
  meldungVorher = '',
  onVorbereitet,
}: {
  open: boolean;
  onClose: () => void;
  video: HTMLVideoElement | null;
  anhang: AttachmentDto;
  geraet: Verfuegbarkeit;
  /** Was ein Tipp auf den 📺 eben ergeben hat – steht dann oben. */
  meldungVorher?: string;
  /** Wenn die Karte eingesetzt ist – der Knopf an der Blase führt Buch. */
  onVorbereitet?: () => void;
}) {
  const weg = wegFuer(video);
  const kurz = kurzesVideoInChrome(video, anhang.durationMs);
  const cast = castGrund() === 'geht';
  const [bereit, setBereit] = useState(() => istVorbereitet(video));
  const [meldung, setMeldung] = useState(meldungVorher);
  const [erklaerung, setErklaerung] = useState(Boolean(meldungVorher));
  const [codeWeg, setCodeWeg] = useState(false);
  const [spiegeln, setSpiegeln] = useState(false);

  useEffect(() => {
    if (!open || !video || weg === null || kurz) return undefined;
    if (istVorbereitet(video)) {
      setBereit(true);
      return undefined;
    }
    let gilt = true;
    karteEinsetzen(video, anhang.id).then(
      () => {
        if (!gilt) return;
        setBereit(true);
        onVorbereitet?.();
      },
      (fehler: unknown) => {
        if (gilt)
          setMeldung(errorMessage(fehler, 'Die Karte für den Fernseher liess sich nicht holen.'));
      },
    );
    return () => {
      gilt = false;
    };
    // `onVorbereitet` ist bei jedem Rendern eine neue Funktion – nicht warten.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, video, weg, kurz, anhang.id]);

  /** Die Geräteliste – synchron im Klick, die Karte steht schon im Element. */
  const waehlen = () => {
    if (!video) return;
    setMeldung('');
    const beginn = performance.now();
    geraeteWaehlen(video).then(
      () => onClose(),
      (fehler: unknown) => {
        const auskunft = streamFehler(fehler, performance.now() - beginn);
        setMeldung(auskunft.text);
        if (auskunft.andereWege) setErklaerung(true);
      },
    );
  };

  const titel = anhang.fileName ?? 'Dieses Video';

  return (
    <>
      <Sheet
        open={open && !codeWeg && !spiegeln}
        onClose={onClose}
        title="Auf den Fernseher"
        variant="modal"
      >
        <div className="stack fernseh-wahl">
          <section className="fw-weg">
            <h3 className="fw-titel">Mit einem Tipp</h3>
            {weg !== null && !kurz && (
              <>
                <button
                  type="button"
                  className="btn btn-primary btn-block"
                  disabled={!bereit}
                  onClick={waehlen}
                >
                  {bereit ? '📺 Fernseher wählen' : 'Wird vorbereitet …'}
                </button>
                <p className="tv-hinweis">
                  {geraet === 'ja'
                    ? 'Ein Fernseher mit Google Cast bzw. AirPlay ist in Reichweite.'
                    : 'Der Browser hat noch keinen Fernseher gemeldet – versuchen kannst du es trotzdem.'}
                </p>
              </>
            )}
            {kurz && (
              /*
               * Keine Schaltfläche, die still scheitert: Chrome bietet so kurze
               * Videos gar nicht erst an, und `prompt()` bräche wortlos ab.
               */
              <p className="tv-hinweis">
                Chrome bietet Videos bis 15 Sekunden nicht zum Streamen an – auch sein eigenes
                Cast-Symbol fehlt dann.
                {cast ? ' Mit Chromecast darunter geht es trotzdem.' : ''} Sonst: Code am Fernseher
                oder das Telefon spiegeln.
              </p>
            )}
            {cast && <CastKnopf stuecke={[anhang.id]} was={titel} stil="leiste" />}
            {weg === null && !cast && (
              <p className="tv-hinweis">
                Dieser Browser kann nicht direkt auf einen Fernseher streamen – die Wege darunter
                gehen trotzdem.
              </p>
            )}
            {meldung && (
              <p className="fw-meldung" role="status">
                {meldung}
              </p>
            )}
          </section>

          <section className="fw-weg">
            <h3 className="fw-titel">Code am Fernseher</h3>
            <p className="tv-hinweis">
              Für jeden Fernseher mit Browser – Samsung, LG, Fire TV … Die Diashow läuft dort
              weiter, auch wenn das Telefon in der Tasche steckt.
            </p>
            <button type="button" className="btn btn-block" onClick={() => setCodeWeg(true)}>
              Code am Fernseher
            </button>
          </section>

          <section className="fw-weg">
            <h3 className="fw-titel">Telefon spiegeln</h3>
            <p className="tv-hinweis">
              Für Fernseher ohne Browser – Apple TV, Chromecast, Roku – über Smart View,
              „Übertragen" oder AirPlay. Das Video läuft mit Ton, in jedem Format, das das Telefon
              abspielt.
            </p>
            <button type="button" className="btn btn-block" onClick={() => setSpiegeln(true)}>
              📱 Fernsehansicht zum Spiegeln
            </button>
          </section>

          <details
            className="fw-erklaerung"
            open={erklaerung}
            onToggle={(ereignis) => setErklaerung(ereignis.currentTarget.open)}
          >
            <summary>Kein Fernseher gefunden?</summary>
            <p>
              Mit einem Tipp findet das Telefon nur Fernseher, die <strong>Google Cast</strong>{' '}
              (Chromecast, Google TV, einzelne Samsung und LG ab 2023/24) oder – auf dem iPhone –{' '}
              <strong>AirPlay</strong> verstehen, und nur im selben WLAN. Dass auf einem Fernseher
              YouTube läuft, heisst nicht, dass er eins von beiden kann.
            </p>
            <p>
              Dann gehen die beiden anderen Wege: der <strong>Code am Fernseher</strong> auf jedem
              Gerät mit Browser, oder die <strong>Spiegelung des Telefons</strong> (Smart View,
              „Übertragen", AirPlay-Bildschirmsynchronisierung).
            </p>
            <p>
              Findet der Fernseher das Video, spielt es aber nicht ab („Format nicht unterstützt"),
              liegt es am Format: Videos vom iPhone (HEVC) und Aufnahmen als WebM kann nicht jedes
              Gerät. Code-Weg und Spiegelung zeigen sie trotzdem.
            </p>
          </details>
        </div>
      </Sheet>
      {codeWeg && (
        <FernsehSheet
          open
          onClose={() => setCodeWeg(false)}
          attachmentIds={[anhang.id]}
          ansicht={[anhang]}
          titel="Auf den Fernseher"
        />
      )}
      {spiegeln && <SpiegelSheet open onClose={() => setSpiegeln(false)} stuecke={[anhang]} />}
    </>
  );
}
