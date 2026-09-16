import { useEffect, useState } from 'react';
import { herunterladen } from '../../lib/herunterladen.js';
import { Sheet } from '../../components/Sheet.js';
import { api, API_BASE } from '../../lib/api.js';
import { castErlaubt, castErlauben, castGrund } from '../fernseher/cast.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { Toggle } from './Toggle.js';

/**
 * Deine Daten – ansehen, mitnehmen, löschen.
 *
 * Drei Rechte, die jedem zustehen und die eine App nicht auf Zuruf erfüllen
 * sollte, sondern mit einem Knopf: Auskunft (Art. 15), Mitnahme (Art. 20) und
 * Löschung (Art. 17). Wer dafür jemanden bitten muss, hat sie praktisch nicht.
 */
export function PrivacyCard() {
  const [laedt, setLaedt] = useState(false);
  const [loeschen, setLoeschen] = useState(false);

  async function exportieren() {
    setLaedt(true);
    try {
      const daten = await api.users.export();
      const blob = new Blob([JSON.stringify(daten, null, 2)], { type: 'application/json' });
      await herunterladen(
        blob,
        `initiative-meine-daten-${new Date().toISOString().slice(0, 10)}.json`,
      );
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Export fehlgeschlagen', 'error');
    } finally {
      setLaedt(false);
    }
  }

  return (
    <section className="card stack" id="datenschutz" aria-labelledby="privacy-title">
      <h2 id="privacy-title" className="card-title">
        Deine Daten
      </h2>

      <p className="muted" style={{ margin: 0, fontSize: '0.88rem' }}>
        Diese App sammelt nichts über dich, was sie nicht zum Funktionieren braucht. Keine Werbung,
        keine Analyse, keine fremden Dienste im Hintergrund.
      </p>

      <CastSchalter />

      <a
        className="btn btn-block"
        href={`${API_BASE}/datenschutz`}
        target="_blank"
        rel="noreferrer"
      >
        Datenschutzerklärung lesen
      </a>

      <a className="btn btn-block" href={`${API_BASE}/impressum`} target="_blank" rel="noreferrer">
        Impressum
      </a>

      <button
        type="button"
        className="btn btn-block"
        disabled={laedt}
        onClick={() => void exportieren()}
      >
        {laedt ? 'Wird zusammengestellt …' : 'Meine Daten herunterladen'}
      </button>

      <button type="button" className="btn btn-block btn-danger" onClick={() => setLoeschen(true)}>
        Konto löschen
      </button>

      <LoeschSheet open={loeschen} onClose={() => setLoeschen(false)} />
    </section>
  );
}

/**
 * Der Widerruf für die eine Einwilligung, die diese App überhaupt einholt.
 *
 * Es gibt genau ein fremdes Skript in dieser App: `cast_sender.js` von Google,
 * für das Streamen auf einen Chromecast. Es wird erst geholt, wenn jemand
 * ausdrücklich zustimmt – und eine Einwilligung, die sich nicht so leicht
 * zurücknehmen lässt, wie sie gegeben wurde, ist nach Art. 7 Abs. 3 DSGVO
 * keine. Der Schalter ist also keine Bequemlichkeit, sondern die zweite Hälfte
 * der Abfrage.
 *
 * Das schon geladene Skript geht damit nicht weg – dafür braucht es ein
 * Neuladen der Seite, und das steht auch da. Was sofort geht: Ab jetzt wird es
 * nicht mehr geholt, und der Cast-Knopf kommt zurück in seinen
 * Ausgangszustand.
 */
function CastSchalter() {
  const [an, setAn] = useState(castErlaubt);
  // Wo Cast gar nicht geht, gibt es auch nichts zu widerrufen – und ein
  // Schalter für etwas, das dieses Gerät nicht kann, ist nur eine Frage mehr.
  if (castGrund() !== 'geht' && !an) return null;

  return (
    <Toggle
      label="Streamen über Google (Chromecast)"
      description={
        an
          ? 'Eingeschaltet. Beim Streamen lädt der Browser ein Skript von gstatic.com; Google erfährt dabei deine IP-Adresse.'
          : 'Aus. Die App lädt nichts von fremden Servern. Zum Streamen auf einen Chromecast braucht es ein Skript von Google – du wirst vorher gefragt.'
      }
      checked={an}
      onChange={(neu) => {
        castErlauben(neu);
        setAn(neu);
        toast(
          neu
            ? 'Streamen über Google eingeschaltet.'
            : 'Aus. Eine laufende Verbindung zum Fernseher ist getrennt; beim nächsten Laden der Seite ist auch das Skript wieder weg.',
          'success',
        );
      }}
    />
  );
}

function LoeschSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [passwort, setPasswort] = useState('');
  const [busy, setBusy] = useState(false);

  /*
   * Das Passwort bleibt nicht liegen.
   *
   * `Sheet` hängt nur seine Kinder ab, die Komponente selbst bleibt stehen –
   * und `onClose` setzte allein `loeschen` auf false. Wer das eingetippte
   * Passwort sah, es sich anders überlegte und zumachte, kam beim nächsten
   * Öffnen zu einem Blatt zurück, in dem „Endgültig löschen“ sofort scharf
   * war. Ein Blatt, das nur einen Tipp von der Kontolöschung entfernt ist,
   * darf so nicht aufgehen.
   */
  useEffect(() => {
    if (!open) setPasswort('');
  }, [open]);

  async function ausfuehren() {
    setBusy(true);
    try {
      await api.users.remove(passwort);
      // Abmelden räumt auch den lokalen Speicher, den Zwischenspeicher und
      // das Push-Abo – sonst bliebe auf dem Gerät liegen, was gerade auf dem
      // Server verschwunden ist.
      await useSession.getState().logout();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen', 'error');
      setBusy(false);
    }
  }

  return (
    <Sheet open={open} onClose={onClose} title="Konto löschen" variant="modal">
      <div className="stack">
        <p style={{ margin: 0 }}>
          Dein Konto, deine Ausgaben, deine Termine und deine Sticker werden gelöscht. Das lässt
          sich nicht rückgängig machen.
        </p>
        <p className="muted" style={{ margin: 0, fontSize: '0.86rem' }}>
          Was du in Chats geschrieben hast, bleibt bei den anderen stehen – nur ohne deinen Namen.
          Sonst rissen deine Nachrichten Löcher in fremde Gespräche. Wenn du auch deine Texte
          entfernt haben willst, lösche sie vorher im Chat („Für alle löschen“).
        </p>
        <div className="field">
          <label htmlFor="del-pass">Zur Sicherheit dein Passwort</label>
          <input
            id="del-pass"
            className="input"
            type="password"
            autoComplete="current-password"
            value={passwort}
            onChange={(änderung) => setPasswort(änderung.target.value)}
          />
        </div>
        <button
          type="button"
          className="btn btn-danger btn-block"
          disabled={busy || passwort.length === 0}
          onClick={() => void ausfuehren()}
        >
          {busy ? 'Wird gelöscht …' : 'Endgültig löschen'}
        </button>
      </div>
    </Sheet>
  );
}
