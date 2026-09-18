import { Sheet } from '../../components/Sheet.js';
import { castGrund, type CastZustand } from './cast.js';

/**
 * „Warum wird kein Chromecast gefunden?“
 *
 * # Warum es dieses Blatt gibt
 *
 * Ein Anwender hat berichtet: „Es werden konsequent keine Chromecasts
 * gefunden. Auch von Fernsehern, auf die man beispielsweise mit YouTube oder
 * Disney Plus zuverlässig streamen kann.“
 *
 * Das ist eine völlig vernünftige Schlussfolgerung – und sie ist trotzdem
 * falsch, weil dahinter zwei verschiedene Techniken stecken, die für den
 * Bedienenden gleich aussehen:
 *
 *   * **YouTube** startet seine eigene App auf dem Fernseher. Das geht über
 *     DIAL, ein älteres Verfahren, das fast jeder Smart-TV der letzten zehn
 *     Jahre beherrscht. Danach steuert das Telefon diese App.
 *   * **Google Cast** schickt dem Gerät eine Adresse, die es selbst abruft.
 *     Das geht über mDNS und setzt voraus, dass der Fernseher Google Cast
 *     EMPFANGEN kann – Samsung erst ab Modelljahr 2023, LG ab 2024, Fire TV
 *     und Roku gar nicht.
 *
 * Ein Fernseher, auf dem YouTube läuft, kann also sehr wohl „kein Chromecast“
 * sein. Ohne diesen Satz sieht es aus, als sei die App kaputt.
 *
 * # Warum die Zahlen dazugehören
 *
 * Weil der Satz allein eine Behauptung wäre. Was der Browser hier gerade
 * meldet – chromiumfähig, sichere Adresse, Skript geladen, welcher Empfänger,
 * welcher Zustand – entscheidet den Fall, und es steht ohnehin im Speicher.
 * Es wegzuwerfen und den Menschen raten zu lassen, ist eine Entscheidung; sie
 * war die falsche.
 */
export function CastDiagnose({
  offen,
  zu,
  zustand,
  empfaenger,
  zumCodeWeg,
}: {
  offen: boolean;
  zu: () => void;
  zustand: CastZustand;
  empfaenger: string;
  /** Der Weg, der ohne Chromecast funktioniert. */
  zumCodeWeg: () => void;
}) {
  const grund = castGrund();
  const ort = typeof window === 'undefined' ? '' : window.location.origin;
  const chromium =
    typeof navigator !== 'undefined' && /Chrome|Chromium|Edg|OPR/.test(navigator.userAgent);
  const apfel = typeof navigator !== 'undefined' && /iPhone|iPad|iPod/.test(navigator.userAgent);

  return (
    <Sheet open={offen} onClose={zu} title="Warum wird kein Fernseher gefunden?" variant="modal">
      <div className="stack cast-diagnose">
        <p>
          <strong>YouTube und Chromecast sind zwei verschiedene Sachen.</strong> Dass ein Fernseher
          YouTube oder Disney+ abspielen kann, heisst nicht, dass er Chromecast versteht.
        </p>
        <p className="cast-frage-klein">
          YouTube startet seine eigene App auf dem Fernseher (über ein älteres Verfahren namens
          DIAL, das fast jeder Smart-TV kann). Chromecast schickt dem Gerät dagegen eine Adresse,
          die es selbst abruft – und das können nur Fernseher, die Google Cast eingebaut haben:
          Google TV und Android TV immer, <strong>Samsung erst ab Modelljahr 2023</strong>,{' '}
          <strong>LG ab 2024</strong>, Fire TV und Roku gar nicht.
        </p>

        <h3 className="cast-diagnose-titel">Was hier gerade gilt</h3>
        <dl className="cast-diagnose-liste">
          <Zeile
            name="Dieser Browser"
            wert={
              apfel
                ? 'iPhone oder iPad – kann kein Chromecast'
                : chromium
                  ? 'Chrome, Edge oder verwandt – kann Chromecast'
                  : 'Safari oder Firefox – kann kein Chromecast'
            }
            gut={chromium && !apfel}
          />
          <Zeile
            name="Adresse"
            wert={
              grund === 'kein-sicherer-kontext'
                ? `${ort} – ohne https geht Chromecast nicht`
                : `${ort} – in Ordnung`
            }
            gut={grund !== 'kein-sicherer-kontext'}
          />
          <Zeile
            name="Skript von Google"
            wert={
              zustand === 'aus'
                ? 'wird gerade geladen'
                : zustand === 'fehlgeschlagen'
                  ? 'nicht geladen – ein Inhaltsblocker?'
                  : 'geladen'
            }
            gut={zustand !== 'fehlgeschlagen'}
          />
          <Zeile
            name="Gerätesuche"
            wert={
              zustand === 'keine-geraete'
                ? 'läuft – bisher nichts gefunden'
                : zustand === 'bereit'
                  ? 'mindestens ein Gerät gefunden'
                  : zustand === 'verbunden'
                    ? 'verbunden'
                    : '–'
            }
            gut={zustand === 'bereit' || zustand === 'verbunden'}
          />
          <Zeile name="Empfänger" wert={empfaenger} gut />
        </dl>

        <h3 className="cast-diagnose-titel">Was noch helfen kann</h3>
        <ul className="cast-diagnose-tipps">
          <li>
            Telefon und Fernseher müssen im <strong>selben WLAN</strong> sein – nicht das eine im
            Gäste-Netz und das andere im normalen.
          </li>
          <li>
            Manche Router trennen die Geräte voneinander („AP-Isolation“, „Client-Isolation“). Dann
            findet kein Gerät ein anderes.
          </li>
          <li>Der Fernseher muss wirklich an sein – Standby genügt nicht immer.</li>
          <li>
            Tippe auf das Cast-Symbol. Erst das löst eine gründliche Suche aus; im Hintergrund sucht
            der Browser sparsam.
          </li>
        </ul>

        <button
          type="button"
          className="btn btn-primary btn-block"
          onClick={() => {
            zu();
            zumCodeWeg();
          }}
        >
          Ohne Chromecast: Code am Fernseher
        </button>
        <p className="cast-frage-klein">
          Der Weg funktioniert auf jedem Fernseher mit Browser – und zeigt Fotos sogar in voller
          Grösse statt in 1280 × 720.
        </p>
      </div>
    </Sheet>
  );
}

function Zeile({ name, wert, gut }: { name: string; wert: string; gut: boolean }) {
  return (
    <>
      <dt>{name}</dt>
      <dd className={gut ? 'ist-gut' : 'ist-schlecht'}>
        <span aria-hidden="true">{gut ? '✓' : '✗'}</span> {wert}
      </dd>
    </>
  );
}
