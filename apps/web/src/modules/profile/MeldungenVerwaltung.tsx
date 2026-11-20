import { useEffect, useId, useState } from 'react';
import { MELDE_STATUS, type MeldeStatus, type MeldungDto } from '@initiative/shared';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { toast } from '../../state/ui.js';
import { errorMessage } from './helpers.js';

const STATUS_TEXT: Record<MeldeStatus, string> = {
  offen: 'Offen',
  in_bearbeitung: 'In Bearbeitung',
  erledigt: 'Erledigt',
  abgewiesen: 'Abgewiesen',
};

const GRUND_TEXT: Record<string, string> = {
  spam: 'Spam',
  belaestigung: 'Belästigung',
  unangemessen: 'Unangemessen',
  gewalt: 'Gewalt/Gefahr',
  sonstiges: 'Sonstiges',
};

/**
 * Meldungen in der Verwaltung: was gemeldet wurde, von wem, und was daraus
 * wurde. Die Verwaltung sieht den Auszug, den der Meldende sah – nicht den
 * Chat.
 */
export function MeldungenVerwaltung() {
  const [status, setStatus] = useState<MeldeStatus | ''>('offen');
  const [liste, setListe] = useState<MeldungDto[] | null>(null);
  const filterId = useId();

  useEffect(() => {
    let weg = false;
    setListe(null);
    verwaltung.sperren
      .meldungen(status || undefined)
      .then(({ items }) => {
        if (!weg) setListe(items);
      })
      .catch((error) => {
        if (!weg) {
          setListe([]);
          toast(errorMessage(error, 'Meldungen konnten nicht geladen werden'), 'error');
        }
      });
    return () => {
      weg = true;
    };
  }, [status]);

  function ersetzt(neu: MeldungDto) {
    setListe((alt) =>
      (alt ?? [])
        .map((eintrag) => (eintrag.id === neu.id ? neu : eintrag))
        .filter((eintrag) => !status || eintrag.status === status),
    );
  }

  return (
    <section className="card stack" aria-labelledby="adm-meldungen-titel">
      <h2 id="adm-meldungen-titel" className="card-title">
        Meldungen
      </h2>
      <div className="field">
        <label htmlFor={filterId}>Zeigen</label>
        <select
          id={filterId}
          className="select"
          value={status}
          onChange={(event) => setStatus(event.target.value as MeldeStatus | '')}
        >
          <option value="">Alle</option>
          {MELDE_STATUS.map((wert) => (
            <option key={wert} value={wert}>
              {STATUS_TEXT[wert]}
            </option>
          ))}
        </select>
      </div>
      {liste === null && <span className="muted">Wird geladen …</span>}
      {liste?.length === 0 && <span className="muted">Keine Meldungen.</span>}
      {liste?.map((meldung) => (
        <MeldungZeile key={meldung.id} meldung={meldung} onGeaendert={ersetzt} />
      ))}
    </section>
  );
}

function MeldungZeile({
  meldung,
  onGeaendert,
}: {
  meldung: MeldungDto;
  onGeaendert: (meldung: MeldungDto) => void;
}) {
  const [notiz, setNotiz] = useState(meldung.notiz ?? '');
  const [busy, setBusy] = useState(false);
  const notizId = useId();
  const statusId = useId();

  async function speichern(teil: { status?: MeldeStatus; notiz?: string }) {
    setBusy(true);
    try {
      onGeaendert(await verwaltung.sperren.meldungBearbeiten(meldung.id, teil));
      toast('Meldung gespeichert', 'success');
    } catch (error) {
      toast(errorMessage(error, 'Speichern fehlgeschlagen'), 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <article
      className="stack"
      style={{ borderTop: '1px solid var(--border)', paddingTop: 'var(--space-3)' }}
    >
      <strong>
        {GRUND_TEXT[meldung.grund] ?? meldung.grund}:{' '}
        {meldung.targetName
          ? `${meldung.targetName} (@${meldung.targetUsername})`
          : 'gelöschtes Konto'}
      </strong>
      <span className="faint" style={{ fontSize: '0.78rem' }}>
        gemeldet von {meldung.reporterName ?? 'gelöschtem Konto'} am{' '}
        {new Date(meldung.createdAt).toLocaleString('de-DE', {
          dateStyle: 'medium',
          timeStyle: 'short',
        })}
        {meldung.messageId ? ' · betrifft eine Nachricht' : ''}
      </span>
      {meldung.nachrichtAuszug && (
        <blockquote
          style={{
            margin: 0,
            paddingLeft: 'var(--space-3)',
            borderLeft: '3px solid var(--border)',
          }}
        >
          {meldung.nachrichtAuszug}
        </blockquote>
      )}
      {meldung.freitext && <p style={{ margin: 0 }}>„{meldung.freitext}“</p>}
      <div className="field">
        <label htmlFor={statusId}>Status</label>
        <select
          id={statusId}
          className="select"
          value={meldung.status}
          disabled={busy}
          onChange={(event) => void speichern({ status: event.target.value as MeldeStatus })}
        >
          {MELDE_STATUS.map((wert) => (
            <option key={wert} value={wert}>
              {STATUS_TEXT[wert]}
            </option>
          ))}
        </select>
      </div>
      <form
        className="row"
        style={{ gap: 'var(--space-2)', alignItems: 'flex-end' }}
        onSubmit={(event) => {
          event.preventDefault();
          void speichern({ notiz });
        }}
      >
        <div className="field" style={{ flex: 1 }}>
          <label htmlFor={notizId}>Notiz der Verwaltung</label>
          <input
            id={notizId}
            className="input"
            maxLength={1000}
            value={notiz}
            onChange={(event) => setNotiz(event.target.value)}
          />
        </div>
        <button type="submit" className="btn" disabled={busy}>
          Speichern
        </button>
      </form>
    </article>
  );
}
