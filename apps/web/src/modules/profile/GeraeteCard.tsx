import { useEffect, useState } from 'react';
import type { SitzungDto } from '@initiative/shared';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { toast } from '../../state/ui.js';
import { geraetName, geraetZeichen } from './geraet.js';
import { errorMessage } from './helpers.js';

function wann(stempel: string | null): string {
  if (!stempel) return 'unbekannt';
  const datum = new Date(stempel);
  if (Number.isNaN(datum.getTime())) return 'unbekannt';
  return datum.toLocaleString('de-DE', { dateStyle: 'medium', timeStyle: 'short' });
}

/**
 * Geräte: wo man angemeldet ist – und der Weg, ein verlorenes oder fremdes
 * Gerät abzumelden. Abgemeldet heisst sofort: Das Gerät kann nicht mehr
 * erneuern, seine Anfragen werden abgewiesen, und seine Echtzeit-Leitung
 * schliesst sich.
 */
export function GeraeteCard() {
  const [liste, setListe] = useState<SitzungDto[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [frage, setFrage] = useState<string | 'andere' | null>(null);

  async function laden() {
    try {
      const { items } = await verwaltung.sitzungen.liste();
      setListe(items);
    } catch (error) {
      setListe([]);
      toast(errorMessage(error, 'Geräte konnten nicht geladen werden'), 'error');
    }
  }

  useEffect(() => {
    void laden();
  }, []);

  async function beenden(id: string | 'andere') {
    setBusy(true);
    try {
      if (id === 'andere') {
        const { beendet } = await verwaltung.sitzungen.andereBeenden();
        toast(beendet === 1 ? 'Ein Gerät abgemeldet' : `${beendet} Geräte abgemeldet`, 'success');
      } else {
        await verwaltung.sitzungen.beenden(id);
        toast('Gerät abgemeldet', 'success');
      }
      setFrage(null);
      await laden();
    } catch (error) {
      toast(errorMessage(error, 'Abmelden fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  const andere = (liste ?? []).filter((sitzung) => !sitzung.aktuell);

  return (
    <section className="card stack" id="geraete" aria-labelledby="ger-titel">
      <h2 id="ger-titel" className="card-title">
        Geräte
      </h2>
      {liste === null && <span className="muted">Wird geladen …</span>}
      <ul className="list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
        {(liste ?? []).map((sitzung) => {
          const name = geraetName(sitzung.userAgent);
          return (
            <li key={sitzung.id} className="list-row" style={{ alignItems: 'flex-start' }}>
              <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>
                {geraetZeichen(sitzung.userAgent)}
              </span>
              <span style={{ flex: 1, minWidth: 0 }}>
                <span className="truncate" style={{ display: 'block', fontWeight: 600 }}>
                  {name}
                  {sitzung.aktuell && <span className="badge badge-accent"> Dieses Gerät</span>}
                </span>
                <span className="faint" style={{ display: 'block', fontSize: '0.78rem' }}>
                  Zuletzt aktiv {wann(sitzung.zuletztAktiv)} · angemeldet{' '}
                  {wann(sitzung.angemeldetAt)}
                </span>
                {frage === sitzung.id && (
                  <span
                    className="row"
                    style={{ gap: 'var(--space-2)', marginTop: 'var(--space-2)' }}
                  >
                    <button type="button" className="btn btn-sm" onClick={() => setFrage(null)}>
                      Abbrechen
                    </button>
                    <button
                      type="button"
                      className="btn btn-sm btn-danger"
                      disabled={busy}
                      autoFocus
                      onClick={() => void beenden(sitzung.id)}
                    >
                      Wirklich abmelden
                    </button>
                  </span>
                )}
              </span>
              {!sitzung.aktuell && frage !== sitzung.id && (
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={busy}
                  aria-label={`${name} abmelden`}
                  onClick={() => setFrage(sitzung.id)}
                >
                  Abmelden
                </button>
              )}
            </li>
          );
        })}
      </ul>
      {andere.length > 0 &&
        (frage === 'andere' ? (
          <div className="row" style={{ gap: 'var(--space-2)' }}>
            <button type="button" className="btn" onClick={() => setFrage(null)}>
              Abbrechen
            </button>
            <button
              type="button"
              className="btn btn-danger"
              style={{ flex: 1 }}
              disabled={busy}
              autoFocus
              onClick={() => void beenden('andere')}
            >
              {andere.length === 1
                ? 'Das andere Gerät abmelden'
                : `${andere.length} Geräte abmelden`}
            </button>
          </div>
        ) : (
          <button type="button" className="btn btn-block" onClick={() => setFrage('andere')}>
            Alle anderen Geräte abmelden
          </button>
        ))}
    </section>
  );
}
