import { useState } from 'react';
import { api, type StorageCheck } from '../../lib/api.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from './helpers.js';

/**
 * Prüfung der kalten Ablage (Storage Box) – nur im Verwaltungsbereich.
 *
 * Zwei Knöpfe, zwei Fragen:
 *
 *   * **Box prüfen (64 MiB)**: Geht eine grosse Datei hin und zurück, und wie
 *     schnell? Schreibt, misst, liest Bereiche, löscht (`/admin/storage-check/kalt`).
 *   * **Konsistenz prüfen**: Stimmen Datenbank und Box überein? Liest nur
 *     Verzeichnisse und eine kleine Stichprobe (`/admin/storage-check/konsistenz`).
 *
 * Beide Läufe dauern (Sekunden bis Minuten); die Anzeige zeigt deshalb, dass
 * etwas läuft, und danach die Zeit, die Rate (steht im Detail der Schritte)
 * und die Befunde.
 */
type Lauf = 'box' | 'konsistenz' | null;

interface Ergebnis {
  art: 'box' | 'konsistenz';
  daten: StorageCheck;
  dauerMs: number;
}

export function KaltablageCheck() {
  const [lauf, setLauf] = useState<Lauf>(null);
  const [ergebnis, setErgebnis] = useState<Ergebnis | null>(null);

  async function starten(art: 'box' | 'konsistenz') {
    setLauf(art);
    setErgebnis(null);
    const start = performance.now();
    try {
      const daten = art === 'box' ? await api.admin.kaltCheck(64) : await api.admin.konsistenzCheck();
      setErgebnis({ art, daten, dauerMs: Math.round(performance.now() - start) });
    } catch (error) {
      toast(errorMessage(error, 'Prüfung fehlgeschlagen'), 'error');
    } finally {
      setLauf(null);
    }
  }

  const alleOk = ergebnis?.daten.steps.every((s) => s.ok) ?? false;

  return (
    <section className="card stack" aria-labelledby="adm-kalt-title">
      <h2 className="prf-block-title" id="adm-kalt-title">
        Kalte Ablage (Storage Box)
      </h2>
      <p className="prf-hint">
        „Box prüfen“ schreibt eine Datei von 64 MiB auf die Box, liest sie zurück und löscht sie –
        mit Zeit und Übertragungsrate. „Konsistenz prüfen“ vergleicht die Datenbank mit dem, was auf
        der Box liegt (fehlend, verwaist, falsche Grösse) und liest eine kleine Stichprobe ganz.
      </p>
      <div className="row" style={{ gap: 8, flexWrap: 'wrap' }}>
        <button
          type="button"
          className="btn"
          disabled={lauf !== null}
          onClick={() => void starten('box')}
        >
          {lauf === 'box' ? 'Box wird geprüft …' : 'Box prüfen (64 MiB)'}
        </button>
        <button
          type="button"
          className="btn"
          disabled={lauf !== null}
          onClick={() => void starten('konsistenz')}
        >
          {lauf === 'konsistenz' ? 'Wird verglichen …' : 'Konsistenz prüfen'}
        </button>
      </div>
      {lauf && (
        <p className="prf-hint" role="status">
          Das kann einige Minuten dauern – die Seite bitte offen lassen.
        </p>
      )}

      {ergebnis && (
        <div className="stack" style={{ gap: 10 }} data-testid="kalt-ergebnis">
          <div className={alleOk ? 'prf-note is-ok' : 'prf-note'}>
            <strong>{ergebnis.daten.verdict}</strong>
          </div>
          <p className="prf-hint" style={{ margin: 0 }}>
            {ergebnis.art === 'box' ? 'Box-Probe' : 'Konsistenz'} · Treiber:{' '}
            <code>{ergebnis.daten.driver}</code>
            {ergebnis.daten.endpoint && (
              <>
                {' · '}Box: <code>{ergebnis.daten.endpoint}</code>
              </>
            )}
            {' · '}Gesamtdauer {(ergebnis.dauerMs / 1000).toFixed(1)} s
          </p>
          <ul className="stack" style={{ margin: 0, padding: 0, listStyle: 'none', gap: 10 }}>
            {ergebnis.daten.steps.map((step) => (
              <li key={step.name} className="stack" style={{ gap: 2 }}>
                <strong>
                  {step.ok ? '✓' : '✗'} {step.name}
                </strong>
                <span className="prf-hint">{step.detail}</span>
                {step.hint && (
                  <span className="prf-hint" style={{ fontWeight: 600 }}>
                    → {step.hint}
                  </span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </section>
  );
}
