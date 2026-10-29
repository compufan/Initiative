import { Fragment, useMemo, useRef, useState, type MouseEvent } from 'react';
import { ortAnalysieren, zielVonFund, type KartenFund } from '../lib/adresse.js';
import { karteUrl, type KartenApp, type Ziel } from '../lib/karten.js';
import { useGemerkteApp } from '../lib/kartenWahl.js';
import { KartenBlatt } from './KartenBlatt.js';

interface OrtZeileProps {
  ort: string;
  /**
   * `zeile`: die Ortszeile der Detailansicht. `inline`: die Zeile der
   * Chatkarte, auf zwei Zeilen begrenzt.
   */
  variante: 'zeile' | 'inline';
}

interface Blatt {
  ziel: Ziel;
  /** Der Ort war keine Adresse: Das Blatt warnt, dass die Suche ins Leere laufen kann. */
  offen: boolean;
}

/**
 * Der Ort eines Termins als Inhalt: Text, Links und – wo eine Adresse
 * erkannt wurde – der Weg in die Karten-App.
 *
 * # Was hier passiert, und was nicht
 *
 * Die Erkennung (`ortAnalysieren`) läuft bei jedem Anzeigen im Gerät aus dem
 * Text. Der Link entsteht also bei jedem Eingeladenen selbst, und jeder
 * öffnet ihn mit SEINER Karten-App. Es wird nichts geladen, bevor jemand
 * tippt: kein Kartenbild, keine Vorschau, kein `preconnect`.
 *
 * # Link oder Knopf
 *
 * - Ohne gemerkte Wahl ist die Adresse ein `button`, der das Blatt „Öffnen
 *   mit“ aufmacht.
 * - Mit gemerkter Wahl ist sie ein echter `<a href>`. Ein Link bleibt Link:
 *   Tastatur, Langdruck („Link kopieren“) und Vorlesehilfe kennen ihn, und
 *   kein Popup-Blocker kann ihn verwerfen, weil kein Skript beim Tippen
 *   läuft. Daneben steht „⋯“ für „anders öffnen“.
 * - Webadressen (Zoom, Teams) sind immer ein `<a>` in den Browser. Sie sind
 *   keine Karte, und das Blatt ginge an ihnen vorbei.
 *
 * `rel="noopener noreferrer"` an jedem fremden Link: Ohne `noreferrer`
 * ginge unsere Herkunft an die Karten-App.
 */
export function OrtZeile({ ort, variante }: OrtZeileProps) {
  const analyse = useMemo(() => ortAnalysieren(ort), [ort]);
  const gemerkt = useGemerkteApp();
  const [blatt, setBlatt] = useState<Blatt | null>(null);
  // Wohin der Fokus zurückkehrt, wenn das Blatt zugeht.
  const ausloeser = useRef<HTMLElement | null>(null);

  if (analyse.text === '') return null;

  function oeffnen(ziel: Ziel, offen: boolean, ereignis: MouseEvent<HTMLElement>) {
    ausloeser.current = ereignis.currentTarget;
    setBlatt({ ziel, offen });
  }

  /** Der Weg in die Karte: Knopf zum Blatt, oder – mit gemerkter Wahl – Link plus „⋯“. */
  function kartenZugang(ziel: Ziel, offen: boolean, beschriftung: string, klasse: string) {
    if (!gemerkt) {
      return (
        <button
          type="button"
          className={klasse}
          aria-haspopup="dialog"
          onClick={(ereignis) => oeffnen(ziel, offen, ereignis)}
        >
          {beschriftung}
        </button>
      );
    }
    return (
      <>
        <KartenLink app={gemerkt} ziel={ziel} className={klasse}>
          {beschriftung}
        </KartenLink>
        <button
          type="button"
          className="ort-mehr"
          aria-haspopup="dialog"
          aria-label="Mit anderer Karten-App oder als Route öffnen"
          data-tipp="Anders öffnen"
          onClick={(ereignis) => oeffnen(ziel, offen, ereignis)}
        >
          ⋯
        </button>
      </>
    );
  }

  const ersteAdresse = analyse.stuecke.findIndex(
    (stueck) => stueck.art === 'adresse' || stueck.art === 'koordinate',
  );

  const kartenFund = (fund: KartenFund) =>
    kartenZugang(zielVonFund(fund), false, fund.text, 'ort-link');

  return (
    <div className={`ort ort-${variante}`}>
      <span className="ort-symbol" aria-hidden="true">
        {analyse.nurWeb ? '🔗' : '📍'}
      </span>
      <span className="ort-text">
        {analyse.stuecke.map((stueck, index) => (
          <Fragment key={index}>
            {stueck.art === 'text' ? (
              // Was vor der ersten Adresse steht (der Name des Ortes), darf in
              // der Chatkarte einzeilig abgeschnitten werden – die Adresse
              // selbst soll nie aus den zwei Zeilen fallen.
              variante === 'inline' && index < ersteAdresse ? (
                <span className="ort-vorlauf">{stueck.text}</span>
              ) : (
                stueck.text
              )
            ) : stueck.art === 'web' ? (
              <a
                className="ort-link"
                href={stueck.url}
                target="_blank"
                rel="noopener noreferrer"
                title={stueck.url}
                aria-label={`${stueck.anzeige} (öffnet im Browser)`}
              >
                {stueck.anzeige}
              </a>
            ) : (
              kartenFund(stueck)
            )}
          </Fragment>
        ))}
        {analyse.sicherheit === 'offen' && analyse.ziel && (
          <> {kartenZugang(analyse.ziel, true, 'Auf Karte suchen', 'ort-suchen')}</>
        )}
      </span>
      {blatt && (
        <KartenBlatt
          open
          onClose={() => setBlatt(null)}
          ziel={blatt.ziel}
          offen={blatt.offen}
          ausloeser={ausloeser}
        />
      )}
    </div>
  );
}

/**
 * Ein echter Link in die gemerkte Karten-App.
 *
 * `geo:` bekommt kein `target`: Es ist ein Schema, das das Betriebssystem an
 * eine App übergibt; ein neues Fenster daneben bliebe leer stehen.
 */
function KartenLink({
  app,
  ziel,
  className,
  children,
}: {
  app: KartenApp;
  ziel: Ziel;
  className: string;
  children: string;
}) {
  return (
    <a
      className={className}
      href={karteUrl(app.key, ziel)}
      target={app.imBrowser ? '_blank' : undefined}
      rel="noopener noreferrer"
    >
      {children}
      <span className="visually-hidden"> – öffnet in {app.name}</span>
    </a>
  );
}
