import { useEffect, useId, useState } from 'react';
import {
  DEFAULT_PRIVACY,
  SICHTBARKEITEN,
  type PrivacySettings,
  type Sichtbarkeit,
  type UserDto,
} from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { useSession } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { Toggle } from './Toggle.js';
import { errorMessage, patchMe } from './helpers.js';

const SICHT_TEXT: Record<Sichtbarkeit, string> = {
  alle: 'Alle',
  kontakte: 'Kontakte',
  niemand: 'Niemand',
};

/** Die Privatsphäre mit Voreinstellungen für Konten, die nie etwas gewählt haben. */
export function privatsphaere(settings: { privacy?: Partial<PrivacySettings> } | undefined) {
  return { ...DEFAULT_PRIVACY, ...(settings?.privacy ?? {}) };
}

function SichtWahl({
  label,
  hinweis,
  wert,
  busy,
  onChange,
}: {
  label: string;
  hinweis: string;
  wert: Sichtbarkeit;
  busy: boolean;
  onChange: (wert: Sichtbarkeit) => void;
}) {
  const id = useId();
  return (
    <div className="stack" style={{ gap: 'var(--space-2)' }}>
      <span id={id} className="prf-toggle-label">
        {label}
      </span>
      <div className="msg-chip-row" role="radiogroup" aria-labelledby={id}>
        {SICHTBARKEITEN.map((stufe) => (
          <button
            key={stufe}
            type="button"
            role="radio"
            aria-checked={wert === stufe}
            className={`btn btn-sm ${wert === stufe ? 'btn-primary' : ''}`}
            disabled={busy}
            onClick={() => onChange(stufe)}
          >
            {SICHT_TEXT[stufe]}
          </button>
        ))}
      </div>
      <span className="prf-toggle-desc">{hinweis}</span>
    </div>
  );
}

/**
 * Privatsphäre: wer „zuletzt online“, „online“, Lesebestätigungen und die
 * Tipp-Anzeige sieht – und wen man blockiert hat.
 *
 * Gefiltert wird im Server (`services::privatsphaere`), nicht hier: Was
 * jemand nicht sehen soll, bekommt sein Gerät gar nicht erst.
 */
export function PrivatsphaereCard() {
  const user = useSession((state) => state.user);
  const p = privatsphaere(user?.settings);
  const [busy, setBusy] = useState(false);
  const [gesperrt, setGesperrt] = useState<UserDto[] | null>(null);

  useEffect(() => {
    let weg = false;
    verwaltung.sperren
      .liste()
      .then(({ items }) => {
        if (!weg) setGesperrt(items);
      })
      .catch(() => {
        if (!weg) setGesperrt([]);
      });
    return () => {
      weg = true;
    };
  }, []);

  async function speichern(teil: Partial<PrivacySettings>) {
    setBusy(true);
    try {
      await patchMe({ settings: { privacy: teil } });
      toast('Privatsphäre gespeichert', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function freigeben(person: UserDto) {
    setBusy(true);
    try {
      await verwaltung.sperren.freigeben(person.id);
      setGesperrt((alt) => (alt ?? []).filter((eintrag) => eintrag.id !== person.id));
      toast(`${person.displayName} freigegeben`, 'success');
    } catch (error) {
      toast(errorMessage(error, 'Freigeben fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="card stack" id="privatsphaere" aria-labelledby="prv-titel">
      <h2 id="prv-titel" className="card-title">
        Privatsphäre
      </h2>
      <p className="muted" style={{ margin: 0, fontSize: '0.85rem' }}>
        „Kontakte“ sind alle, mit denen du mindestens einen Chat teilst.
      </p>
      <SichtWahl
        label="Zuletzt online"
        hinweis="Wer sieht, wann du zuletzt in der App warst."
        wert={p.lastSeen}
        busy={busy}
        onChange={(wert) => void speichern({ lastSeen: wert })}
      />
      <SichtWahl
        label="Online-Status"
        hinweis="Wer den grünen Punkt sieht, während du die App offen hast."
        wert={p.online}
        busy={busy}
        onChange={(wert) => void speichern({ online: wert })}
      />
      <Toggle
        label="Lesebestätigungen"
        description="Gilt in Direktchats und gegenseitig: Wer sie ausschaltet, sieht auch die der anderen nicht. In Gruppen bleiben sie sichtbar."
        checked={p.readReceipts}
        busy={busy}
        onChange={(an) => void speichern({ readReceipts: an })}
      />
      <Toggle
        label="Tipp-Anzeige"
        description="Ob andere „schreibt …“ von dir sehen. Gegenseitig: aus heisst, du siehst es auch bei anderen nicht."
        checked={p.typing}
        busy={busy}
        onChange={(an) => void speichern({ typing: an })}
      />

      <h3 className="msg-info-label" style={{ margin: 'var(--space-2) 0 0' }}>
        Blockiert
      </h3>
      {gesperrt === null && <span className="muted">Wird geladen …</span>}
      {gesperrt?.length === 0 && (
        <span className="muted" style={{ fontSize: '0.85rem' }}>
          Niemand. Blockieren kannst du in der Chat-Info einer Person.
        </span>
      )}
      {gesperrt && gesperrt.length > 0 && (
        <ul className="list" style={{ margin: 0, padding: 0, listStyle: 'none' }}>
          {gesperrt.map((person) => (
            <li key={person.id} className="list-row">
              <Avatar name={person.displayName} id={person.id} url={person.avatarUrl} size={36} />
              <span className="truncate" style={{ flex: 1 }}>
                {person.displayName}
                <span className="faint" style={{ display: 'block', fontSize: '0.75rem' }}>
                  @{person.username}
                </span>
              </span>
              <button
                type="button"
                className="btn btn-sm"
                disabled={busy}
                aria-label={`${person.displayName} freigeben`}
                onClick={() => void freigeben(person)}
              >
                Freigeben
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
