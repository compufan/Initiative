import { useEffect, useMemo, useRef, useState, type RefObject } from 'react';
import { Link } from 'react-router-dom';
import { appsFuer, urlFuer, zielText, type Modus, type Ziel } from '../lib/karten.js';
import { gemerkteApp, schreibeKartenApp, useKartenApp, usePlattform } from '../lib/kartenWahl.js';
import { copyText } from '../modules/calendar/helpers.js';
import { toast } from '../state/ui.js';
import { Sheet } from './Sheet.js';

interface KartenBlattProps {
  open: boolean;
  onClose: () => void;
  ziel: Ziel;
  /** Der Ort war keine Adresse: Die Suche kann ins Leere laufen. */
  offen: boolean;
  /** Der Knopf, der das Blatt geöffnet hat – dorthin kehrt der Fokus zurück. */
  ausloeser: RefObject<HTMLElement | null>;
}

/**
 * „Öffnen mit“: die Karten-Apps, die auf diesem Gerät in Frage kommen.
 *
 * Jede Zeile ist ein echter `<a href>` und keine Funktion, die beim Tippen
 * `window.open` ruft: Ein Popup-Blocker verwirft das eine, nie das andere,
 * und der Link lässt sich lang drücken und kopieren.
 *
 * Das Blatt lädt nichts nach, zeigt keine Bilder von Dritten und keine
 * Vorschau. Erst der Tipp auf eine App schickt die Adresse an sie.
 *
 * # Fokus
 *
 * `Sheet` setzt keinen Fokus (weder hinein noch zurück). Hier wird er
 * nachgerüstet, und zwar NUR für dieses Blatt: Eine Vereinheitlichung im
 * `Sheet` änderte alle anderen Blätter der App mit und wäre ein eigener
 * Auftrag. Beim Öffnen landet der Fokus auf der ersten App (bei gemerkter
 * Wahl auf dieser), beim Schliessen kehrt er zum Auslöser zurück.
 */
export function KartenBlatt({ open, onClose, ziel, offen, ausloeser }: KartenBlattProps) {
  const plattform = usePlattform();
  const gemerkt = useKartenApp();
  const standard = gemerkteApp(plattform, gemerkt);
  const [modus, setModus] = useState<Modus>('karte');
  // Vorgabe an: So wünscht es der Auftrag. Wer es nicht will, nimmt den Haken heraus.
  const [merken, setMerken] = useState(true);
  const liste = useRef<HTMLUListElement | null>(null);

  const apps = useMemo(() => appsFuer(plattform, modus, ziel), [plattform, modus, ziel]);

  // Jedes Öffnen beginnt von vorn: Karte, Wahl merken.
  useEffect(() => {
    if (!open) return undefined;
    setModus('karte');
    setMerken(true);
    return undefined;
  }, [open]);

  // Fokus hinein – und beim Schliessen zurück zum Auslöser.
  useEffect(() => {
    if (!open) return undefined;
    const erste =
      liste.current?.querySelector<HTMLElement>('a[aria-current="true"]') ??
      liste.current?.querySelector<HTMLElement>('a');
    erste?.focus();
    return () => {
      const zurueck = ausloeser.current;
      if (zurueck && zurueck.isConnected) zurueck.focus();
    };
  }, [open, ausloeser]);

  async function kopieren() {
    if (await copyText(zielText(ziel))) toast('Adresse kopiert', 'success');
    else toast('Kopieren hat nicht geklappt', 'error');
  }

  return (
    <Sheet open={open} onClose={onClose} title={offen ? 'Auf Karte suchen' : 'Öffnen mit'}>
      <div className="stack karten-blatt">
        <p className="karten-ziel">{zielText(ziel)}</p>
        {offen && (
          <p className="fil-hint">
            Das sieht nicht nach einer Adresse aus. Die Suche kann ins Leere laufen.
          </p>
        )}

        <div
          className="prf-segment karten-modus"
          role="group"
          aria-label="Was soll geöffnet werden?"
        >
          {(
            [
              ['karte', 'Karte zeigen'],
              ['route', 'Route hierher'],
            ] as const
          ).map(([wert, beschriftung]) => (
            <button
              key={wert}
              type="button"
              className={`prf-segment-btn${modus === wert ? ' is-active' : ''}`}
              aria-pressed={modus === wert}
              onClick={() => setModus(wert)}
            >
              {beschriftung}
            </button>
          ))}
        </div>
        {modus === 'route' && (
          <p className="fil-hint">
            Nicht jede App lässt sich per Link zu einer Route auffordern: Es stehen nur die hier
            gelisteten zur Wahl.
          </p>
        )}

        <ul className="list karten-liste" ref={liste}>
          {apps.map((app) => {
            const url = urlFuer(app.key, modus, ziel);
            if (url === null) return null;
            const istStandard = standard?.key === app.key;
            return (
              <li key={app.key}>
                <a
                  className="list-row karten-app"
                  href={url}
                  target={app.imBrowser ? '_blank' : undefined}
                  rel="noopener noreferrer"
                  aria-current={istStandard ? 'true' : undefined}
                  onClick={() => {
                    if (merken) schreibeKartenApp(app.key);
                    // Nicht sofort schliessen: Das Aushängen des angeklickten
                    // Links vor der Weiterleitung kann diese in React
                    // verschlucken, weil Aktualisierungen aus Klicks noch vor
                    // der Standardaktion des Browsers durchgeschrieben werden.
                    window.setTimeout(onClose, 0);
                  }}
                >
                  <span className="karten-app-text">
                    <span className="karten-app-name">
                      {app.name}
                      {istStandard && <span className="karten-app-standard"> · Standard</span>}
                    </span>
                    <span className="karten-app-hinweis">{app.hinweis}</span>
                  </span>
                </a>
              </li>
            );
          })}
        </ul>

        <button type="button" className="btn btn-block" onClick={() => void kopieren()}>
          Adresse kopieren
        </button>

        <div className="karten-merken-zeile">
          <label className="karten-merken">
            <input
              type="checkbox"
              checked={merken}
              onChange={(aenderung) => setMerken(aenderung.target.checked)}
            />
            <span>Diese Wahl merken</span>
          </label>
          {standard && (
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              onClick={() => schreibeKartenApp(null)}
            >
              Jedes Mal fragen
            </button>
          )}
        </div>

        <p className="fil-hint">
          Beim Öffnen geht die Adresse an die gewählte Karten-App und deren Anbieter. Initiative
          selbst lädt keine Karte und schickt nichts, bevor du tippst.
        </p>
        <Link
          className="karten-aendern"
          to="/profil/einstellungen#karten-app"
          onClick={() => window.setTimeout(onClose, 0)}
        >
          Karten-App ändern: Profil → Einstellungen
        </Link>
      </div>
    </Sheet>
  );
}
