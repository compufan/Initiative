import { useState } from 'react';
import { api } from '../../lib/api.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { absoluteUrl, copyText, webcalUrl } from './helpers.js';

/**
 * Subscription card for the personal ICS feed.
 *
 * The feed is authenticated by an unguessable token, so iOS, Android and
 * Outlook can subscribe without ever seeing a password.
 */
export function SubscribeCard() {
  const calendarToken = useSession((state) => state.user?.calendarToken ?? null);
  const [helpOpen, setHelpOpen] = useState(false);

  if (!calendarToken) return null;

  const feedPath = api.calendar.icsUrl(calendarToken);
  const url = absoluteUrl(feedPath);
  const webcal = webcalUrl(feedPath);

  async function copy() {
    if (await copyText(url)) toast('Link kopiert', 'success');
    else toast('Link konnte nicht kopiert werden', 'error');
  }

  return (
    <section className="card cal-subscribe" aria-label="Kalender abonnieren">
      <h2 className="cal-block-title">Kalender abonnieren</h2>
      <p className="cal-hint">
        Alle deine Termine landen automatisch in der Kalender-App auf deinem Handy – ohne dass du
        etwas doppelt eintragen musst.
      </p>

      <a className="btn btn-primary btn-block" href={webcal}>
        📆 In Kalender-App öffnen
      </a>
      <button type="button" className="btn btn-block" onClick={() => void copy()}>
        🔗 Link kopieren
      </button>

      <input
        className="input cal-url"
        value={url}
        readOnly
        aria-label="Adresse des Kalender-Abos"
        onFocus={(event) => event.target.select()}
      />

      <button
        type="button"
        className="btn btn-ghost btn-block"
        aria-expanded={helpOpen}
        onClick={() => setHelpOpen((open) => !open)}
      >
        {helpOpen ? 'Anleitung ausblenden' : 'So geht es Schritt für Schritt'}
      </button>

      {helpOpen && (
        <div className="cal-help">
          <h3 className="cal-help-title">iPhone &amp; iPad</h3>
          <p className="cal-hint">
            Einstellungen → Kalender → Accounts → Account hinzufügen → Andere → Kalenderabo
            hinzufügen. Dort den kopierten Link einfügen und mit „Weiter“ bestätigen.
          </p>
          <h3 className="cal-help-title">Android</h3>
          <p className="cal-hint">
            Google Kalender im Browser öffnen → links bei „Weitere Kalender“ auf „+“ → Über URL
            hinzufügen. Link einfügen, „Kalender hinzufügen“ – nach kurzer Zeit erscheinen die
            Termine auch in der Handy-App.
          </p>
        </div>
      )}
    </section>
  );
}
