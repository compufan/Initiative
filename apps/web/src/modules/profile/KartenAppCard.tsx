import { useRef, type KeyboardEvent } from 'react';
import { API_BASE } from '../../lib/api.js';
import { appsFuer, type KartenAppKey, type Ziel } from '../../lib/karten.js';
import {
  gemerkteApp,
  schreibeKartenApp,
  useKartenApp,
  usePlattform,
} from '../../lib/kartenWahl.js';

/**
 * Nur für die Auswahl der Liste: Welche Apps es auf diesem Gerät gibt, hängt
 * vom Gerät ab und nicht vom Ziel. Ein Beispieltext genügt dafür.
 */
const BEISPIEL: Ziel = { art: 'text', text: 'Beispielstraße 1, 12345 Beispielstadt' };

/**
 * Welche Karten-App sich beim Tippen auf eine Adresse im Termin öffnet.
 *
 * Gilt bewusst nur für dieses Gerät: Die Karten-App hängt am Gerät (iPhone:
 * Apple Karten, Android-Tablet: Google Maps). Eine Wahl am Konto wäre auf
 * dem anderen Gerät falsch. Gespeichert wird in `localStorage`, der Server
 * erfährt nichts davon.
 */
export function KartenAppCard() {
  const plattform = usePlattform();
  const gemerkt = useKartenApp();
  // Ein Eintrag, den es auf diesem Gerät nicht gibt (anderes Gerät, anderer
  // Browser), gilt als „jedes Mal fragen“ – so verhält sich auch das Blatt.
  const aktiv = gemerkteApp(plattform, gemerkt)?.key ?? null;
  const apps = appsFuer(plattform, 'karte', BEISPIEL);
  const gruppe = useRef<HTMLDivElement | null>(null);

  const optionen: { key: KartenAppKey | null; name: string; hinweis: string | null }[] = [
    { key: null, name: 'Jedes Mal fragen', hinweis: null },
    ...apps.map((app) => ({ key: app.key, name: app.name, hinweis: app.hinweis })),
  ];

  /** Pfeiltasten wählen wie in jeder Radiogruppe: der Fokus folgt der Wahl. */
  function taste(ereignis: KeyboardEvent<HTMLElement>, index: number) {
    const schritt =
      ereignis.key === 'ArrowDown' || ereignis.key === 'ArrowRight'
        ? 1
        : ereignis.key === 'ArrowUp' || ereignis.key === 'ArrowLeft'
          ? -1
          : 0;
    if (schritt === 0) return;
    ereignis.preventDefault();
    const naechster = (index + schritt + optionen.length) % optionen.length;
    schreibeKartenApp(optionen[naechster].key);
    gruppe.current?.querySelectorAll<HTMLElement>('[role="radio"]')[naechster]?.focus();
  }

  return (
    <section className="card stack" id="karten-app" aria-labelledby="prf-karten-title">
      <h2 className="prf-block-title" id="prf-karten-title">
        Karten-App
      </h2>
      <p className="prf-hint">
        Tippst du in einem Termin auf eine Adresse, öffnet sie sich in dieser App. Dein Handy
        bekommt die Adresse erst beim Tippen. Gilt nur für dieses Gerät.
      </p>

      <div className="prf-wahl" role="radiogroup" aria-label="Karten-App" ref={gruppe}>
        {optionen.map((option, index) => {
          const gewaehlt = option.key === aktiv;
          return (
            <button
              key={option.key ?? 'fragen'}
              type="button"
              role="radio"
              aria-checked={gewaehlt}
              // Roving tabindex: Die Gruppe ist EIN Tabstopp, auf der gewählten Option.
              tabIndex={gewaehlt ? 0 : -1}
              className={`prf-wahl-zeile${gewaehlt ? ' is-active' : ''}`}
              onClick={() => schreibeKartenApp(option.key)}
              onKeyDown={(ereignis) => taste(ereignis, index)}
            >
              <span className="prf-wahl-punkt" aria-hidden="true" />
              <span className="prf-wahl-text">
                <span className="prf-wahl-name">{option.name}</span>
                {option.hinweis && <span className="prf-wahl-hinweis">{option.hinweis}</span>}
              </span>
            </button>
          );
        })}
      </div>

      <p className="prf-hint">
        Beim Öffnen geht die Adresse an die gewählte Karten-App und deren Anbieter. Initiative
        selbst lädt keine Karte und schickt nichts, bevor du tippst.{' '}
        <a href={`${API_BASE}/datenschutz`} target="_blank" rel="noreferrer">
          Datenschutzerklärung
        </a>
      </p>
    </section>
  );
}
