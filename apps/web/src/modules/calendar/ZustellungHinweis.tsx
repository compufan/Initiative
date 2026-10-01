import { useCallback, useEffect, useState } from 'react';
import { api } from '../../lib/api.js';
import { toast } from '../../state/ui.js';

/**
 * Meldet dem Ersteller, wenn Einladungen nicht zugestellt werden konnten, und
 * lässt sie erneut zustellen.
 *
 * Das Anlegen läuft in zwei Schritten: Erst werden Termin, Eingeladene und die
 * Plätze der Karten gespeichert, dann die Nachrichten verschickt. Bricht der
 * zweite Schritt bei einigen ab, bleibt der Termin gültig – der Server merkt
 * sich, welche Karten noch fehlen. Das hier macht das sichtbar, und zwar
 * **dauerhaft**: Ein Hinweis, der nur beim Speichern aufblitzt, ist beim
 * nächsten Öffnen vergessen, die Einladung aber weiter nicht angekommen.
 */
export function ZustellungHinweis({
  eventId,
  antwort,
  stand,
}: {
  eventId: string;
  /**
   * Was die Seite aus einer Antwort des Servers schon weiß (Einladen, Ausladen,
   * Speichern): Die Antwort nennt `zustellung.ausstehend`, und es wäre falsch, bis
   * zum nächsten Laden zu warten. Jede Antwort ist ein neues Objekt – auch zweimal
   * dieselbe Zahl muss sich melden, etwa nach „Erneut zustellen“.
   */
  antwort?: { ausstehend: number } | null;
  /** Der Stand des Termins – ändert er sich, wird neu nachgesehen (auch von einem anderen Gerät aus). */
  stand?: number;
}) {
  const [ausstehend, setAusstehend] = useState(0);
  const [laeuft, setLaeuft] = useState(false);

  const laden = useCallback(async () => {
    try {
      setAusstehend((await api.calendar.zustellung(eventId)).ausstehend);
    } catch {
      // Ohne Auskunft gibt es nichts zu melden – der Hinweis ist ein Zusatz.
      setAusstehend(0);
    }
  }, [eventId]);

  useEffect(() => {
    void laden();
  }, [laden, stand]);

  // Eine Antwort des Servers geht dem Laden vor.
  useEffect(() => {
    if (antwort) setAusstehend(antwort.ausstehend);
  }, [antwort]);

  async function nachliefern() {
    setLaeuft(true);
    try {
      const antwort = await api.calendar.nachliefern(eventId);
      const noch = antwort.zustellung?.ausstehend ?? 0;
      toast(
        noch === 0
          ? 'Alle Einladungen sind zugestellt.'
          : `${noch} ${noch === 1 ? 'Einladung konnte' : 'Einladungen konnten'} noch nicht zugestellt werden.`,
        noch === 0 ? 'success' : 'error',
      );
      setAusstehend(noch);
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Zustellen fehlgeschlagen', 'error');
    } finally {
      setLaeuft(false);
    }
  }

  if (ausstehend === 0) return null;
  return (
    <section className="card cal-block cal-zustellung" role="alert">
      <h2 className="cal-block-title">Einladungen nicht zugestellt</h2>
      <p className="cal-hint">
        {ausstehend === 1
          ? 'Eine Einladung ist noch nicht im Chat angekommen.'
          : `${ausstehend} Einladungen sind noch nicht im Chat angekommen.`}{' '}
        Der Termin selbst ist gespeichert.
      </p>
      <button
        type="button"
        className="btn btn-block"
        disabled={laeuft}
        onClick={() => void nachliefern()}
      >
        {laeuft ? 'Wird zugestellt …' : 'Erneut zustellen'}
      </button>
    </section>
  );
}
