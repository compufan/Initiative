import { useId, useState } from 'react';
import {
  ORDNER_MAX,
  ORDNER_NAME_MAX,
  type ChatOrdnerDto,
  type ConversationDto,
} from '@initiative/shared';
import { Avatar } from '../../components/Avatar.js';
import { Sheet } from '../../components/Sheet.js';
import { verwaltung } from '../../lib/verwaltungApi.js';
import { useMyId } from '../../state/session.js';
import { toast } from '../../state/ui.js';
import { sortieren } from './chatliste.js';
import { conversationAvatar, conversationTitle } from './helpers.js';

interface OrdnerSheetProps {
  /** `null`: einen neuen anlegen. */
  ordner: ChatOrdnerDto | null;
  chats: ConversationDto[];
  /** Wie viele es schon gibt – für die Grenze. */
  anzahl: number;
  onClose: () => void;
  onGespeichert: (ordner: ChatOrdnerDto) => void;
  onGeloescht: (id: string) => void;
}

/**
 * Ein eigener Ordner der Chatliste: Name und die Chats darin.
 *
 * Wie bei Telegram ein Filter über derselben Liste, kein Umzug: Ein Chat kann
 * in mehreren Ordnern stehen und bleibt unter „Alle“.
 */
export function OrdnerSheet({
  ordner,
  chats,
  anzahl,
  onClose,
  onGespeichert,
  onGeloescht,
}: OrdnerSheetProps) {
  const myId = useMyId();
  const nameId = useId();
  const [name, setName] = useState(ordner?.name ?? '');
  const [gewaehlt, setGewaehlt] = useState<Set<string>>(new Set(ordner?.chats ?? []));
  const [busy, setBusy] = useState(false);
  const [loeschenFragen, setLoeschenFragen] = useState(false);
  const voll = !ordner && anzahl >= ORDNER_MAX;
  const sauber = name.trim();

  function umschalten(id: string) {
    setGewaehlt((alt) => {
      const neu = new Set(alt);
      if (neu.has(id)) neu.delete(id);
      else neu.add(id);
      return neu;
    });
  }

  async function speichern() {
    if (!sauber) return;
    setBusy(true);
    try {
      const auswahl = [...gewaehlt];
      const neu = ordner
        ? await verwaltung.liste.ordnerAendern(ordner.id, { name: sauber, chats: auswahl })
        : await verwaltung.liste.ordnerAnlegen({ name: sauber, chats: auswahl });
      onGespeichert(neu);
      toast(ordner ? 'Ordner gespeichert' : 'Ordner angelegt', 'success');
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Speichern fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  async function loeschen() {
    if (!ordner) return;
    setBusy(true);
    try {
      await verwaltung.liste.ordnerLoeschen(ordner.id);
      onGeloescht(ordner.id);
      toast('Ordner gelöscht – die Chats bleiben', 'success');
      onClose();
    } catch (error) {
      toast(error instanceof Error ? error.message : 'Löschen fehlgeschlagen', 'error');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Sheet open onClose={onClose} title={ordner ? 'Ordner bearbeiten' : 'Neuer Ordner'}>
      <form
        className="stack"
        onSubmit={(event) => {
          event.preventDefault();
          void speichern();
        }}
      >
        {voll ? (
          <p className="muted" style={{ margin: 0 }}>
            Du hast schon {ORDNER_MAX} Ordner – mehr gehen nicht. Lösch einen, um Platz zu machen.
          </p>
        ) : (
          <>
            <div className="field">
              <label htmlFor={nameId}>Name</label>
              <input
                id={nameId}
                className="input"
                value={name}
                maxLength={ORDNER_NAME_MAX}
                autoFocus
                placeholder="z. B. Arbeit"
                onChange={(event) => setName(event.target.value)}
              />
            </div>
            <fieldset className="ordner-chats">
              <legend className="msg-info-label">Chats in diesem Ordner</legend>
              <div className="list msg-picker-list">
                {sortieren(chats).map((chat) => {
                  const bild = conversationAvatar(chat, myId);
                  const titel = conversationTitle(chat, myId);
                  return (
                    <label key={chat.id} className="list-row ordner-chat">
                      <input
                        type="checkbox"
                        checked={gewaehlt.has(chat.id)}
                        onChange={() => umschalten(chat.id)}
                      />
                      <Avatar name={bild.name} id={bild.id} url={bild.url} size={32} />
                      <span className="truncate" style={{ flex: 1 }}>
                        {titel}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>
            <button type="submit" className="btn btn-primary btn-block" disabled={busy || !sauber}>
              {ordner ? 'Speichern' : `Ordner anlegen${gewaehlt.size ? ` (${gewaehlt.size})` : ''}`}
            </button>
          </>
        )}
        {ordner &&
          (loeschenFragen ? (
            <div className="row" style={{ gap: 'var(--space-2)' }}>
              <button type="button" className="btn" onClick={() => setLoeschenFragen(false)}>
                Abbrechen
              </button>
              <button
                type="button"
                className="btn btn-danger"
                style={{ flex: 1 }}
                disabled={busy}
                onClick={() => void loeschen()}
              >
                Ordner wirklich löschen
              </button>
            </div>
          ) : (
            <button
              type="button"
              className="btn btn-ghost btn-block"
              onClick={() => setLoeschenFragen(true)}
            >
              Ordner löschen
            </button>
          ))}
      </form>
    </Sheet>
  );
}
